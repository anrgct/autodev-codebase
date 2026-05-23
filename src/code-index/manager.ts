import { VectorStoreSearchResult, SearchFilter, IVectorStore, IDirectoryScanner, IReranker, IHighlighter } from "./interfaces"
import { IndexingState, ICodeIndexManager } from "./interfaces/manager"
import { CodeIndexConfigManager } from "./config-manager"
import { IConfigProvider } from "../abstractions/config"
import { CodeIndexStateManager } from "./state-manager"
import { CodeIndexServiceFactory } from "./service-factory"
import { CodeIndexSearchService } from "./search-service"
import { CodeIndexOrchestrator } from "./orchestrator"
import { CacheManager } from "./cache-manager"
import { IFileSystem, IStorage, IEventBus } from "../abstractions/core"
import { IWorkspace, IPathUtils } from "../abstractions/workspace"
import { Logger } from "../utils/logger"
import path from "path"

type LoggerLike = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

export interface CodeIndexManagerDependencies {
  fileSystem: IFileSystem
  storage: IStorage
  eventBus: IEventBus
  workspace: IWorkspace
  pathUtils: IPathUtils
  configProvider: IConfigProvider
  logger?: LoggerLike
}

export class CodeIndexManager implements ICodeIndexManager {
  // --- Singleton Implementation ---
  private static instances = new Map<string, CodeIndexManager>() // Map workspace path to instance

  // Specialized class instances
  private _configManager: CodeIndexConfigManager | undefined
  private readonly _stateManager: CodeIndexStateManager
  private _serviceFactory: CodeIndexServiceFactory | undefined
  private _orchestrator: CodeIndexOrchestrator | undefined
  private _searchService: CodeIndexSearchService | undefined
  private _cacheManager: CacheManager | undefined

  // Flag to prevent race conditions during error recovery
  private _isRecoveringFromError = false

  public static getInstance(dependencies: CodeIndexManagerDependencies, workspacePath?: string): CodeIndexManager | undefined {
    // If workspacePath is not provided, try to get it from the workspace
    if (!workspacePath) {
      workspacePath = dependencies.workspace.getRootPath()
    }

    if (!workspacePath) {
      return undefined
    }

    if (!CodeIndexManager.instances.has(workspacePath)) {
      CodeIndexManager.instances.set(workspacePath, new CodeIndexManager(workspacePath, dependencies))
    }
    return CodeIndexManager.instances.get(workspacePath)!
  }

  public static disposeAll(): void {
    for (const instance of Array.from(CodeIndexManager.instances.values())) {
      instance.dispose()
    }
    CodeIndexManager.instances.clear()
  }

  private readonly workspacePath: string
  private readonly dependencies: CodeIndexManagerDependencies

  // Private constructor for singleton pattern
  private constructor(workspacePath: string, dependencies: CodeIndexManagerDependencies) {
    this.workspacePath = workspacePath
    this.dependencies = dependencies
    this._stateManager = new CodeIndexStateManager(dependencies.eventBus)
  }

  // --- Public API ---

  public get workspacePathValue(): string {
    return this.workspacePath
  }

  public get onProgressUpdate() {
    return this._stateManager.onProgressUpdate
  }

  private assertInitialized() {
    if (!this._configManager || !this._orchestrator || !this._searchService || !this._cacheManager) {
      throw new Error("CodeIndexManager not initialized. Call initialize() first.")
    }
  }

  public get state(): IndexingState {
    if (!this.isFeatureEnabled) {
      return "Standby"
    }
    this.assertInitialized()
    return this._orchestrator!.state
  }

  public get isFeatureEnabled(): boolean {
    return this._configManager?.isFeatureEnabled ?? false
  }

  public get isFeatureConfigured(): boolean {
    return this._configManager?.isFeatureConfigured ?? false
  }

  public get isInitialized(): boolean {
    try {
      this.assertInitialized()
      return true
    } catch (error) {
      return false
    }
  }

