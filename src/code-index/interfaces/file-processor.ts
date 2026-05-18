import { PointStruct } from "./vector-store"

/**
 * Interface for code file parser
 */
export interface ICodeParser {
  /**
   * Parses a code file into code blocks
   * @param filePath Path to the file to parse
   * @param options Optional parsing options
   * @returns Promise resolving to array of code blocks
   */
  parseFile(
    filePath: string,
    options?: {
      minBlockLines?: number
      maxBlockLines?: number
      content?: string
      fileHash?: string
    },
  ): Promise<CodeBlock[]>
}

/**
 * Interface for directory scanner
 */
export interface IDirectoryScanner {
  /**
   * Scans a directory for code blocks
   * @param directoryPath Path to the directory to scan
   * @param options Optional scanning options
   * @returns Promise resolving to scan results and processing statistics
   */
  scanDirectory(
    directory: string,
    onError?: (error: Error) => void,
    onBlocksIndexed?: (indexedCount: number) => void,
    onFileParsed?: (fileBlockCount: number) => void,
  ): Promise<{
    codeBlocks: CodeBlock[]
    stats: {
      processed: number
      skipped: number
    }
    totalBlockCount: number
  }>

  /**
   * Gets all file paths in the directory
   * @param directoryPath Path to the directory to scan
   * @returns Promise resolving to an array of file paths
   */
  getAllFilePaths(directoryPath: string): Promise<string[]>
}

/**
 * Interface for code file processor watcher
 */
export interface ICodeFileWatcher {
  /**
   * Initializes the file watcher
   */
  initialize(): Promise<void>

  /**
   * Event emitted when a batch of files begins processing.
   * The event payload is an array of file paths included in the batch.
   */
  readonly onDidStartBatchProcessing: (handler: (data: string[]) => void) => () => void

  /**
   * Event emitted to report progress during batch processing (file-level).
   */
  readonly onBatchProgressUpdate: (handler: (data: {
    processedInBatch: number
    totalInBatch: number
    currentFile?: string
  }) => void) => () => void

  /**
   * Event emitted to report progress during batch processing (block-level).
   */
  readonly onBatchProgressBlocksUpdate: (handler: (data: {
    processedBlocks: number
    totalBlocks: number
  }) => void) => () => void

  /**
   * Event emitted when a batch of files has finished processing.
   * The event payload contains a summary of the batch operation.
   */
  readonly onDidFinishBatchProcessing: (handler: (data: BatchProcessingSummary) => void) => () => void

  /**
   * Processes a file
   * @param filePath Path to the file to process
   * @returns Promise resolving to processing result
   */
  processFile(filePath: string): Promise<FileProcessingResult>

  /**
   * Disposes the file watcher and cleans up resources
   */
  dispose(): void
}

export interface BatchProcessingSummary {
  /** All files attempted in the batch, including their final status. */
  processedFiles: FileProcessingResult[]
  /** Optional error if the entire batch operation failed (e.g., database connection issue). */
  batchError?: Error
}

export interface FileProcessingResult {
  path: string
  status: "success" | "skipped" | "error" | "processed_for_batching" | "local_error"
  error?: Error
  reason?: string
  newHash?: string
  pointsToUpsert?: PointStruct[]
  /** Whether the content was truncated due to being too long for the embedder */
  truncated?: boolean
}

/**
 * Common types used across the code-index service
 */

export interface ParentContainer {
  identifier: string | null
  type: string
}

export interface CodeBlock {
  file_path: string
  identifier: string | null
  type: string
  start_line: number
  end_line: number
  content: string
  fileHash: string
  segmentHash: string
  chunkSource: 'tree-sitter' | 'fallback' | 'line-segment' | 'markdown'
  parentChain: ParentContainer[]
  hierarchyDisplay: string | null
}
