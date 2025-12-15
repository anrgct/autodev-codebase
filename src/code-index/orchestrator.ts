import * as path from "path"
import { CodeIndexConfigManager } from "./config-manager"
import { CodeIndexStateManager, IndexingState } from "./state-manager"
import { ICodeFileWatcher, IVectorStore, BatchProcessingSummary } from "./interfaces"
import { DirectoryScanner } from "./processors"
import { CacheManager } from "./cache-manager"
import { Logger } from "../utils/logger"

// Type-compatible logger interface using Pick to extract only required methods from Logger
type LoggerLike = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

// Hardcoded internationalization functions (replacing t() calls)
const t = (key: string, params?: Record<string, string>): string => {
	const translations: Record<string, string> = {
		"embeddings:orchestrator.indexingRequiresWorkspace": "Indexing requires a workspace folder to be open.",
		"embeddings:orchestrator.fileWatcherStarted": "File watcher started. Monitoring for changes...",
		"embeddings:orchestrator.indexingFailedNoBlocks": "Indexing failed: No code blocks were successfully indexed. This usually indicates an embedder configuration issue.",
		"embeddings:orchestrator.indexingFailedCritical": "Indexing failed critically: No blocks were indexed despite finding content to process.",
		"embeddings:orchestrator.fileWatcherStopped": "File watcher stopped.",
		"embeddings:orchestrator.failedDuringInitialScan": "Failed during initial scan: {errorMessage}",
		"embeddings:orchestrator.unknownError": "Unknown error",
		"embeddings:orchestrator.clearingIndexData": "Clearing index data...",
		"embeddings:orchestrator.indexDataCleared": "Index data cleared successfully.",
		"embeddings:orchestrator.servicesReady": "Services ready. Starting workspace scan...",
		"embeddings:orchestrator.checkingForChanges": "Checking for new or modified files...",
		"embeddings:orchestrator.noNewFiles": "No new or changed files found",
		"embeddings:orchestrator.incrementalScanCompleted": "Incremental scan completed: {blocksIndexed} blocks indexed from new/changed files",
	}

	let message = translations[key] || key
	if (params) {
		for (const [param, value] of Object.entries(params)) {
			message = message.replace(`{${param}}`, value)
		}
	}
	return message
}

/**
 * Manages the code indexing workflow, coordinating between different services and managers.
 */
export class CodeIndexOrchestrator {
	private _fileWatcherSubscriptions: (() => void)[] = []
	private _isProcessing: boolean = false

	constructor(
		private readonly configManager: CodeIndexConfigManager,
		private readonly stateManager: CodeIndexStateManager,
		private readonly workspacePath: string,
		private readonly cacheManager: CacheManager,
		private readonly vectorStore: IVectorStore,
		private readonly scanner: DirectoryScanner,
		private readonly fileWatcher: ICodeFileWatcher,
		private readonly logger?: LoggerLike,
	) {}

	/**
	 * Get the vector store instance for direct access (e.g., search-only initialization)
	 */
	public getVectorStore(): IVectorStore {
		return this.vectorStore
	}

	/**
	 * Logging helper methods - only log if logger is available
	 */
	private debug(message: string, ...args: any[]): void {
		this.logger?.debug(message, ...args)
	}

	private info(message: string, ...args: any[]): void {
		this.logger?.info(message, ...args)
	}

	private warn(message: string, ...args: any[]): void {
		this.logger?.warn(message, ...args)
	}

	private error(message: string, ...args: any[]): void {
		this.logger?.error(message, ...args)
	}

