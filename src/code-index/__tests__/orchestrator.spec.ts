import { vitest, describe, it, expect, beforeEach } from "vitest"
import { CodeIndexOrchestrator } from "../orchestrator"

describe("CodeIndexOrchestrator - error path cleanup gating", () => {
  const workspacePath = "/test/workspace"

  let configManager: any
  let stateManager: any
  let cacheManager: any
  let vectorStore: any
  let scanner: any
  let fileWatcher: any

  beforeEach(() => {
    vitest.clearAllMocks()

    configManager = {
      isFeatureConfigured: true,
    }

    let currentState = "Standby"
    stateManager = {
      get state() {
        return currentState
      },
      setSystemState: vitest.fn().mockImplementation((state: string) => {
        currentState = state
      }),
      reportFileQueueProgress: vitest.fn(),
      reportBlockIndexingProgress: vitest.fn(),
    }

    cacheManager = {
      clearCacheFile: vitest.fn().mockResolvedValue(undefined),
    }

    vectorStore = {
      initialize: vitest.fn(),
      hasIndexedData: vitest.fn(),
      markIndexingIncomplete: vitest.fn(),
      markIndexingComplete: vitest.fn(),
      clearCollection: vitest.fn().mockResolvedValue(undefined),
      deleteCollection: vitest.fn(),
    }

    scanner = {
      scanDirectory: vitest.fn(),
    }

    fileWatcher = {
      initialize: vitest.fn().mockResolvedValue(undefined),
      onDidStartBatchProcessing: vitest.fn().mockReturnValue(() => {}),
      onBatchProgressBlocksUpdate: vitest.fn().mockReturnValue(() => {}),
      onDidFinishBatchProcessing: vitest.fn().mockReturnValue(() => {}),
      dispose: vitest.fn(),
    }
  })

  it("does not clear collection or cache when initialize() fails before indexing starts", async () => {
    vectorStore.initialize.mockRejectedValue(new Error("Qdrant unreachable"))

    const orchestrator = new CodeIndexOrchestrator(
      configManager,
      stateManager,
      workspacePath,
      cacheManager,
      vectorStore,
      scanner,
      fileWatcher,
    )

    await orchestrator.startIndexing()

    expect(vectorStore.clearCollection).not.toHaveBeenCalled()
    expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()

    expect(stateManager.setSystemState).toHaveBeenCalled()
    const calls = (stateManager.setSystemState as any).mock.calls
    const lastCall = calls[calls.length - 1]
    expect(lastCall[0]).toBe("Error")
  })

  it("clears collection and cache when an error occurs after initialize() succeeds", async () => {
    vectorStore.initialize.mockResolvedValue(false)
    vectorStore.hasIndexedData.mockResolvedValue(false)
    vectorStore.markIndexingIncomplete.mockRejectedValue(new Error("mark incomplete failure"))

    const orchestrator = new CodeIndexOrchestrator(
      configManager,
      stateManager,
      workspacePath,
      cacheManager,
      vectorStore,
      scanner,
      fileWatcher,
    )

    await orchestrator.startIndexing()

    expect(vectorStore.clearCollection).toHaveBeenCalledTimes(1)
    expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(1)

    expect(stateManager.setSystemState).toHaveBeenCalled()
    const calls = (stateManager.setSystemState as any).mock.calls
    const lastCall = calls[calls.length - 1]
    expect(lastCall[0]).toBe("Error")
  })
})
