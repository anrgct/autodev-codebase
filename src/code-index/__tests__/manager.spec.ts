import { vitest, describe, it, expect, beforeEach, afterEach } from "vitest"
import { CodeIndexManager } from "../manager"


// Mock only the essential dependencies
vitest.mock("../../../utils/path", () => ({
  getWorkspacePath: vitest.fn(() => "/test/workspace"),
}))

// Mock the StateManager class
const mockStateManager = {
  onProgressUpdate: vitest.fn(),
  getCurrentStatus: vitest.fn(),
  dispose: vitest.fn(),
  setSystemState: vitest.fn(),
  reportBlockIndexingProgress: vitest.fn(),
  reportFileQueueProgress: vitest.fn(),
  state: 'Standby' as any,
}

vitest.mock("../state-manager", () => ({
  CodeIndexStateManager: vitest.fn().mockImplementation(() => mockStateManager),
}))

describe("CodeIndexManager - handleSettingsChange regression", () => {
  let mockDependencies: any
  let manager: CodeIndexManager

  beforeEach(() => {
    // Clear all instances before each test
    try {
      CodeIndexManager.disposeAll()
    } catch (error) {
      // Ignore dispose errors in test setup
      console.warn('Dispose error in test setup:', error)
    }

    // Setup mock dependencies with proper interface
    mockDependencies = {
      fileSystem: {
        readFile: vitest.fn(),
        writeFile: vitest.fn(),
        exists: vitest.fn(),
        mkdir: vitest.fn(),
        stat: vitest.fn(),
      },
      storage: {
        get: vitest.fn(),
        set: vitest.fn(),
        delete: vitest.fn(),
        clear: vitest.fn(),
      },
      eventBus: {
        on: vitest.fn(),
        emit: vitest.fn(),
        once: vitest.fn(),
      },
      workspace: {
        getRootPath: vitest.fn().mockReturnValue("/test/workspace"),
        getRelativePath: vitest.fn(),
        getIgnoreRules: vitest.fn().mockReturnValue([]),
        shouldIgnore: vitest.fn().mockResolvedValue(false),
        getName: vitest.fn().mockReturnValue("test-workspace"),
        getWorkspaceFolders: vitest.fn().mockReturnValue([]),
        findFiles: vitest.fn().mockResolvedValue([]),
      },
      pathUtils: {
        join: vitest.fn(),
        normalize: vitest.fn(),
        isAbsolute: vitest.fn(),
        resolve: vitest.fn(),
        extname: vitest.fn(),
      },
      configProvider: {
        getConfig: vitest.fn(),
        getEmbedderConfig: vitest.fn(),
        getVectorStoreConfig: vitest.fn(),
        isCodeIndexEnabled: vitest.fn(),
        getSearchConfig: vitest.fn(),
        onConfigChange: vitest.fn().mockReturnValue(() => {}),
      },
      logger: {
        debug: vitest.fn(),
        info: vitest.fn(),
        warn: vitest.fn(),
        error: vitest.fn(),
      },
    }

    // Ensure workspace is properly mocked before getInstance
    expect(mockDependencies.workspace).toBeDefined()
    expect(mockDependencies.workspace.getRootPath).toBeDefined()

    manager = CodeIndexManager.getInstance(mockDependencies)!
    expect(manager).toBeDefined()
  })

  afterEach(() => {
    // Clear all instances, handling potential dispose errors
    try {
      CodeIndexManager.disposeAll()
    } catch (error) {
      // Ignore dispose errors in tests
      console.warn('Dispose error in test cleanup:', error)
    }
  })

  describe("handleSettingsChange", () => {
    it("should not throw when called on uninitialized manager (regression test)", async () => {
      // This is the core regression test: handleSettingsChange() should not throw
      // when called before the manager is initialized (during first-time configuration)

      // Ensure manager is not initialized
      expect(manager.isInitialized).toBe(false)

      // Mock a minimal config manager that simulates first-time configuration
      const mockConfigManager = {
        loadConfiguration: vitest.fn().mockResolvedValue({ requiresRestart: true }),
      }
      ;(manager as any)._configManager = mockConfigManager

      // Provide a dummy cache manager so handleSettingsChange doesn't try to
      // construct a real CacheManager from the mocked storage
      ;(manager as any)._cacheManager = {}

      // Stub out service recreation to avoid touching real dependencies
      const recreateSpy = vitest
        .spyOn(manager as any, "_recreateServices")
        .mockResolvedValue(undefined)

      // Mock the feature state to simulate valid configuration that would normally trigger restart
      vitest.spyOn(manager, "isFeatureEnabled", "get").mockReturnValue(true)
      vitest.spyOn(manager, "isFeatureConfigured", "get").mockReturnValue(true)

      // The key test: this should NOT throw "CodeIndexManager not initialized" error
      await expect(manager.handleSettingsChange()).resolves.not.toThrow()

      // Verify that loadConfiguration was called (the method should still work)
      expect(mockConfigManager.loadConfiguration).toHaveBeenCalled()
      // And that service recreation was requested
      expect(recreateSpy).toHaveBeenCalled()
    })

    it("should work normally when manager is initialized", async () => {
      // Mock a complete config manager
      const mockConfigManager = {
        loadConfiguration: vitest.fn().mockResolvedValue({ requiresRestart: true }),
        isFeatureConfigured: true,
        isFeatureEnabled: true,
        getConfig: vitest.fn().mockReturnValue({
          isConfigured: true,
          embedderProvider: "openai",
          modelId: "text-embedding-3-small",
          openAiOptions: { openAiNativeApiKey: "test-key" },
          qdrantUrl: "http://localhost:6333",
          qdrantApiKey: "test-key",
          searchMinScore: 0.4,
        }),
      }
      ;(manager as any)._configManager = mockConfigManager

      // Simulate an initialized manager by setting the required properties
      ;(manager as any)._orchestrator = { stopWatcher: vitest.fn() }
      ;(manager as any)._searchService = {}
      ;(manager as any)._cacheManager = {}

      // Verify manager is considered initialized
      expect(manager.isInitialized).toBe(true)

      // Stub service recreation
      const recreateSpy = vitest
        .spyOn(manager as any, "_recreateServices")
        .mockResolvedValue(undefined)

      // Mock the feature state
      vitest.spyOn(manager, "isFeatureEnabled", "get").mockReturnValue(true)
      vitest.spyOn(manager, "isFeatureConfigured", "get").mockReturnValue(true)

      await manager.handleSettingsChange()

      // Verify that the restart sequence was called
      expect(mockConfigManager.loadConfiguration).toHaveBeenCalled()
      expect(recreateSpy).toHaveBeenCalled()
    })

    it("should handle case when config manager is not set", async () => {
      // Ensure config manager is not set (edge case)
      ;(manager as any)._configManager = undefined

      // This should not throw an error
      await expect(manager.handleSettingsChange()).resolves.not.toThrow()
    })
  })
})