	/**
	 * Starts the file watcher if not already running.
	 */
	private async _startWatcher(): Promise<void> {
		if (!this.configManager.isFeatureConfigured) {
			throw new Error("Cannot start watcher: Service not configured.")
		}

		this.stateManager.setSystemState("Indexing", "Initializing file watcher...")

		try {
			await this.fileWatcher.initialize()

			this._fileWatcherSubscriptions = [
				this.fileWatcher.onDidStartBatchProcessing((filePaths: string[]) => {}),
				this.fileWatcher.onBatchProgressBlocksUpdate(({ processedBlocks, totalBlocks }) => {
					if (totalBlocks > 0 && this.stateManager.state !== "Indexing") {
						this.stateManager.setSystemState("Indexing", "Processing file changes...")
					}
					this.stateManager.reportBlockIndexingProgress(
						processedBlocks,
						totalBlocks,
					)
					if (processedBlocks === totalBlocks) {
						// Covers (N/N) and (0/0)
						if (totalBlocks > 0) {
							// Batch with items completed
							this.stateManager.setSystemState("Indexed", "File changes processed. Index up-to-date.")
						} else {
							if (this.stateManager.state === "Indexing") {
								// Only transition if it was "Indexing"
								this.stateManager.setSystemState("Indexed", "Index up-to-date. File queue empty.")
							}
						}
					}
				}),
				this.fileWatcher.onDidFinishBatchProcessing((summary: BatchProcessingSummary) => {
					if (summary.batchError) {
						this.error(`[CodeIndexOrchestrator] Batch processing failed:`, summary.batchError)
					} else {
						const successCount = summary.processedFiles.filter(
							(f: { status: string }) => f.status === "success",
						).length
						const errorCount = summary.processedFiles.filter(
							(f: { status: string }) => f.status === "error" || f.status === "local_error",
						).length
					}
				}),
			]
		} catch (error) {
			this.error("[CodeIndexOrchestrator] Failed to start file watcher:", error)
			throw error
		}
	}