  /**
   * Initializes the manager with configuration and dependent services.
   * Must be called before using any other methods.
   * @param options Optional initialization options
   * @param options.force Force reindex all files
   * @param options.searchOnly Initialize for search only (no background indexing, just init vector store)
   * @returns Object indicating if a restart is needed
   */
  public async initialize(options?: { force?: boolean; searchOnly?: boolean }): Promise<{ requiresRestart: boolean }> {
    // 1. ConfigManager Initialization and Configuration Loading
    if (!this._configManager) {
      this._configManager = new CodeIndexConfigManager(this.dependencies.configProvider)
      await this._configManager.initialize()
    }
    // Load configuration once to get current state and restart requirements
    const { requiresRestart } = await this._configManager.loadConfiguration()

    // 2. Check if feature is enabled
    if (!this.isFeatureEnabled) {
      if (this._orchestrator) {
        this._orchestrator.stopWatcher()
      }
      this._stateManager.setSystemState("Standby", "Code indexing is disabled")
      return { requiresRestart }
    }

    // 3. Check if workspace is available
    const workspacePath = this.workspacePath
    if (!workspacePath) {
      this._stateManager.setSystemState("Standby", "No workspace folder open")
      return { requiresRestart }
    }

    // 4. CacheManager Initialization
    if (!this._cacheManager) {
      this._cacheManager = new CacheManager(this.workspacePath)
      await this._cacheManager.initialize()
    }

    // 5. Determine if Core Services Need Recreation
    const needsServiceRecreation = !this._serviceFactory || requiresRestart

    if (needsServiceRecreation) {
      await this._recreateServices()
    }

    // 6. Handle Indexing Start/Restart
    // The enhanced vectorStore.initialize() in startIndexing() now handles dimension changes automatically
    // by detecting incompatible collections and recreating them, so we rely on that for dimension changes
    if (options?.searchOnly) {
      // For search-only mode: initialize vector store and set state to Indexed if data exists
      await this._initializeForSearchOnly()
    } else {
      const shouldStartOrRestartIndexing =
        requiresRestart ||
        (needsServiceRecreation && (!this._orchestrator || this._orchestrator.state !== "Indexing"))

      if (shouldStartOrRestartIndexing) {
        // Pass force parameter from initialize options
        this._orchestrator?.startIndexing(options?.force) // This method is async, but we don't await it here
      }
    }

    return { requiresRestart }
  }

  /**
   * Loads configuration from storage (interface implementation)
   */
  public async loadConfiguration(): Promise<void> {
    if (this._configManager) {
      await this._configManager.loadConfiguration()
    }
  }

  /**
   * Initiates the indexing process (initial scan and starts watcher).
   * Automatically recovers from error state if needed before starting.
   *
   * @important This method should NEVER be awaited as it starts a long-running background process.
   * The indexing will continue asynchronously and progress will be reported through events.
   * @param force Force reindex all files, ignoring cache and metadata
   */
  public async startIndexing(force?: boolean): Promise<void> {
    if (!this.isFeatureEnabled) {
      return
    }

    // Check if we're in error state and recover if needed
    const currentStatus = this.getCurrentStatus()
    if (currentStatus.systemStatus === "Error") {
      await this.recoverFromError()

      // After recovery, we need to reinitialize since recoverFromError clears all services
      // This will be handled by the caller checking isInitialized
      return
    }

    this.assertInitialized()
    await this._orchestrator!.startIndexing(force)
  }

  /**
   * Stops the file watcher and potentially cleans up resources.
   */
  public stopWatcher(): void {
    if (!this.isFeatureEnabled) {
      return
    }
    if (this._orchestrator) {
      this._orchestrator.stopWatcher()
    }
  }

  /**
   * Recovers from error state by clearing the error and resetting internal state.
   * This allows the manager to be re-initialized after a recoverable error.
   *
   * This method clears all service instances (configManager, serviceFactory, orchestrator, searchService)
   * to force a complete re-initialization on the next operation. This ensures a clean slate
   * after recovering from errors such as network failures or configuration issues.
   *
   * @remarks
   * - Safe to call even when not in error state (idempotent)
   * - Does not restart indexing automatically - call initialize() after recovery
   * - Service instances will be recreated on next initialize() call
   * - Prevents race conditions from multiple concurrent recovery attempts
   */
  public async recoverFromError(): Promise<void> {
    // Prevent race conditions from multiple rapid recovery attempts
    if (this._isRecoveringFromError) {
      return
    }

    this._isRecoveringFromError = true
    try {
      // Clear error state
      this._stateManager.setSystemState("Standby", "")
    } catch (error) {
      // Log error but continue with recovery - clearing service instances is more important
      console.error("Failed to clear error state during recovery:", error)
    } finally {
      // Force re-initialization by clearing service instances
      // This ensures a clean slate even if state update failed
      this._configManager = undefined
      this._serviceFactory = undefined
      this._orchestrator = undefined
      this._searchService = undefined

      // Reset the flag after recovery is complete
      this._isRecoveringFromError = false
    }
  }

  /**
   * Cleans up the manager instance.
   */
  public dispose(): void {
    if (this._orchestrator) {
      this.stopWatcher()
    }
    this._stateManager.dispose()
  }

