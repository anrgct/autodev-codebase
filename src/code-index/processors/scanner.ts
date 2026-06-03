import { listFiles } from "../../glob/list-files"
import { generateNormalizedAbsolutePath, generateRelativeFilePath } from "../shared/get-relative-path"
import { generateBlockEmbeddingText } from "../shared/block-text-generator"
import { scannerExtensions } from "../shared/supported-extensions"
import { CodeBlock, ICodeParser, IEmbedder, IVectorStore, IDirectoryScanner } from "../interfaces"
import { BatchProcessor, BatchProcessorOptions } from "./batch-processor"
import { IFileSystem, IWorkspace, IPathUtils } from "../../abstractions"
import { Logger } from "../../utils/logger"
import { createHash } from "crypto"
import { v5 as uuidv5 } from "uuid"
// p-limit for concurrency control
import { Mutex } from "async-mutex"
import pLimit from "p-limit"
import { CacheManager } from "../cache-manager"
import {
  QDRANT_CODE_BLOCK_NAMESPACE,
  MAX_FILE_SIZE_BYTES,
  MAX_LIST_FILES_LIMIT_CODE_INDEX,
  BATCH_SEGMENT_THRESHOLD,
  MAX_BATCH_RETRIES,
  INITIAL_RETRY_DELAY_MS,
  PARSING_CONCURRENCY,
  BATCH_PROCESSING_CONCURRENCY,
  MAX_PENDING_BATCHES,
} from "../constants"
import { resolveDocumentPrefix } from "../search/instruction-prefix"

// Type-compatible logger interface using Pick to extract only required methods from Logger
type LoggerLike = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

export interface DirectoryScannerDependencies {
  embedder: IEmbedder
  qdrantClient: IVectorStore
  codeParser: ICodeParser
  cacheManager: CacheManager
  fileSystem: IFileSystem
  workspace: IWorkspace
  pathUtils: IPathUtils
  logger?: LoggerLike // Using LoggerLike for type compatibility
}

export class DirectoryScanner implements IDirectoryScanner {
  private batchProcessor: BatchProcessor<CodeBlock>
  private readonly batchSegmentThreshold: number

  constructor(private readonly deps: DirectoryScannerDependencies, batchSegmentThreshold?: number) {
    this.batchProcessor = new BatchProcessor()

    // Get the configurable batch size from settings, fallback to default
    // If not provided in constructor, use default value
    if (batchSegmentThreshold !== undefined) {
      this.batchSegmentThreshold = batchSegmentThreshold
    } else {
      // In this environment, we don't have VSCode settings, so use default
      this.batchSegmentThreshold = BATCH_SEGMENT_THRESHOLD
    }
  }

  /**
   * Debug logging helper - only logs if logger is available and configured for debug level
   */
  private debug(message: string, ...args: any[]): void {
    this.deps.logger?.debug(message, ...args)
  }

