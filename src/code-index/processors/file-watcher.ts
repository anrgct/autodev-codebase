import * as fs from "fs"
import * as path from "path"
import {
  QDRANT_CODE_BLOCK_NAMESPACE,
  MAX_FILE_SIZE_BYTES,
  BATCH_SEGMENT_THRESHOLD,
  MAX_BATCH_RETRIES,
  INITIAL_RETRY_DELAY_MS,
} from "../constants"
import { createHash } from "crypto"
// RooIgnoreController removed - now using IgnoreService from workspace
import { v5 as uuidv5 } from "uuid"
import { scannerExtensions } from "../shared/supported-extensions"
import {
  ICodeFileWatcher,
  FileProcessingResult,
  IEmbedder,
  IVectorStore,
  PointStruct,
  BatchProcessingSummary,
  CodeBlock,
} from "../interfaces"
import { BatchProcessor, BatchProcessorOptions } from "./batch-processor"
import { codeParser } from "./parser"
import { CacheManager } from "../cache-manager"
import { generateNormalizedAbsolutePath, generateRelativeFilePath } from "../shared/get-relative-path"
import { generateBlockEmbeddingText } from "../shared/block-text-generator"
import { resolveDocumentPrefix } from "../search/instruction-prefix"
import { IEventBus, IFileSystem } from "../../abstractions/core"
import { IWorkspace, IPathUtils } from "../../abstractions/workspace"

/**
 * Implementation of the file watcher interface
 */
export class FileWatcher implements ICodeFileWatcher {
  private fileWatcher?: fs.FSWatcher
  private accumulatedEvents: Map<string, { filePath: string; type: "create" | "change" | "delete" }> = new Map()
  private batchProcessDebounceTimer?: NodeJS.Timeout
  private readonly BATCH_DEBOUNCE_DELAY_MS = 500
  private readonly FILE_PROCESSING_CONCURRENCY_LIMIT = 10
  private readonly batchSegmentThreshold: number

  private eventBus: IEventBus
  private fileSystem: IFileSystem
  private workspace: IWorkspace
  private pathUtils: IPathUtils
  private batchProcessor: BatchProcessor<CodeBlock>

  /**
   * Event emitted when a batch of files begins processing
   */
  public readonly onDidStartBatchProcessing: (handler: (data: string[]) => void) => () => void

  /**
   * Event emitted to report progress during batch processing (file-level)
   */
  public readonly onBatchProgressUpdate: (handler: (data: {
    processedInBatch: number
    totalInBatch: number
    currentFile?: string
  }) => void) => () => void

  /**
   * Event emitted to report progress during batch processing (block-level)
   */
  public readonly onBatchProgressBlocksUpdate: (handler: (data: {
    processedBlocks: number
    totalBlocks: number
  }) => void) => () => void

  /**
   * Event emitted when a batch of files has finished processing
   */
  public readonly onDidFinishBatchProcessing: (handler: (data: BatchProcessingSummary) => void) => () => void

  /**
   * Creates a new file watcher
   * @param workspacePath Path to the workspace
   * @param fileSystem File system abstraction
   * @param eventBus Event bus for emitting events
   * @param embedder Optional embedder
   * @param vectorStore Optional vector store
   * @param cacheManager Cache manager
   */
  constructor(
    private workspacePath: string,
    fileSystem: IFileSystem,
    eventBus: IEventBus,
    workspace: IWorkspace,
    pathUtils: IPathUtils,
    private readonly cacheManager: CacheManager,
    private embedder?: IEmbedder,
    private vectorStore?: IVectorStore,
    batchSegmentThreshold?: number,
  ) {
    this.eventBus = eventBus
    this.fileSystem = fileSystem
    this.workspace = workspace
    this.pathUtils = pathUtils
    this.batchProcessor = new BatchProcessor()

    // Get the configurable batch size from VSCode settings, fallback to default
    // If not provided in constructor, use default value
    if (batchSegmentThreshold !== undefined) {
      this.batchSegmentThreshold = batchSegmentThreshold
    } else {
      // In this environment, we don't have VSCode settings, so use default
      this.batchSegmentThreshold = BATCH_SEGMENT_THRESHOLD
    }

    // Initialize event handlers
    this.onDidStartBatchProcessing = (handler) => this.eventBus.on('batch-start', handler)
    this.onBatchProgressUpdate = (handler) => this.eventBus.on('batch-progress', handler)
    this.onBatchProgressBlocksUpdate = (handler) => this.eventBus.on('batch-progress-blocks', handler)
    this.onDidFinishBatchProcessing = (handler) => this.eventBus.on('batch-finish', handler)
  }