  /**
   * Clears all index data by stopping the watcher, clearing the Qdrant collection,
   * and deleting the cache file.
   */
  public async clearIndexData(): Promise<void> {
    if (!this.isFeatureEnabled) {
      return
    }
    this.assertInitialized()
    await this._orchestrator!.clearIndexData()
    await this._cacheManager!.clearCacheFile()
  }

  // --- Private Helpers ---

  public getCurrentStatus() {
    const status = this._stateManager.getCurrentStatus()
    return {
      ...status,
      workspacePath: this.workspacePath,
    }
  }

  /**
   * Get components needed for dry-run mode
   * Provides controlled access to internal components for preview operations
   * @returns Object containing all necessary components for dry-run
   */
  public getDryRunComponents(): {
    scanner: any
    cacheManager: any
    vectorStore: any
    workspace: IWorkspace
    fileSystem: IFileSystem
    pathUtils: IPathUtils
  } {
    if (!this._orchestrator || !this._cacheManager) {
      throw new Error('Manager not initialized. Call initialize() first.')
    }

    // Get vector store from orchestrator
    const vectorStore = this._orchestrator.getVectorStore()

    return {
      scanner: (this._orchestrator as any).scanner,
      cacheManager: this._cacheManager,
      vectorStore: vectorStore,
      workspace: this.dependencies.workspace,
      fileSystem: this.dependencies.fileSystem,
      pathUtils: this.dependencies.pathUtils
    }
  }

  private async reconcileIndex(vectorStore: IVectorStore, scanner: IDirectoryScanner) {
    const logger = this.dependencies.logger
    logger?.info("Reconciling index with filesystem...")

    // 1. Get all file paths from the vector store (these are relative paths)
    const indexedRelativePaths = await vectorStore.getAllFilePaths()
    if (indexedRelativePaths.length === 0) {
      logger?.info("No files found in vector store. Skipping reconciliation.")
      return
    }

    // 2. Get all file paths from the local filesystem (these are absolute paths)
    const localAbsolutePaths = await scanner.getAllFilePaths(this.workspacePath)
    const localRelativePathSet = new Set(
      localAbsolutePaths.map((p) => this.dependencies.workspace.getRelativePath(p)),
    )

    // 3. Determine which files are stale
    const staleRelativePaths = indexedRelativePaths.filter((p) => !localRelativePathSet.has(p))

    if (staleRelativePaths.length > 0) {
      logger?.info(`Found ${staleRelativePaths.length} stale files to remove.`)

      // 4. Delete stale entries from vector store (using relative paths)
      await vectorStore.deletePointsByMultipleFilePaths(staleRelativePaths)

      // 5. Delete stale entries from cache (using absolute paths)
      const staleAbsolutePaths = staleRelativePaths.map((p) =>
        this.dependencies.pathUtils.resolve(this.workspacePath, p),
      )
      this._cacheManager!.deleteHashes(staleAbsolutePaths)
    } else {
      logger?.info("Index is already up-to-date.")
    }
  }

  public async searchIndex(query: string, filter?: SearchFilter): Promise<VectorStoreSearchResult[]> {
    if (!this.isFeatureEnabled) {
      return []
    }
    this.assertInitialized()
    return this._searchService!.searchIndex(query, filter)
  }

  public async highlight(
    query: string,
    codeChunk: string,
    startLine: number,
    options?: import("./interfaces/highlighter").HighlightOptions,
  ): Promise<import("./interfaces/highlighter").HighlightResult> {
    if (!this.isFeatureEnabled) {
      throw new Error("Code index feature is disabled. Cannot run highlight.")
    }
    this.assertInitialized()
    if (!this._searchService) {
      throw new Error("Search service is not initialized")
    }
    return this._searchService.highlight(query, codeChunk, startLine, options)
  }