  /**
   * Filters files from a directory based on:
   * 1. Removing directories (paths ending with "/")
   * 2. Applying workspace ignore rules
   * 3. Filtering by supported file extensions
   * @param directoryPath The directory to scan
   * @returns Promise<string[]> Array of filtered, supported file paths
   */
  private async filterSupportedFiles(directoryPath: string): Promise<string[]> {
    // Get all files recursively (uses fast-glob + IgnoreService)
    const [allPaths, _] = await listFiles(directoryPath, true, MAX_LIST_FILES_LIMIT_CODE_INDEX, {
      pathUtils: this.deps.pathUtils,
      fileSystem: this.deps.fileSystem,
      workspace: this.deps.workspace
    })
    this.debug(`[Scanner] Found ${allPaths.length} paths from listFiles`)

    // Filter out directories (marked with trailing '/')
    const filePaths = allPaths.filter((p) => !p.endsWith("/"))
    this.debug(`[Scanner] After filtering directories: ${filePaths.length} files`)

    // Filter paths using workspace ignore rules
    const allowedPaths: string[] = []
    for (const filePath of filePaths) {
      const shouldIgnore = await this.deps.workspace.shouldIgnore(filePath)
      if (!shouldIgnore) {
        allowedPaths.push(filePath)
      }
    }
    const ignoredCount = filePaths.length - allowedPaths.length
    this.debug(`[Scanner] After workspace ignore rules: ${allowedPaths.length} files (removed ${ignoredCount})`)

    // Filter by supported extensions only
    const supportedPaths = allowedPaths.filter((filePath) => {
      const ext = this.deps.pathUtils.extname(filePath).toLowerCase()
      const extSupported = scannerExtensions.includes(ext)

      return extSupported
    })
    const extFilteredCount = allowedPaths.length - supportedPaths.length
    this.debug(`[Scanner] After extension filtering: ${supportedPaths.length} files (removed ${extFilteredCount}) [${supportedPaths.join(', ')}]`)

    return supportedPaths
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
    // Capture workspace context at scan start
    const scanWorkspace = this.deps.workspace.getRootPath()
    if (!scanWorkspace) {
      throw new Error("Workspace root path is required for scanning")
    }
    this.debug(`[Scanner] Scanning directory: ${directory}, workspace: ${scanWorkspace}`)

    // Get all supported files (filtered by extension, ignore rules, etc.)
    const supportedPaths = await this.filterSupportedFiles(directory)

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
    const activeBatchPromises = new Set<Promise<void>>()
    let pendingBatchCount = 0

    // Initialize block counter
    let totalBlockCount = 0

    const isLateChunking = this.deps.embedder?.poolingMode === "late-chunking"

    this.debug(`[Scanner] Starting to process ${supportedPaths.length} supported files`)

    // Process all files in parallel with concurrency control
    const parsePromises = supportedPaths.map((filePath) =>
      parseLimiter(async () => {
        try {
          // Check file size
          const stats = await this.deps.fileSystem.stat(filePath)
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
          if (cachedFileHash === currentFileHash) {
            // File is unchanged
            skippedCount++
            return
          }

          // File is new or changed - parse it using the injected parser function
          this.debug(`[Scanner] Processing file: ${filePath}`)
          const blocks = await this.deps.codeParser.parseFile(filePath, { content, fileHash: currentFileHash })
          const fileBlockCount = blocks.length
          onFileParsed?.(fileBlockCount)
          codeBlocks.push(...blocks)
          processedCount++

          // Process embeddings if configured
          if (this.deps.embedder && this.deps.qdrantClient && blocks.length > 0) {
            if (isLateChunking) {
              // Late-chunking: dispatch per-file (all blocks stay together)
              const validBlocks = blocks.filter((b) => b.content.trim())
              if (validBlocks.length === 0) return

              totalBlockCount += fileBlockCount

              // Wait if we've reached the maximum pending batches
              while (pendingBatchCount >= MAX_PENDING_BATCHES) {
                await Promise.race(activeBatchPromises)
              }

              pendingBatchCount++
              const batchPromise = batchLimiter(() =>
                this.processBatch(
                  validBlocks,
                  [{ filePath, fileHash: currentFileHash, isNew: !cachedFileHash }],
                  scanWorkspace,
                  onError,
                  onBlocksIndexed,
                ),
              )
              activeBatchPromises.add(batchPromise)
              batchPromise.finally(() => {
                activeBatchPromises.delete(batchPromise)
                pendingBatchCount--
              })
            } else {
              // Last-token: shared accumulator (existing logic)
              // Add to batch accumulators
              for (const block of blocks) {
                const trimmedContent = block.content.trim()
                if (trimmedContent) {
                  const release = await mutex.acquire()
                  totalBlockCount++
                  try {
                    currentBatchBlocks.push(block)
                    currentBatchTexts.push(trimmedContent)

                    currentBatchFileInfos.push({
                      filePath,
                      fileHash: currentFileHash,
                      isNew: !cachedFileHash,
                    })

                    // Check if batch threshold is met
                    if (currentBatchBlocks.length >= this.batchSegmentThreshold) {
                      while (pendingBatchCount >= MAX_PENDING_BATCHES) {
                        await Promise.race(activeBatchPromises)
                      }

                      const batchBlocks = [...currentBatchBlocks]
                      const batchTexts = [...currentBatchTexts]
                      const batchFileInfos = [...currentBatchFileInfos]
                      currentBatchBlocks = []
                      currentBatchTexts = []
                      currentBatchFileInfos = []

                      pendingBatchCount++
                      const batchPromise = batchLimiter(() =>
                        this.processBatch(
                          batchBlocks,
                          batchFileInfos,
                          scanWorkspace,
                          onError,
                          onBlocksIndexed,
                        ),
                      )
                      activeBatchPromises.add(batchPromise)
                      batchPromise.finally(() => {
                        activeBatchPromises.delete(batchPromise)
                        pendingBatchCount--
                      })
                    }
                  } finally {
                    release()
                  }
                }
              }
            }
          } else {
            // Only update hash if not being processed in a batch
            await this.deps.cacheManager.updateHash(filePath, currentFileHash)
          }
        } catch (error: any) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          console.error(`Error processing file ${filePath} in workspace ${scanWorkspace}:`, error)
          if (onError) {
            onError(
              error instanceof Error
                ? new Error(`${error.message} (Workspace: ${scanWorkspace}, File: ${filePath})`)
                : new Error(`Unknown error processing file ${filePath} (Workspace: ${scanWorkspace})`),
            )
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

        // Increment pending batch count for final batch
        pendingBatchCount++

        // Queue final batch processing
        const batchPromise = batchLimiter(() =>
          this.processBatch(batchBlocks, batchFileInfos, scanWorkspace, onError, onBlocksIndexed),
        )
        activeBatchPromises.add(batchPromise)

        // Clean up completed promises to prevent memory accumulation
        batchPromise.finally(() => {
          activeBatchPromises.delete(batchPromise)
          pendingBatchCount--
        })
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
          } catch (error: any) {
            const errorStatus = error?.status || error?.response?.status || error?.statusCode
            const errorMessage = error instanceof Error ? error.message : String(error)

            console.error(
              `[DirectoryScanner] Failed to delete points for ${cachedFilePath} in workspace ${scanWorkspace}:`,
              error,
            )

            if (onError) {
              // Report error to error handler
              onError(
                error instanceof Error
                  ? new Error(
                      `${error.message} (Workspace: ${scanWorkspace}, File: ${cachedFilePath})`,
                    )
                  : new Error(
                      `Unknown error deleting points for ${cachedFilePath} (Workspace: ${scanWorkspace})`,
                  ),
              )
            }
            // Log error and continue processing instead of re-throwing
            console.error(`Failed to delete points for removed file: ${cachedFilePath}`, error)
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
    scanWorkspace: string,
    onError?: (error: Error) => void,
    onBlocksIndexed?: (indexedCount: number) => void,
  ): Promise<void> {
    if (batchBlocks.length === 0) return

    // Derive document prefix from embedder for models that need it (e.g., "Document: " for jina retrieval)
    const documentPrefix: string | undefined = resolveDocumentPrefix(this.deps.embedder)

    // Use BatchProcessor for the actual processing
    const options: BatchProcessorOptions<CodeBlock> = {
      embedder: this.deps.embedder,
      vectorStore: this.deps.qdrantClient,
      cacheManager: this.deps.cacheManager,

      itemToText: this.deps.embedder?.poolingMode === "late-chunking"
        ? (block) => block.content
        : (block) => generateBlockEmbeddingText(block, scanWorkspace, documentPrefix),
      itemToFilePath: (block) => block.file_path,
      getFileHash: (block) => {
        // Find the corresponding file info for this block
        const fileInfo = batchFileInfos.find(info => info.filePath === block.file_path)
        return fileInfo?.fileHash || ""
      },

      itemToPoint: (block, embedding) => {
        const normalizedAbsolutePath = generateNormalizedAbsolutePath(block.file_path, scanWorkspace)
        const filePath = generateRelativeFilePath(normalizedAbsolutePath, scanWorkspace)

        // Use segmentHash for unique ID generation to handle multiple segments from same line
        const pointId = uuidv5(block.segmentHash, QDRANT_CODE_BLOCK_NAMESPACE)

        return {
          id: pointId,
          vector: embedding,
          payload: {
            filePath: filePath,
            filePathLower: filePath.toLowerCase(),
            codeChunk: block.content,
            startLine: block.start_line,
            endLine: block.end_line,
            chunkSource: block.chunkSource,
            type: block.type,
            identifier: block.identifier,
            parentChain: block.parentChain,
            hierarchyDisplay: block.hierarchyDisplay,
            segmentHash: block.segmentHash,
          },
        }
      },

      getFilesToDelete: (blocks) => {
        // Get files that need to be deleted (modified files, not new ones)
        const uniqueFilePaths = Array.from(new Set(
          batchFileInfos
            .filter((info) => !info.isNew) // Only modified files (not new)
            .map((info) => generateRelativeFilePath(info.filePath, scanWorkspace)),
        ))
        return uniqueFilePaths
      },

      onProgress: (processed, total) => {
        // Optional: could emit progress events here if needed
      },

      onError: (error) => {
        console.error("[DirectoryScanner] Batch processing error:", error)
        onError?.(error)
      },

      // Path converter for cache deletion (relative -> absolute)
      relativeCachePathToAbsolute: (relativePath: string) => {
        return this.deps.pathUtils.resolve(scanWorkspace, relativePath)
      },
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
    this.debug(`[Scanner] Getting all file paths for: ${directory}`)

    // Get all supported files (filtered by extension, ignore rules, etc.)
    return await this.filterSupportedFiles(directory)
  }
}