  /**
   * Initializes the file watcher
   */
  async initialize(): Promise<void> {
    // Create file watcher using Node.js fs.watch
    this.fileWatcher = fs.watch(this.workspacePath, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      // console.log(`[FileWatcher] Detected ${eventType} on file: ${filename}`)
      const fullPath = path.join(this.workspacePath, filename)

      // Check if file extension is supported
      const ext = path.extname(fullPath)
      if (!scannerExtensions.includes(ext)) return

      // Handle different event types
      if (eventType === 'rename') {
        // Use synchronous check for more reliable file existence detection
        try {
          fs.accessSync(fullPath, fs.constants.F_OK)
          // File exists, it was created or moved here
          // console.log(`[FileWatcher] File exists, treating as create: ${fullPath}`)
          this.handleFileCreated(fullPath)
        } catch (err) {
          // File doesn't exist, it was deleted or moved away
          // console.log(`[FileWatcher] File doesn't exist, treating as delete: ${fullPath}`)
          this.handleFileDeleted(fullPath)
        }
      } else if (eventType === 'change') {
        // console.log(`[FileWatcher] File changed: ${fullPath}`)
        this.handleFileChanged(fullPath)
      }
    })
  }

  /**
   * Disposes the file watcher
   */
  dispose(): void {
    this.fileWatcher?.close()
    if (this.batchProcessDebounceTimer) {
      clearTimeout(this.batchProcessDebounceTimer)
    }
    // EventBus cleanup is handled by the platform implementation
    this.accumulatedEvents.clear()
  }

  /**
   * Handles file creation events
   * @param filePath Path of the created file
   */
  private async handleFileCreated(filePath: string): Promise<void> {
    this.accumulatedEvents.set(filePath, { filePath, type: "create" })
    this.scheduleBatchProcessing()
  }

  /**
   * Handles file change events
   * @param filePath Path of the changed file
   */
  private async handleFileChanged(filePath: string): Promise<void> {
    this.accumulatedEvents.set(filePath, { filePath, type: "change" })
    this.scheduleBatchProcessing()
  }

  /**
   * Handles file deletion events
   * @param filePath Path of the deleted file
   */
  private async handleFileDeleted(filePath: string): Promise<void> {
    this.accumulatedEvents.set(filePath, { filePath, type: "delete" })
    this.scheduleBatchProcessing()
  }

  /**
   * Schedules batch processing with debounce
   */
  private scheduleBatchProcessing(): void {
    if (this.batchProcessDebounceTimer) {
      clearTimeout(this.batchProcessDebounceTimer)
    }
    this.batchProcessDebounceTimer = setTimeout(() => this.triggerBatchProcessing(), this.BATCH_DEBOUNCE_DELAY_MS)
  }

  /**
   * Triggers processing of accumulated events
   */
  private async triggerBatchProcessing(): Promise<void> {
    if (this.accumulatedEvents.size === 0) {
      return
    }

    const eventsToProcess = new Map(this.accumulatedEvents)
    this.accumulatedEvents.clear()

    const filePathsInBatch = Array.from(eventsToProcess.keys())
    this.eventBus.emit('batch-start', filePathsInBatch)

    await this.processBatch(Array.from(eventsToProcess.values()))
  }

  /**
   * Processes a batch of accumulated events using the BatchProcessor
   * @param events Array of events to process
   */
  private async processBatch(
    events: Array<{ filePath: string; type: "create" | "change" | "delete" }>,
  ): Promise<void> {
    console.log(`[FileWatcher] Processing batch of ${events.length} events`, JSON.stringify(events))
    const batchResults: FileProcessingResult[] = []
    let totalBlocksInBatch = 0
    const processedBlocksInBatch = { value: 0 }

    // Prepare events with content for non-delete operations
    const eventsWithContent: Array<{ filePath: string; type: "create" | "change" | "delete"; content?: string; newHash?: string }> = []

    for (const event of events) {
      if (event.type === "delete") {
        eventsWithContent.push(event)
      } else {
        // For create/change events, we need to read the file content
        try {
          const fileContent = await this.fileSystem.readFile(event.filePath)
          const content = new TextDecoder().decode(fileContent)
          const newHash = createHash("sha256").update(content).digest("hex")

          eventsWithContent.push({
            ...event,
            content,
            newHash
          })
        } catch (error: any) {
          const errorStatus = error?.status || error?.response?.status || error?.statusCode
          const errorMessage = error instanceof Error ? error.message : String(error)

          console.error(`[FileWatcher] Failed to read file ${event.filePath}:`, error)
          batchResults.push({
            path: event.filePath,
            status: "error",
            error: error instanceof Error ? error : new Error(errorMessage)
          })
        }
      }
    }

    // Parse files into code blocks and separate deletions
    const blocksToUpsert: CodeBlock[] = []
    const filesToDelete: string[] = []
    const fileInfoMap: Map<string, { fileHash: string; isNew: boolean }> = new Map()

    for (const event of eventsWithContent) {
      if (event.type === "delete") {
        filesToDelete.push(event.filePath)
      } else if (event.content && event.newHash) {
        // Parse the file to get code blocks like DirectoryScanner does
        try {
          const blocks = await codeParser.parseFile(event.filePath, {
            content: event.content,
            fileHash: event.newHash
          })

          // Add all blocks from this file to the batch
          blocks.forEach(block => {
            if (block.content.trim()) {
              blocksToUpsert.push(block)
            }
          })

          // Store file info for later use
          fileInfoMap.set(event.filePath, {
            fileHash: event.newHash,
            isNew: event.type === "create"
          })
        } catch (error) {
          console.error(`[FileWatcher] Failed to parse file ${event.filePath}:`, error)
          batchResults.push({
            path: event.filePath,
            status: "error",
            error: error as Error
          })
        }
      }
    }

    // Calculate total blocks in batch (blocks to upsert + deleted files are counted as 1 block each)
    totalBlocksInBatch = blocksToUpsert.length + filesToDelete.length

    // Initial progress update with block count
    this.eventBus.emit('batch-progress-blocks', {
      processedBlocks: 0,
      totalBlocks: totalBlocksInBatch,
    })

    // Process blocks using BatchProcessor with block-level progress tracking
    if (this.embedder && this.vectorStore && (blocksToUpsert.length > 0 || filesToDelete.length > 0)) {
      console.log(`[FileWatcher] Processing batch of ${blocksToUpsert.length} blocks and ${filesToDelete.length} deletions`)

      // Process deletions first (count each deleted file as 1 block)
      if (filesToDelete.length > 0) {
        await this.handleFileDeletions(
          filesToDelete,
          batchResults,
          processedBlocksInBatch,
          totalBlocksInBatch
        )
      }

      // Process blocks to upsert
      if (blocksToUpsert.length > 0) {
        // Derive document prefix from embedder for models that need it (e.g., "Document: " for jina retrieval)
        const documentPrefix: string | undefined = resolveDocumentPrefix(this.embedder)
        const isLateChunking = this.embedder?.poolingMode === "late-chunking"

        const options: BatchProcessorOptions<CodeBlock> = {
          embedder: this.embedder,
          vectorStore: this.vectorStore,
          cacheManager: this.cacheManager,

          itemToText: isLateChunking
            ? (block) => block.content
            : (block) => generateBlockEmbeddingText(block, this.workspacePath, documentPrefix),
          itemToFilePath: (block) => block.file_path,
          getFileHash: (block) => {
            // Find the corresponding file info for this block
            const fileInfo = fileInfoMap.get(block.file_path)
            return fileInfo?.fileHash || ""
          },

          itemToPoint: (block, embedding) => {
            // Use the same logic as DirectoryScanner
            const normalizedAbsolutePath = generateNormalizedAbsolutePath(block.file_path, this.workspacePath)
            const filePath = generateRelativeFilePath(normalizedAbsolutePath, this.workspacePath)
            const stableName = `${normalizedAbsolutePath}:${block.start_line}`
            const pointId = uuidv5(stableName, QDRANT_CODE_BLOCK_NAMESPACE)

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
              },
            }
          },

          getFilesToDelete: (blocks) => {
            // Get files that need to be deleted (modified files, not new ones)
            const uniqueFilePaths = Array.from(new Set(
              blocks
                .map(block => block.file_path)
                .filter(filePath => {
                  const fileInfo = fileInfoMap.get(filePath)
                  return fileInfo && !fileInfo.isNew // Only modified files (not new)
                })
            ))
            return uniqueFilePaths.map(path => this.workspace.getRelativePath(path))
          },

          // Path converter for cache deletion (relative -> absolute)
          relativeCachePathToAbsolute: (relativePath: string) => {
            return this.pathUtils.resolve(this.workspacePath, relativePath)
          },

          // Use BatchProcessor progress callback for block-level progress
          onProgress: (processed, total) => {
            this.eventBus.emit('batch-progress-blocks', {
              processedBlocks: processedBlocksInBatch.value + processed,
              totalBlocks: totalBlocksInBatch,
            })
          },

          onError: (error) => {
            console.error("[FileWatcher] Batch processing error:", error)
          }
        }

        if (isLateChunking) {
          // Late-chunking: process each file's blocks individually
          // Group blocksToUpsert by file_path
          const blocksByFile = new Map<string, CodeBlock[]>()
          for (const block of blocksToUpsert) {
            const existing = blocksByFile.get(block.file_path)
            if (existing) {
              existing.push(block)
            } else {
              blocksByFile.set(block.file_path, [block])
            }
          }

          for (const [filePath, fileBlocks] of blocksByFile) {
            // Update getFilesToDelete to only include this file
            const singleFileOptions: BatchProcessorOptions<CodeBlock> = {
              ...options,
              getFilesToDelete: () => {
                const fileInfo = fileInfoMap.get(filePath)
                if (fileInfo && !fileInfo.isNew) {
                  return [this.workspace.getRelativePath(filePath)]
                }
                return []
              },
            }

            const result = await this.batchProcessor.processBatch(fileBlocks, singleFileOptions)
            batchResults.push(...result.processedFiles)
            processedBlocksInBatch.value += fileBlocks.length
          }
        } else {
          // Last-token: process all blocks together
          const result = await this.batchProcessor.processBatch(blocksToUpsert, options)
          batchResults.push(...result.processedFiles)
          processedBlocksInBatch.value += blocksToUpsert.length
        }
      }
    } else if (this.vectorStore && filesToDelete.length > 0) {
      await this.handleFileDeletions(
        filesToDelete,
        batchResults,
        processedBlocksInBatch,
        totalBlocksInBatch,
        `[FileWatcher] Processing batch of ${filesToDelete.length} deletions without embedder`
      )
    }

    // Finalize
    this.eventBus.emit('batch-finish', {
      processedFiles: batchResults,
      batchError: batchResults.some(r => r.status === "error") ?
        new Error("Some files failed to process") : undefined,
    })

    // Final progress update
    this.eventBus.emit('batch-progress-blocks', {
      processedBlocks: processedBlocksInBatch.value,
      totalBlocks: totalBlocksInBatch,
    })

    if (this.accumulatedEvents.size === 0) {
      this.eventBus.emit('batch-progress-blocks', {
        processedBlocks: 0,
        totalBlocks: 0,
      })
    }
  }

  /**
   * Handles deletion of multiple files from the vector store and cache
   * @param filesToDelete Array of absolute file paths to delete
   * @param batchResults Array to append processing results to
   * @param processedBlocksInBatch Reference to the counter of processed blocks
   * @param totalBlocksInBatch Total number of blocks in the batch for progress reporting
   * @param logMessage Optional message to log before processing
   */
  private async handleFileDeletions(
    filesToDelete: string[],
    batchResults: FileProcessingResult[],
    processedBlocksInBatch: { value: number },
    totalBlocksInBatch: number,
    logMessage?: string
  ): Promise<void> {
    if (logMessage) {
      console.log(logMessage)
    }

    const relativeDeletePaths = filesToDelete.map(path => this.workspace.getRelativePath(path))

    try {
      await this.vectorStore!.deletePointsByMultipleFilePaths(relativeDeletePaths)
      for (const filePath of filesToDelete) {
        this.cacheManager.deleteHash(filePath)
        batchResults.push({ path: filePath, status: "success" })
        processedBlocksInBatch.value++

        // Report progress after each deleted file
        this.eventBus.emit('batch-progress-blocks', {
          processedBlocks: processedBlocksInBatch.value,
          totalBlocks: totalBlocksInBatch,
        })
      }
    } catch (error: any) {
      const errorStatus = error?.status || error?.response?.status || error?.statusCode
      const errorMessage = error instanceof Error ? error.message : String(error)

      console.error("[FileWatcher] Error deleting points for files:", filesToDelete, error)
      const processedError = error instanceof Error ? error : new Error(errorMessage)

      for (const filePath of filesToDelete) {
        batchResults.push({ path: filePath, status: "error", error: processedError })
        processedBlocksInBatch.value++

        // Report progress even for failed files
        this.eventBus.emit('batch-progress-blocks', {
          processedBlocks: processedBlocksInBatch.value,
          totalBlocks: totalBlocksInBatch,
        })
      }
    }
  }

  /**
   * Processes a file
   * @param filePath Path to the file to process
   * @returns Promise resolving to processing result
   */
  async processFile(filePath: string): Promise<FileProcessingResult> {
    try {
      // Check if file should be ignored using unified IgnoreService
      if (await this.workspace.shouldIgnore(filePath)) {
        return {
          path: filePath,
          status: "skipped" as const,
          reason: "File is ignored",
        }
      }

      // Check file size
      const fileStat = await this.fileSystem.stat(filePath)
      if (fileStat.size > MAX_FILE_SIZE_BYTES) {
        return {
          path: filePath,
          status: "skipped" as const,
          reason: "File is too large",
        }
      }

      // Read file content
      const fileContent = await this.fileSystem.readFile(filePath)
      const content = new TextDecoder().decode(fileContent)

      // Calculate hash
      const newHash = createHash("sha256").update(content).digest("hex")

      // Check if file has changed
      if (this.cacheManager.getHash(filePath) === newHash) {
        return {
          path: filePath,
          status: "skipped" as const,
          reason: "File has not changed",
        }
      }

      // Parse file
      const blocks = await codeParser.parseFile(filePath, { content, fileHash: newHash })

      // Prepare points for batch processing
      let pointsToUpsert: PointStruct[] = []
      if (this.embedder && blocks.length > 0) {
        const texts = blocks.map((block) => block.content)
        const { embeddings } = await this.embedder.createEmbeddings(texts)

        pointsToUpsert = blocks.map((block, index) => {
          const normalizedAbsolutePath = generateNormalizedAbsolutePath(block.file_path, this.workspacePath)
          const filePath = generateRelativeFilePath(normalizedAbsolutePath, this.workspacePath)
          const stableName = `${normalizedAbsolutePath}:${block.start_line}`
          const pointId = uuidv5(stableName, QDRANT_CODE_BLOCK_NAMESPACE)

          return {
            id: pointId,
            vector: embeddings[index],
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
            },
          }
        })
      }

      return {
        path: filePath,
        status: "processed_for_batching" as const,
        newHash,
        pointsToUpsert,
      }
    } catch (error) {
      return {
        path: filePath,
        status: "local_error" as const,
        error: error as Error,
      }
    }
  }
}
