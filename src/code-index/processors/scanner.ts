import { listFiles } from "../../glob/list-files"
import { Ignore } from "ignore"
import { scannerExtensions } from "../shared/supported-extensions"
import { CodeBlock, ICodeParser, IEmbedder, IVectorStore, IDirectoryScanner } from "../interfaces"
import { BatchProcessor, BatchProcessorOptions } from "./batch-processor"
import { IFileSystem, IWorkspace, IPathUtils, ILogger } from "../../abstractions"
import { createHash } from "crypto"
import { v5 as uuidv5 } from "uuid"
// p-limit for concurrency control
import { Mutex } from "async-mutex"
import pLimit from "p-limit"
import { CacheManager } from "../cache-manager"
import {
	QDRANT_CODE_BLOCK_NAMESPACE,
	MAX_FILE_SIZE_BYTES,
	MAX_LIST_FILES_LIMIT,
	BATCH_SEGMENT_THRESHOLD,
	MAX_BATCH_RETRIES,
	INITIAL_RETRY_DELAY_MS,
	PARSING_CONCURRENCY,
	BATCH_PROCESSING_CONCURRENCY,
} from "../constants"

export interface DirectoryScannerDependencies {
	embedder: IEmbedder
	qdrantClient: IVectorStore
	codeParser: ICodeParser
	cacheManager: CacheManager
	ignoreInstance: Ignore
	fileSystem: IFileSystem
	workspace: IWorkspace
	pathUtils: IPathUtils
	logger?: ILogger // 新增logger依赖，可选
}

export class DirectoryScanner implements IDirectoryScanner {
	private batchProcessor: BatchProcessor<CodeBlock>
	
	constructor(private readonly deps: DirectoryScannerDependencies) {
		this.batchProcessor = new BatchProcessor()
	}

	/**
	 * Debug logging helper - only logs if logger is available and configured for debug level
	 */
	private debug(message: string, ...args: any[]): void {
		this.deps.logger?.debug(message, ...args)
	}

