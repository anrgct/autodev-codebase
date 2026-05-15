import { IEmbedder, IVectorStore, PointStruct, FileProcessingResult } from "../interfaces"
import { CacheManager } from "../cache-manager"
import {
	BATCH_SEGMENT_THRESHOLD,
	MAX_BATCH_RETRIES,
	INITIAL_RETRY_DELAY_MS,
	getBatchSizeForEmbedder,
	TRUNCATION_INITIAL_THRESHOLD,
	TRUNCATION_REDUCTION_FACTOR,
	MIN_TRUNCATION_THRESHOLD,
	MAX_TRUNCATION_ATTEMPTS,
	INDIVIDUAL_PROCESSING_TIMEOUT_MS,
	ENABLE_TRUNCATION_FALLBACK,
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
	/** Called when items are successfully indexed, with the count of indexed items */
	onItemIndexed?: (count: number) => void

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
 * - Retry logic with truncation fallback for oversized content
 */
export class BatchProcessor<T> {

	/**
	 * Determines if an error is recoverable (e.g., context length exceeded)
	 * Only these types of errors will trigger the truncation fallback
	 */
	private _isRecoverableError(error: Error): boolean {
		const msg = error.message.toLowerCase()
		return (
			msg.includes("context length") ||
			msg.includes("exceeds") ||
			msg.includes("too long") ||
			msg.includes("input length") ||
			msg.includes("invalid input") ||
			msg.includes("token limit") ||
			msg.includes("failed to get embeddings")
		)
	}

	/**
	 * Truncates text by lines to maintain code integrity
	 * Does not add language-specific truncation markers to avoid syntax compatibility issues
	 */
	private _truncateTextByLines(
		text: string,
		maxChars: number
	): string {
		if (text.length <= maxChars) {
			return text
		}

		const lines = text.split('\n')
		const result: string[] = []
		let currentLength = 0

		for (const line of lines) {
			const lineWithNewline = line.length + 1
			// Stop if adding this line would exceed the limit and we already have content
			if (currentLength + lineWithNewline > maxChars && result.length > 0) {
				break
			}
			result.push(line)
			currentLength += lineWithNewline
		}

		// Preserve at least part of the first line if nothing else was kept
		if (result.length === 0 && lines.length > 0) {
			result.push(lines[0].substring(0, maxChars))
		}

		return result.join('\n')
	}

	/**
	 * Processes a single item with truncation retry logic
	 * Uses the smaller of original text length and initial threshold as starting point
	 * Recursively reduces threshold until success or minimum reached
	 */
	private async _processItemWithTruncation<T>(
		item: T,
		options: BatchProcessorOptions<T>,
		result: BatchProcessingResult,
		itemIndex: number
	): Promise<boolean> {
		const originalText = options.itemToText(item)
		const filePath = options.itemToFilePath(item)

		// Use the smaller of original text length and initial threshold
		let threshold = Math.min(originalText.length, TRUNCATION_INITIAL_THRESHOLD)

		// If original text is already short, this might be a different error - skip truncation
		if (originalText.length <= MIN_TRUNCATION_THRESHOLD) {
			console.warn(
				`[BatchProcessor] Original text is already short (${originalText.length} chars), ` +
				`skipping truncation for: ${filePath}`
			)
			return false
		}

		for (let attempt = 0; attempt < MAX_TRUNCATION_ATTEMPTS; attempt++) {
			try {
				const textToEmbed = this._truncateTextByLines(originalText, threshold)

				// Skip if truncated text is too short
				if (textToEmbed.length < MIN_TRUNCATION_THRESHOLD) {
					console.warn(
						`[BatchProcessor] Text too short after truncation ` +
						`(${textToEmbed.length} chars < ${MIN_TRUNCATION_THRESHOLD}), skipping: ${filePath}`
					)
					return false
				}

				// Try to generate embedding
				const { embeddings } = await options.embedder.createEmbeddings([textToEmbed])

				// Use correct itemIndex for unique point ID
				const point = options.itemToPoint(item, embeddings[0], itemIndex)
				await options.vectorStore.upsertPoints([point])

				const wasTruncated = textToEmbed.length < originalText.length

				if (wasTruncated) {
					console.info(
						`[BatchProcessor] Successfully indexed truncated content: ` +
						`${filePath} (${textToEmbed.length}/${originalText.length} chars, ` +
						`${(textToEmbed.length / originalText.length * 100).toFixed(1)}%)`
					)
				}

				// Update cache (store original file hash)
				const fileHash = options.getFileHash?.(item)
				if (fileHash) {
					options.cacheManager.updateHash(filePath, fileHash)
				}

				result.processed++
				result.processedFiles.push({
					path: filePath,
					status: "success",
					newHash: fileHash,
					truncated: wasTruncated
				})

				options.onProgress?.(result.processed, result.processed + result.failed, filePath)
				options.onItemIndexed?.(1)

				return true

			} catch (error) {
				const nextThreshold = Math.floor(threshold * TRUNCATION_REDUCTION_FACTOR)

				// Stop retrying if below minimum threshold
				if (nextThreshold < MIN_TRUNCATION_THRESHOLD) {
					console.warn(
						`[BatchProcessor] Truncation attempt ${attempt + 1} failed, ` +
						`next threshold ${nextThreshold} below minimum ${MIN_TRUNCATION_THRESHOLD}, giving up`
					)
					break
				}

				console.warn(
					`[BatchProcessor] Truncation attempt ${attempt + 1} failed at ${threshold} chars, ` +
					`will try ${nextThreshold} chars. Error: ${(error as Error).message}`
				)
				threshold = nextThreshold
			}
		}

		// All attempts failed
		console.error(`[BatchProcessor] All truncation attempts failed for: ${filePath}`)
		return false
	}

	/**
	 * Fallback to individual item processing with timeout protection
	 */
	private async _processItemsIndividually<T>(
		batchItems: T[],
		options: BatchProcessorOptions<T>,
		result: BatchProcessingResult,
		startIndex: number
	): Promise<void> {
		// Boundary check
		if (!batchItems || batchItems.length === 0) {
			return
		}

		console.log(`[BatchProcessor] Falling back to individual processing for ${batchItems.length} items`)

		const startTime = Date.now()
		let successCount = 0
		let failureCount = 0

		for (let i = 0; i < batchItems.length; i++) {
			// Timeout protection
			if (Date.now() - startTime > INDIVIDUAL_PROCESSING_TIMEOUT_MS) {
				console.warn(
					`[BatchProcessor] Individual processing timeout after ${INDIVIDUAL_PROCESSING_TIMEOUT_MS}ms, ` +
					`skipping remaining ${batchItems.length - i} items`
				)
				// Mark remaining items as failed
				for (let j = i; j < batchItems.length; j++) {
					const filePath = options.itemToFilePath(batchItems[j])
					result.failed++
					result.processedFiles.push({
						path: filePath,
						status: "error",
						error: new Error("Individual processing timeout")
					})
				}
				break
			}

			const item = batchItems[i]
			const filePath = options.itemToFilePath(item)

			try {
				// First try without truncation
				const text = options.itemToText(item)
				const { embeddings } = await options.embedder.createEmbeddings([text])

				const point = options.itemToPoint(item, embeddings[0], startIndex + i)
				await options.vectorStore.upsertPoints([point])

				const fileHash = options.getFileHash?.(item)
				if (fileHash) {
					options.cacheManager.updateHash(filePath, fileHash)
				}

				result.processed++
				successCount++
				result.processedFiles.push({
					path: filePath,
					status: "success",
					newHash: fileHash,
					truncated: false
				})
				options.onProgress?.(result.processed, result.processed + result.failed, filePath)
				options.onItemIndexed?.(1)

			} catch (itemError) {
				// Individual item failed, try truncation
				console.warn(`[BatchProcessor] Individual item failed, trying truncation: ${filePath}`)

				// Pass correct itemIndex
				const success = await this._processItemWithTruncation(
					item,
					options,
					result,
					startIndex + i
				)

				if (success) {
					successCount++
				} else {
					// Truncation also failed, record error
					failureCount++
					result.failed++
					result.processedFiles.push({
						path: filePath,
						status: "error",
						error: itemError as Error
					})
					options.onProgress?.(result.processed, result.processed + result.failed, filePath)
				}
			}
		}

		console.log(
			`[BatchProcessor] Individual processing completed: ` +
			`${successCount} succeeded, ${failureCount} failed`
		)
	}

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

	/**
	 * Process a single batch with fallback to individual processing on recoverable errors
	 */
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
						newHash: fileHash,
						truncated: false
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

		// Fallback: batch failed, try individual processing for recoverable errors
		if (!success && lastError) {
			// Check if this is a recoverable error and truncation fallback is enabled
			if (ENABLE_TRUNCATION_FALLBACK && this._isRecoverableError(lastError)) {
				console.warn(
					`[BatchProcessor] Batch failed with recoverable error: "${lastError.message}". ` +
					`Falling back to individual processing...`
				)

				try {
					await this._processItemsIndividually(batchItems, options, result, startIndex)
					return  // Fallback completed successfully, don't throw error
				} catch (fallbackError) {
					// Fallback also failed, log and continue with original error handling
					console.error(`[BatchProcessor] Fallback processing also failed:`, fallbackError)
				}
			}

			// Fatal error: mark entire batch as failed (preserve original behavior)
			result.failed += batchItems.length
			result.errors.push(lastError)

			const errorMessage = `Failed to process batch after ${MAX_BATCH_RETRIES} attempts: ${lastError.message}`
			const batchError = new Error(errorMessage)
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
