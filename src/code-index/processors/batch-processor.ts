import { IEmbedder, IVectorStore, PointStruct, FileProcessingResult } from "../interfaces"
import { CacheManager } from "../cache-manager"
import {
	BATCH_SEGMENT_THRESHOLD,
	MAX_BATCH_RETRIES,
	INITIAL_RETRY_DELAY_MS,
	getBatchSizeForEmbedder
} from "../constants"

export interface BatchProcessingResult {
	processed: number
	failed: number
	errors: Error[]
	processedFiles: FileProcessingResult[]
}

export interface BatchProcessorOptions<T> {
	embedder: IEmbedder
	vectorStore: IVectorStore
	cacheManager: CacheManager

	// Strategy functions for converting input data
	itemToText: (item: T) => string
	itemToPoint: (item: T, embedding: number[], index: number) => PointStruct
	itemToFilePath: (item: T) => string
	getFileHash?: (item: T) => string

	// Optional callbacks
	onProgress?: (processed: number, total: number, currentItem?: string) => void
	onError?: (error: Error) => void

	// Optional file deletion logic
	getFilesToDelete?: (items: T[]) => string[]
	// Optional path conversion for cache deletion (relative -> absolute)
	relativeCachePathToAbsolute?: (relativePath: string) => string
}

/**
 * Generic batch processor for handling common batch operations:
 * - File deletion from vector store
 * - Embedding generation
 * - Vector store upserts
 * - Cache updates
 * - Retry logic
 */
export class BatchProcessor<T> {

	async processBatch(
		items: T[],
		options: BatchProcessorOptions<T>
	): Promise<BatchProcessingResult> {
		// console.log(`[BatchProcessor] Starting batch processing for ${items.length} items`)

		const result: BatchProcessingResult = { processed: 0, failed: 0, errors: [], processedFiles: [] }

		// Report initial progress
		options.onProgress?.(0, items.length)

		try {
			// Phase 1: Handle deletions if needed (even if items is empty)
			if (options.getFilesToDelete) {
				const filesToDelete = options.getFilesToDelete(items)
				if (filesToDelete.length > 0) {
					console.log(`[BatchProcessor] Files to delete: ${filesToDelete.length}`, filesToDelete)
					await this.handleDeletions(filesToDelete, options, result)
				}
			}

			// Phase 2: Process items in batches (only if there are items to process)
			if (items.length > 0) {
				await this.processItemsInBatches(items, options, result)
			}

			return result
		} catch (error) {
			const err = error as Error
			result.errors.push(err)
			options.onError?.(err)
			return result
		}
	}

	private async handleDeletions<T>(
		filesToDelete: string[],
		options: BatchProcessorOptions<T>,
		result: BatchProcessingResult
	): Promise<void> {
		try {
			await options.vectorStore.deletePointsByMultipleFilePaths(filesToDelete)

			// Clear cache for deleted files and record successful deletions
			for (const filePath of filesToDelete) {
				// Convert relative path to absolute path for cache deletion if converter is provided
				const cacheFilePath = options.relativeCachePathToAbsolute ?
					options.relativeCachePathToAbsolute(filePath) : filePath
				options.cacheManager.deleteHash(cacheFilePath)
				result.processedFiles.push({
					path: filePath,
					status: "success"
				})
			}
		} catch (error) {
			const err = error as Error
			result.errors.push(err)
			options.onError?.(err)

			// Record failed deletions
			for (const filePath of filesToDelete) {
				result.processedFiles.push({
					path: filePath,
					status: "error",
					error: err
				})
			}
			throw err
		}
	}

	private async processItemsInBatches<T>(
		items: T[],
		options: BatchProcessorOptions<T>,
		result: BatchProcessingResult
	): Promise<void> {
		// Get dynamic batch size based on embedder instance
		const batchSize = getBatchSizeForEmbedder(options.embedder)

		// console.log(`[BatchProcessor] Using batch size ${batchSize} for embedder: ${options.embedder.embedderInfo.name}`)

		// Process items in segments to avoid memory issues and respect batch limits
		for (let i = 0; i < items.length; i += batchSize) {
			const batchItems = items.slice(i, i + batchSize)
			await this.processSingleBatch(batchItems, options, result, i)
		}
	}

	private async processSingleBatch<T>(
		batchItems: T[],
		options: BatchProcessorOptions<T>,
		result: BatchProcessingResult,
		startIndex: number
	): Promise<void> {
		let attempts = 0
		let success = false
		let lastError: Error | null = null

		while (attempts < MAX_BATCH_RETRIES && !success) {
			attempts++

			try {
				// Extract texts for embedding
				const texts = batchItems.map(item => options.itemToText(item))

				// Create embeddings
				const { embeddings } = await options.embedder.createEmbeddings(texts)

				// Convert to points
				const points = batchItems.map((item, index) =>
					options.itemToPoint(item, embeddings[index], startIndex + index)
				)

				// Upsert to vector store
				await options.vectorStore.upsertPoints(points)

				// Update cache for successfully processed items
				for (const item of batchItems) {
					const filePath = options.itemToFilePath(item)
					const fileHash = options.getFileHash?.(item)
					if (fileHash) {
						options.cacheManager.updateHash(filePath, fileHash)
					}

					result.processed++
					result.processedFiles.push({
						path: filePath,
						status: "success",
						newHash: fileHash
					})
					options.onProgress?.(result.processed, result.processed + result.failed, filePath)
				}

				success = true
			} catch (error) {
				lastError = error as Error
				console.error(`[BatchProcessor] Error processing batch (attempt ${attempts}):`, error)

				if (attempts < MAX_BATCH_RETRIES) {
					const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempts - 1)
					await new Promise(resolve => setTimeout(resolve, delay))
				}
			}
		}

		if (!success && lastError) {
			result.failed += batchItems.length
			result.errors.push(lastError)

			const errorMessage = `Failed to process batch after ${MAX_BATCH_RETRIES} attempts: ${lastError.message}`
			const batchError = new Error(errorMessage)
			result.errors.push(batchError)
			options.onError?.(batchError)

			// Record failed items and still report progress
			for (const item of batchItems) {
				const filePath = options.itemToFilePath(item)
				result.processedFiles.push({
					path: filePath,
					status: "error",
					error: lastError
				})
				options.onProgress?.(result.processed, result.processed + result.failed, filePath)
			}
		}
	}
}