	/**
	 * Recursively scans a directory for code blocks in supported files.
	 * @param directoryPath The directory to scan
	 * @param rooIgnoreController Optional RooIgnoreController instance for filtering
	 * @param context VS Code ExtensionContext for cache storage
	 * @param onError Optional error handler callback
	 * @returns Promise<{codeBlocks: CodeBlock[], stats: {processed: number, skipped: number}}> Array of parsed code blocks and processing stats
	 */
	public async scanDirectory(
		directory: string,
		onError?: (error: Error) => void,
		onBlocksIndexed?: (indexedCount: number) => void,
		onFileParsed?: (fileBlockCount: number) => void,
	): Promise<{ codeBlocks: CodeBlock[]; stats: { processed: number; skipped: number }; totalBlockCount: number }> {
		const directoryPath = directory
		this.debug(`[Scanner] Scanning directory: ${directoryPath}`)
		// Get all files recursively (handles .gitignore automatically)
		const [allPaths, _] = await listFiles(directoryPath, true, MAX_LIST_FILES_LIMIT, { pathUtils: this.deps.pathUtils, ripgrepPath: 'rg' })
		this.debug(`[Scanner] Found ${allPaths.length} paths from listFiles:`, allPaths.slice(0, 10))

		// Filter out directories (marked with trailing '/')
		const filePaths = allPaths.filter((p) => !p.endsWith("/"))
		this.debug(`[Scanner] After filtering directories: ${filePaths.length} files:`, filePaths.slice(0, 10))

		// Filter paths using workspace ignore rules
		const allowedPaths: string[] = []
		for (const filePath of filePaths) {
			const shouldIgnore = await this.deps.workspace.shouldIgnore(filePath)
			this.debug(`[Scanner] shouldIgnore(${filePath}): ${shouldIgnore}`)
			if (!shouldIgnore) {
				allowedPaths.push(filePath)
			}
		}
		this.debug(`[Scanner] After workspace ignore rules: ${allowedPaths.length} files:`, allowedPaths)

		// Filter by supported extensions and ignore patterns
		const supportedPaths = allowedPaths.filter((filePath) => {
			const ext = this.deps.pathUtils.extname(filePath).toLowerCase()
			const relativeFilePath = this.deps.workspace.getRelativePath(filePath)
			const extSupported = scannerExtensions.includes(ext)
			const ignoreInstanceIgnores = this.deps.ignoreInstance.ignores(relativeFilePath)

			this.debug(`[Scanner] File: ${filePath}, ext: ${ext}, extSupported: ${extSupported}, ignoreInstanceIgnores: ${ignoreInstanceIgnores}`)

			return extSupported && !ignoreInstanceIgnores
		})
		this.debug(`[Scanner] After extension and ignore filtering: ${supportedPaths.length} files:`, supportedPaths)

		// Initialize tracking variables
		const processedFiles = new Set<string>()
		const codeBlocks: CodeBlock[] = []
		let processedCount = 0
		let skippedCount = 0

		// Initialize parallel processing tools
		const parseLimiter = pLimit(PARSING_CONCURRENCY) // Concurrency for file parsing
		const batchLimiter = pLimit(BATCH_PROCESSING_CONCURRENCY) // Concurrency for batch processing
		const mutex = new Mutex()

		// Shared batch accumulators (protected by mutex)
		let currentBatchBlocks: CodeBlock[] = []
		let currentBatchTexts: string[] = []
		let currentBatchFileInfos: { filePath: string; fileHash: string; isNew: boolean }[] = []
		const activeBatchPromises: Promise<void>[] = []

		// Initialize block counter
		let totalBlockCount = 0

		this.debug(`[Scanner] Starting to process ${supportedPaths.length} supported files`)

		// Process all files in parallel with concurrency control
		const parsePromises = supportedPaths.map((filePath) =>
			parseLimiter(async () => {
				try {
					this.debug(`[Scanner] Processing file: ${filePath}`)
					// Check file size
					const stats = await this.deps.fileSystem.stat(filePath)
					this.debug(`[Scanner] File ${filePath} size: ${stats.size} bytes (limit: ${MAX_FILE_SIZE_BYTES})`)
					if (stats.size > MAX_FILE_SIZE_BYTES) {
						this.debug(`[Scanner] Skipping large file: ${filePath}`)
						skippedCount++ // Skip large files
						return
					}

					// Read file content
					const buffer = await this.deps.fileSystem.readFile(filePath)
					const content = new TextDecoder().decode(buffer)

					// Calculate current hash
					const currentFileHash = createHash("sha256").update(content).digest("hex")
					processedFiles.add(filePath)

					// Check against cache
					const cachedFileHash = this.deps.cacheManager.getHash(filePath)
					this.debug(`[Scanner] File ${filePath}: cachedHash=${cachedFileHash}, currentHash=${currentFileHash}`)
					if (cachedFileHash === currentFileHash) {
						// File is unchanged
						this.debug(`[Scanner] Skipping unchanged file: ${filePath}`)
						skippedCount++
						return
					}

					// File is new or changed - parse it using the injected parser function
					const blocks = await this.deps.codeParser.parseFile(filePath, { content, fileHash: currentFileHash })
					const fileBlockCount = blocks.length
					onFileParsed?.(fileBlockCount)
					codeBlocks.push(...blocks)
					processedCount++

					// Process embeddings if configured
					if (this.deps.embedder && this.deps.qdrantClient && blocks.length > 0) {
						// Add to batch accumulators
						let addedBlocksFromFile = false
						for (const block of blocks) {
							const trimmedContent = block.content.trim()
							if (trimmedContent) {
								const release = await mutex.acquire()
								totalBlockCount += fileBlockCount
								try {
									currentBatchBlocks.push(block)
									currentBatchTexts.push(trimmedContent)
									addedBlocksFromFile = true

									if (addedBlocksFromFile) {
										currentBatchFileInfos.push({
											filePath,
											fileHash: currentFileHash,
											isNew: !this.deps.cacheManager.getHash(filePath),
										})
									}

									// Check if batch threshold is met
									if (currentBatchBlocks.length >= BATCH_SEGMENT_THRESHOLD) {
										// Copy current batch data and clear accumulators
										const batchBlocks = [...currentBatchBlocks]
										const batchTexts = [...currentBatchTexts]
										const batchFileInfos = [...currentBatchFileInfos]
										currentBatchBlocks = []
										currentBatchTexts = []
										currentBatchFileInfos = []

										// Queue batch processing
										const batchPromise = batchLimiter(() =>
											this.processBatch(
												batchBlocks,
												batchFileInfos,
												onError,
												onBlocksIndexed,
											),
										)
										activeBatchPromises.push(batchPromise)
									}
								} finally {
									release()
								}
							}
						}
					} else {
						// Only update hash if not being processed in a batch
						await this.deps.cacheManager.updateHash(filePath, currentFileHash)
					}
				} catch (error) {
					console.error(`Error processing file ${filePath}:`, error)
					if (onError) {
						onError(error instanceof Error ? error : new Error(`Unknown error processing file ${filePath}`))
					}
				}
			}),
		)

		// Wait for all parsing to complete
		await Promise.all(parsePromises)

		// Process any remaining items in batch
		if (currentBatchBlocks.length > 0) {
			const release = await mutex.acquire()
			try {
				// Copy current batch data and clear accumulators
				const batchBlocks = [...currentBatchBlocks]
				const batchTexts = [...currentBatchTexts]
				const batchFileInfos = [...currentBatchFileInfos]
				currentBatchBlocks = []
				currentBatchTexts = []
				currentBatchFileInfos = []

				// Queue final batch processing
				const batchPromise = batchLimiter(() =>
					this.processBatch(batchBlocks, batchFileInfos, onError, onBlocksIndexed),
				)
				activeBatchPromises.push(batchPromise)
			} finally {
				release()
			}
		}

		// Wait for all batch processing to complete
		await Promise.all(activeBatchPromises)

		// Handle deleted files
		const oldHashes = this.deps.cacheManager.getAllHashes()
		for (const cachedFilePath of Object.keys(oldHashes)) {
			if (!processedFiles.has(cachedFilePath)) {
				// File was deleted or is no longer supported/indexed
				if (this.deps.qdrantClient) {
					try {
						await this.deps.qdrantClient.deletePointsByFilePath(cachedFilePath)
						await this.deps.cacheManager.deleteHash(cachedFilePath)
					} catch (error) {
						console.error(`[DirectoryScanner] Failed to delete points for ${cachedFilePath}:`, error)
						if (onError) {
							onError(
								error instanceof Error
									? error
									: new Error(`Unknown error deleting points for ${cachedFilePath}`),
							)
						}
						// Decide if we should re-throw or just log
					}
				}
			}
		}

		this.debug(`[Scanner] Final results: ${codeBlocks.length} code blocks, processed: ${processedCount}, skipped: ${skippedCount}, totalBlockCount: ${totalBlockCount}`)

		return {
			codeBlocks,
			stats: {
				processed: processedCount,
				skipped: skippedCount,
			},
			totalBlockCount,
		}
	}