	/**
	 * Initiates the indexing process (initial scan and starts watcher).
	 * @param force Force reindex all files, ignoring cache and metadata
	 */
	public async startIndexing(force?: boolean): Promise<void> {
		// Check if workspace is available first
		if (!this.workspacePath) {
			this.stateManager.setSystemState("Error", t("embeddings:orchestrator.indexingRequiresWorkspace"))
			this.warn("[CodeIndexOrchestrator] Start rejected: No workspace folder open.")
			return
		}

		if (!this.configManager.isFeatureConfigured) {
			this.stateManager.setSystemState("Standby", "Missing configuration. Save your settings to start indexing.")
			this.warn("[CodeIndexOrchestrator] Start rejected: Missing configuration.")
			return
		}

		if (
			this._isProcessing ||
			(this.stateManager.state !== "Standby" &&
				this.stateManager.state !== "Error" &&
				this.stateManager.state !== "Indexed")
		) {
			this.warn(
				`[CodeIndexOrchestrator] Start rejected: Already processing or in state ${this.stateManager.state}.`,
			)
			return
		}

		this._isProcessing = true
		this.stateManager.setSystemState("Indexing", "Initializing services...")

		// Track whether we successfully connected to vector store and started indexing
		// This helps us decide whether to preserve cache on error
		let indexingStarted = false

		try {
			this.info("[CodeIndexOrchestrator] Initializing vector store...")
			const collectionCreated = await this.vectorStore.initialize()

			// Successfully connected to vector store
			indexingStarted = true

			if (collectionCreated) {
				this.info("[CodeIndexOrchestrator] New collection created, clearing cache...")
				await this.cacheManager.clearCacheFile()
			}

			// Force mode: clear vector store + cache to ensure full reindex
			if (force) {
				this.info("[CodeIndexOrchestrator] Force mode: clearing vector store and cache...")
				await this.vectorStore.clearCollection()
				await this.cacheManager.clearCacheFile()
			}

			// Check if the collection already has indexed data
			// If it does, we can skip the full scan and just start the watcher
			const hasExistingData = force ? false : await this.vectorStore.hasIndexedData()

			if (hasExistingData && !collectionCreated) {
				// Collection exists with data - run incremental scan to catch any new/changed files
				// This handles files added while workspace was closed or vector store was inactive
				this.info(
					"[CodeIndexOrchestrator] Collection already has indexed data. Running incremental scan for new/changed files...",
				)
				this.stateManager.setSystemState("Indexing", t("embeddings:orchestrator.checkingForChanges"))

				// Mark as incomplete at the start of incremental scan
				await this.vectorStore.markIndexingIncomplete()

				let cumulativeBlocksIndexed = 0
				let cumulativeBlocksFoundSoFar = 0
				let batchErrors: Error[] = []

				const handleFileParsed = (fileBlockCount: number) => {
					cumulativeBlocksFoundSoFar += fileBlockCount
					this.stateManager.reportBlockIndexingProgress(cumulativeBlocksIndexed, cumulativeBlocksFoundSoFar)
				}

				const handleBlocksIndexed = (indexedCount: number) => {
					cumulativeBlocksIndexed += indexedCount
					this.stateManager.reportBlockIndexingProgress(cumulativeBlocksIndexed, cumulativeBlocksFoundSoFar)
				}

				// Run incremental scan - scanner skips unchanged files using cache
				const result = await this.scanner.scanDirectory(
					this.workspacePath,
					(batchError: Error) => {
						this.error(
							`[CodeIndexOrchestrator] Error during incremental scan batch: ${batchError.message}`,
							batchError,
						)
						batchErrors.push(batchError)
					},
					handleBlocksIndexed,
					handleFileParsed,
				)

				if (!result) {
					throw new Error("Incremental scan failed, is scanner initialized?")
				}

				// If new files were found and indexed, log the results
				if (cumulativeBlocksFoundSoFar > 0) {
					this.info(
						`[CodeIndexOrchestrator] Incremental scan completed: ${cumulativeBlocksIndexed} blocks indexed from new/changed files`,
					)
				} else {
					this.info("[CodeIndexOrchestrator] No new or changed files found")
				}

				await this._startWatcher()

				// Mark indexing as complete after successful incremental scan
				await this.vectorStore.markIndexingComplete()

				this.stateManager.setSystemState("Indexed", t("embeddings:orchestrator.fileWatcherStarted"))
			} else {
				// No existing data or collection was just created - do a full scan
				this.stateManager.setSystemState("Indexing", t("embeddings:orchestrator.servicesReady"))

				// Mark as incomplete at the start of full scan
				await this.vectorStore.markIndexingIncomplete()

				let cumulativeBlocksIndexed = 0
				let cumulativeBlocksFoundSoFar = 0
				let batchErrors: Error[] = []

				const handleFileParsed = (fileBlockCount: number) => {
					cumulativeBlocksFoundSoFar += fileBlockCount
					this.stateManager.reportBlockIndexingProgress(cumulativeBlocksIndexed, cumulativeBlocksFoundSoFar)
				}

				const handleBlocksIndexed = (indexedCount: number) => {
					cumulativeBlocksIndexed += indexedCount
					this.stateManager.reportBlockIndexingProgress(cumulativeBlocksIndexed, cumulativeBlocksFoundSoFar)
				}

				this.info("[CodeIndexOrchestrator] Starting full scan...")
				const result = await this.scanner.scanDirectory(
					this.workspacePath,
					(batchError: Error) => {
						this.error(
							`[CodeIndexOrchestrator] Error during full scan batch: ${batchError.message}`,
							batchError,
						)
						batchErrors.push(batchError)
					},
					handleBlocksIndexed,
					handleFileParsed,
				)

				if (!result) {
					throw new Error("Full scan failed, is scanner initialized?")
				}

				// Enhanced error detection and reporting
				if (batchErrors.length > 0) {
					const firstError = batchErrors[0]
					throw new Error(`Indexing failed: ${firstError.message}`)
				} else {
					// Check for critical failure scenarios
					if (cumulativeBlocksFoundSoFar > 0 && cumulativeBlocksIndexed === 0) {
						throw new Error(t("embeddings:orchestrator.indexingFailedCritical"))
					}
				}

				// Check for partial failures - if a significant portion of blocks failed
				const failureRate = (cumulativeBlocksFoundSoFar - cumulativeBlocksIndexed) / cumulativeBlocksFoundSoFar
				if (batchErrors.length > 0 && failureRate > 0.1) {
					// More than 10% of blocks failed to index
					const firstError = batchErrors[0]
					throw new Error(
						`Indexing partially failed: Only ${cumulativeBlocksIndexed} of ${cumulativeBlocksFoundSoFar} blocks were indexed. ${firstError.message}`,
					)
				}

				// CRITICAL: If there were ANY batch errors and NO blocks were successfully indexed,
				// this is a complete failure regardless of the failure rate calculation
				if (batchErrors.length > 0 && cumulativeBlocksIndexed === 0) {
					const firstError = batchErrors[0]
					throw new Error(`Indexing failed completely: ${firstError.message}`)
				}

				// Final sanity check: If we found blocks but indexed none and somehow no errors were reported,
				// this is still a failure
				if (cumulativeBlocksFoundSoFar > 0 && cumulativeBlocksIndexed === 0) {
					throw new Error(t("embeddings:orchestrator.indexingFailedCritical"))
				}

				await this._startWatcher()

				// Mark indexing as complete after successful full scan
				await this.vectorStore.markIndexingComplete()

				this.stateManager.setSystemState("Indexed", t("embeddings:orchestrator.fileWatcherStarted"))
			}
		} catch (error: any) {
			this.error("[CodeIndexOrchestrator] Error during indexing:", error)

			if (indexingStarted) {
				try {
					await this.vectorStore.clearCollection()
				} catch (cleanupError) {
					this.error("[CodeIndexOrchestrator] Failed to clean up after error:", cleanupError)
				}
			}

			// Only clear cache if indexing had started (vector store connection succeeded)
			// If we never connected to vector store, preserve cache for incremental scan when it comes back
			if (indexingStarted) {
				// Indexing started but failed mid-way - clear cache to avoid cache-vector store mismatch
				await this.cacheManager.clearCacheFile()
				this.info(
					"[CodeIndexOrchestrator] Indexing failed after starting. Clearing cache to avoid inconsistency.",
				)
			} else {
				// Never connected to vector store - preserve cache for future incremental scan
				this.info(
					"[CodeIndexOrchestrator] Failed to connect to vector store. Preserving cache for future incremental scan.",
				)
			}

			this.stateManager.setSystemState(
				"Error",
				t("embeddings:orchestrator.failedDuringInitialScan", {
					errorMessage: error.message || t("embeddings:orchestrator.unknownError"),
				}),
			)
			this.stopWatcher()
		} finally {
			this._isProcessing = false
		}
	}