  /**
   * Private helper method to recreate services with current configuration.
   * Used by both initialize() and handleSettingsChange().
   */
  private async _recreateServices(): Promise<void> {
    // Stop watcher if it exists
    if (this._orchestrator) {
      this.stopWatcher()
    }
    // Clear existing services to ensure clean state
    this._orchestrator = undefined
    this._searchService = undefined

    // (Re)Initialize service factory
    this._serviceFactory = new CodeIndexServiceFactory(
      this._configManager!,
      this.workspacePath,
      this._cacheManager!,
      this.dependencies.logger,
    )

    const workspacePath = this.workspacePath

    if (!workspacePath) {
      this._stateManager.setSystemState("Standby", "")
      return
    }

    // Ensure ignore rules are loaded by calling shouldIgnore on a dummy path
    // Use a dummy file path to trigger loading without causing empty path errors
    const dummyPath = path.join(workspacePath, "dummy.txt")
    await this.dependencies.workspace.shouldIgnore(dummyPath)

    // (Re)Create shared service instances
    const { embedder, vectorStore, scanner, fileWatcher } = await this._serviceFactory.createServices(
      this.dependencies.fileSystem,
      this.dependencies.eventBus,
      this._cacheManager!,
      this.dependencies.workspace,
      this.dependencies.pathUtils
    )

    // Validate embedder configuration before proceeding
    const validationResult = await this._serviceFactory.validateEmbedder(embedder)
    if (!validationResult.valid) {
      const errorMessage = validationResult.error || "Embedder configuration validation failed"
      this._stateManager.setSystemState("Error", errorMessage)
      throw new Error(errorMessage)
    }

    // Create reranker (optional)
    let reranker: IReranker | undefined
    if (this._configManager!.isRerankerEnabled) {
      reranker = await this._serviceFactory.createReranker()
      if (reranker) {
        const rerankerValidation = await this._serviceFactory.validateReranker(reranker)
        if (!rerankerValidation.valid) {
          console.warn('Reranker validation failed:', rerankerValidation.error)
          reranker = undefined // Degrade gracefully, don't use reranker
        }
      }
    }

    // Create highlighter (optional)
    let highlighter: IHighlighter | undefined
    const highlighterConfig = this._configManager!.highlighterConfig
    if (highlighterConfig.enabled) {
      highlighter = this._serviceFactory.createHighlighter()
      if (highlighter) {
        const highlighterValidation = await this._serviceFactory.validateHighlighter(highlighter)
        if (!highlighterValidation.valid) {
          console.warn('Highlighter validation failed:', highlighterValidation.error)
          highlighter = undefined // Degrade gracefully
        }
      }
    }

    // (Re)Initialize orchestrator
    this._orchestrator = new CodeIndexOrchestrator(
      this._configManager!,
      this._stateManager,
      this.workspacePath,
      this._cacheManager!,
      vectorStore,
      scanner,
      fileWatcher,
      this.dependencies.logger,
    )

    // (Re)Initialize search service
    this._searchService = new CodeIndexSearchService(
      this._configManager!,
      this._stateManager,
      embedder,
      vectorStore,
      reranker, // Pass reranker to search service
      highlighter, // Pass highlighter to search service
    )

    // Clear any error state after successful recreation
    this._stateManager.setSystemState("Standby", "")

    // Add the new reconciliation step
    await this.reconcileIndex(vectorStore, scanner)
  }

  /**
   * Initialize for search-only mode.
   * Initializes the vector store and sets state to "Indexed" if data exists.
   * This allows searching without starting background indexing.
   */
  private async _initializeForSearchOnly(): Promise<void> {
    this.assertInitialized()

    const vectorStore = this._orchestrator!.getVectorStore()

    // Initialize the vector store connection
    await vectorStore.initialize()

    // Check if there's existing indexed data
    const hasData = await vectorStore.hasIndexedData()

    if (hasData) {
      this._stateManager.setSystemState("Indexed", "Search-only mode: using existing index")
    } else {
      this._stateManager.setSystemState("Standby", "No indexed data found. Run --index first.")
    }
  }

  /**
   * Handle code index settings changes.
   * This method should be called when code index settings are updated
   * to ensure the CodeIndexConfigManager picks up the new configuration.
   * If the configuration changes require a restart, the service will be restarted.
   */
  public async handleSettingsChange(): Promise<void> {
    if (this._configManager) {
      const { requiresRestart } = await this._configManager.loadConfiguration()

      const isFeatureEnabled = this.isFeatureEnabled
      const isFeatureConfigured = this.isFeatureConfigured

      // If feature is disabled, stop the service
      if (!isFeatureEnabled) {
        // Stop the orchestrator if it exists
        if (this._orchestrator) {
          this._orchestrator.stopWatcher()
        }

        // Set state to indicate service is disabled
        this._stateManager.setSystemState("Standby", "Code indexing is disabled")
        return
      }

      if (requiresRestart && isFeatureEnabled && isFeatureConfigured) {
        try {
          // Ensure cacheManager is initialized before recreating services
          if (!this._cacheManager) {
            this._cacheManager = new CacheManager(this.workspacePath)
            await this._cacheManager.initialize()
          }

          // Recreate services with new configuration
          await this._recreateServices()
        } catch (error) {
          // Error state already set in _recreateServices
          console.error("Failed to recreate services:", error)
          // Re-throw the error so the caller knows validation failed
          throw error
        }
      }
    }
  }
}