	private async processBatch(
		batchBlocks: CodeBlock[],
		batchFileInfos: { filePath: string; fileHash: string; isNew: boolean }[],
		onError?: (error: Error) => void,
		onBlocksIndexed?: (indexedCount: number) => void,
	): Promise<void> {
		if (batchBlocks.length === 0) return

		// Use BatchProcessor for the actual processing
		const options: BatchProcessorOptions<CodeBlock> = {
			embedder: this.deps.embedder,
			vectorStore: this.deps.qdrantClient,
			cacheManager: this.deps.cacheManager,
			
			itemToText: (block) => block.content,
			itemToFilePath: (block) => block.file_path,
			getFileHash: (block) => {
				// Find the corresponding file info for this block
				const fileInfo = batchFileInfos.find(info => info.filePath === block.file_path)
				return fileInfo?.fileHash || ""
			},
			
			itemToPoint: (block, embedding) => {
				const normalizedAbsolutePath = this.deps.pathUtils.normalize(this.deps.pathUtils.resolve(block.file_path))
				const stableName = `${normalizedAbsolutePath}:${block.start_line}`
				const pointId = uuidv5(stableName, QDRANT_CODE_BLOCK_NAMESPACE)

				return {
					id: pointId,
					vector: embedding,
					payload: {
						filePath: this.deps.workspace.getRelativePath(normalizedAbsolutePath),
						codeChunk: block.content,
						startLine: block.start_line,
						endLine: block.end_line,
						chunkSource: block.chunkSource,
						type: block.type,
						identifier: block.identifier,
						parentChain: block.parentChain,
						hierarchyDisplay: block.hierarchyDisplay,
					},
				}
			},
			
			getFilesToDelete: (blocks) => {
				// Get files that need to be deleted (modified files, not new ones)
				const uniqueFilePaths = Array.from(new Set(
					batchFileInfos
						.filter((info) => !info.isNew) // Only modified files (not new)
						.map((info) => info.filePath),
				))
				return uniqueFilePaths
			},
			
			onProgress: (processed, total) => {
				// Optional: could emit progress events here if needed
			},
			
			onError: (error) => {
				console.error("[DirectoryScanner] Batch processing error:", error)
				onError?.(error)
			}
		}

		const result = await this.batchProcessor.processBatch(batchBlocks, options)
		
		if (result.processed > 0) {
			onBlocksIndexed?.(result.processed)
		}
		
		if (result.errors.length > 0) {
			const errorMessage = `Failed to process batch: ${result.errors.map(e => e.message).join(', ')}`
			console.error(`[DirectoryScanner] ${errorMessage}`)
			onError?.(new Error(errorMessage))
		}
	}