	/**
	 * Stops the file watcher and cleans up resources.
	 */
	public stopWatcher(): void {
		this.fileWatcher.dispose()
		this._fileWatcherSubscriptions = []

		if (this.stateManager.state !== "Error") {
			this.stateManager.setSystemState("Standby", t("embeddings:orchestrator.fileWatcherStopped"))
		}
		this._isProcessing = false
	}

		/**
		 * Clears all index data by stopping the watcher, deleting the vector store collection,
		 * and resetting the cache file.
		 *
		 * 注意：这里不会重新创建空的 collection，目的是实现真正“清空干净”的语义。
		 * 下一次运行 --index / 搜索时，由对应流程负责按需重新初始化向量存储。
		 */
		public async clearIndexData(): Promise<void> {
			this._isProcessing = true

			try {
				// Stop file watcher so no new indexing work is scheduled while we clear data
				this.stopWatcher()

				try {
					if (this.configManager.isFeatureConfigured) {
						this.info("[CodeIndexOrchestrator] Deleting vector store collection for full reset...")
						await this.vectorStore.deleteCollection()

						// 给 Qdrant 一点时间完成删除操作（防止立即后续请求命中旧状态）
						await new Promise(resolve => setTimeout(resolve, 500))
						this.info("[CodeIndexOrchestrator] Collection deletion requested. No collection will be recreated.")
					} else {
						this.warn("[CodeIndexOrchestrator] Service not configured, skipping vector collection clear.")
					}
				} catch (error: any) {
					this.error("[CodeIndexOrchestrator] Failed to clear vector collection:", error)
					this.stateManager.setSystemState("Error", `Failed to clear vector collection: ${error.message}`)
				}

				// Also clear local cache so next indexing run starts from a clean slate
				await this.cacheManager.clearCacheFile()

				if (this.stateManager.state !== "Error") {
					this.stateManager.setSystemState("Standby", t("embeddings:orchestrator.indexDataCleared"))
				}
			} finally {
				this._isProcessing = false
			}
		}

	/**
	 * Gets the current state of the indexing system.
	 */
	public get state(): IndexingState {
		return this.stateManager.state
	}
}