	public async getAllFilePaths(directory: string): Promise<string[]> {
		const directoryPath = directory
		this.debug(`[Scanner] Getting all file paths for: ${directoryPath}`)
		// Get all files recursively (handles .gitignore automatically)
		const [allPaths, _] = await listFiles(directoryPath, true, MAX_LIST_FILES_LIMIT, { pathUtils: this.deps.pathUtils, ripgrepPath: 'rg' })
		this.debug(`[Scanner] Found ${allPaths.length} paths from listFiles:`)

		// Filter out directories (marked with trailing '/')
		const filePaths = allPaths.filter((p) => !p.endsWith("/"))
		this.debug(`[Scanner] After filtering directories: ${filePaths.length} files:`)

		// Filter paths using workspace ignore rules
		const allowedPaths: string[] = []
		for (const filePath of filePaths) {
			const shouldIgnore = await this.deps.workspace.shouldIgnore(filePath)
			if (!shouldIgnore) {
				allowedPaths.push(filePath)
			}
		}
		this.debug(`[Scanner] After workspace ignore rules: ${allowedPaths.length} files:`)

		// Filter by supported extensions and ignore patterns
		const supportedPaths = allowedPaths.filter((filePath) => {
			const ext = this.deps.pathUtils.extname(filePath).toLowerCase()
			const relativeFilePath = this.deps.workspace.getRelativePath(filePath)
			const extSupported = scannerExtensions.includes(ext)
			const ignoreInstanceIgnores = this.deps.ignoreInstance.ignores(relativeFilePath)

			return extSupported && !ignoreInstanceIgnores
		})
		this.debug(`[Scanner] After extension and ignore filtering: ${supportedPaths.length} files:`)

		return supportedPaths
	}
}