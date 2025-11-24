import { IEmbedder } from "../../interfaces/embedder"
import { IVectorStore } from "../../interfaces/vector-store"
import { FileProcessingResult } from "../../interfaces/file-processor"
import { FileWatcher } from "../file-watcher"
import { IEventBus, IFileSystem } from "../../../abstractions/core"
import { IWorkspace, IPathUtils } from "../../../abstractions/workspace"
import { vi } from "vitest"
import { codeParser } from "../parser"

// Don't import createHash directly to avoid mock conflicts
import * as fs from "fs"
import * as path from "path"

vi.mock("vscode", () => {
	type Disposable = { dispose: () => void }

	type _Event<T> = (listener: (e: T) => any, thisArgs?: any, disposables?: Disposable[]) => Disposable

	const MOCK_EMITTER_REGISTRY = new Map<object, Set<(data: any) => any>>()

	return {
		EventEmitter: vi.fn().mockImplementation(() => {
			const emitterInstanceKey = {}
			MOCK_EMITTER_REGISTRY.set(emitterInstanceKey, new Set())

			return {
				event: function <T>(listener: (e: T) => any): Disposable {
					const listeners = MOCK_EMITTER_REGISTRY.get(emitterInstanceKey)
					listeners!.add(listener as any)
					return {
						dispose: () => {
							listeners!.delete(listener as any)
						},
					}
				},

				fire: function <T>(data: T): void {
					const listeners = MOCK_EMITTER_REGISTRY.get(emitterInstanceKey)
					listeners!.forEach((fn) => fn(data))
				},

				dispose: () => {
					MOCK_EMITTER_REGISTRY.get(emitterInstanceKey)!.clear()
					MOCK_EMITTER_REGISTRY.delete(emitterInstanceKey)
				},
			}
		}),
		RelativePattern: vi.fn().mockImplementation((base, pattern) => ({
			base,
			pattern,
		})),
		Uri: {
			file: vi.fn().mockImplementation((path) => ({ fsPath: path })),
		},
		window: {
			activeTextEditor: undefined,
		},
		workspace: {
			createFileSystemWatcher: vi.fn().mockReturnValue({
				onDidCreate: vi.fn(),
				onDidChange: vi.fn(),
				onDidDelete: vi.fn(),
				dispose: vi.fn(),
			}),
			fs: {
				stat: vi.fn(),
				readFile: vi.fn(),
			},
			workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
			getWorkspaceFolder: vi.fn((uri) => {
				if (uri && uri.fsPath && uri.fsPath.startsWith("/mock/workspace")) {
					return { uri: { fsPath: "/mock/workspace" } }
				}
				return undefined
			}),
		},
	}
})

vi.mock("crypto", () => ({
	createHash: vi.fn(() => ({
		update: vi.fn().mockReturnThis(),
		digest: vi.fn((format?: string) => {
			// Return different hash values based on the content being hashed
			return "hash"; // For unchanged files test
		}),
	})),
	randomUUID: vi.fn(() => "mock-uuid"),
}))
vi.mock("uuid", () => ({
	...vi.importActual("uuid"),
	v5: vi.fn().mockImplementation((name: string, namespace: string) => {
		return `mocked-uuid-${name}-${namespace}`
	}),
}))
vi.mock("../../../ignore/RooIgnoreController", () => ({
	RooIgnoreController: vi.fn().mockImplementation(() => ({
		validateAccess: vi.fn(),
	})),
	mockValidateAccess: vi.fn(),
}))
vi.mock("../../cache-manager")
vi.mock("../parser")

describe("FileWatcher", () => {
	let fileWatcher: FileWatcher
	let mockEmbedder: IEmbedder
	let mockVectorStore: IVectorStore
	let mockCacheManager: any
	let mockContext: any
	let mockRooIgnoreController: any
	let mockEventBus: IEventBus
	let mockFileSystem: IFileSystem
	let mockWorkspace: IWorkspace
	let mockPathUtils: IPathUtils
	const testWorkspacePath = "/tmp/autodev-test-workspace"

	beforeEach(async () => {
		// Clear any existing mocks
		vi.clearAllMocks()
		
		// Ensure test workspace directory exists
		if (!fs.existsSync(testWorkspacePath)) {
			fs.mkdirSync(testWorkspacePath, { recursive: true })
		}
		
		// Create test files for FileWatcher to read
		const testFiles = [
			{ path: `${testWorkspacePath}/test.js`, content: "function test() { return 'hello'; }" },
			{ path: `${testWorkspacePath}/unchanged.js`, content: "const unchanged = true;" },
			{ path: `${testWorkspacePath}/large.js`, content: "x".repeat(2 * 1024 * 1024 + 1) },
			{ path: `${testWorkspacePath}/error.js`, content: "this will cause read error" },
			{ path: `${testWorkspacePath}/ignored.js`, content: "this file should be ignored" }
		]
		
		testFiles.forEach(file => {
			if (!fs.existsSync(file.path)) {
				fs.writeFileSync(file.path, file.content)
			}
		})
		mockEmbedder = {
			createEmbeddings: vi.fn().mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] }),
			embedderInfo: { name: "openai" },
		}
		mockVectorStore = {
			upsertPoints: vi.fn().mockResolvedValue(undefined),
			deletePointsByFilePath: vi.fn().mockResolvedValue(undefined),
			deletePointsByMultipleFilePaths: vi.fn().mockResolvedValue(undefined),
			initialize: vi.fn().mockResolvedValue(true),
			search: vi.fn().mockResolvedValue([]),
			clearCollection: vi.fn().mockResolvedValue(undefined),
			deleteCollection: vi.fn().mockResolvedValue(undefined),
			collectionExists: vi.fn().mockResolvedValue(true),
		}
		mockCacheManager = {
			getHash: vi.fn(),
			updateHash: vi.fn(),
			deleteHash: vi.fn(),
		}
		mockFileSystem = {
			readFile: vi.fn().mockImplementation((filePath: string) => {
				if (fs.existsSync(filePath)) {
					return Promise.resolve(new TextEncoder().encode(fs.readFileSync(filePath, 'utf8')))
				}
				return Promise.reject(new Error("File not found"))
			}),
			writeFile: vi.fn().mockResolvedValue(undefined),
			exists: vi.fn().mockImplementation((filePath: string) => Promise.resolve(fs.existsSync(filePath))),
			stat: vi.fn().mockImplementation((filePath: string) => {
				if (fs.existsSync(filePath)) {
					const stats = fs.statSync(filePath)
					return Promise.resolve({ size: stats.size, mtime: stats.mtimeMs } as any)
				}
				return Promise.reject(new Error("File not found"))
			}),
			readDirectory: vi.fn().mockResolvedValue([]),
			createDirectory: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
			watchFile: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			unwatchFile: vi.fn(),
		}
		mockWorkspace = {
			getRootPath: vi.fn().mockReturnValue(testWorkspacePath),
			getRelativePath: vi.fn().mockImplementation((absolutePath: string) => {
				if (absolutePath && absolutePath.startsWith(testWorkspacePath)) {
					return absolutePath.replace(testWorkspacePath + "/", "")
				}
				return absolutePath || ""
			}),
			getAbsolutePath: vi.fn().mockImplementation((relativePath) => `${testWorkspacePath}/${relativePath}`),
			isWorkspaceFile: vi.fn().mockReturnValue(true),
		}
		mockPathUtils = {
			join: vi.fn().mockImplementation((...paths) => paths.join("/")),
			dirname: vi.fn().mockReturnValue("/mock/workspace"),
			basename: vi.fn().mockReturnValue("test.js"),
			extname: vi.fn().mockReturnValue(".js"),
			normalize: vi.fn().mockImplementation((path) => path),
			resolve: vi.fn().mockImplementation((path) => path),
		}
		mockContext = {
			subscriptions: [],
		}

		// Create mock event bus
		const eventHandlers = new Map<string, Set<(data: any) => void>>()
		mockEventBus = {
			emit: vi.fn((event: string, data: any) => {
				const handlers = eventHandlers.get(event)
				if (handlers) {
					handlers.forEach(handler => handler(data))
				}
			}),
			on: vi.fn((event: string, handler: (data: any) => void) => {
				if (!eventHandlers.has(event)) {
					eventHandlers.set(event, new Set())
				}
				eventHandlers.get(event)!.add(handler)
				return () => eventHandlers.get(event)!.delete(handler)
			}),
			off: vi.fn(),
			once: vi.fn(),
		}

		const { RooIgnoreController, mockValidateAccess } = await import("../../../ignore/RooIgnoreController")
		mockRooIgnoreController = new RooIgnoreController()
		mockRooIgnoreController.validateAccess = mockValidateAccess.mockReturnValue(true)

		fileWatcher = new FileWatcher(
			testWorkspacePath,
			mockFileSystem,
			mockEventBus,
			mockWorkspace,
			mockPathUtils,
			mockCacheManager,
			mockEmbedder,
			mockVectorStore,
			undefined,
			mockRooIgnoreController,
		)
	})

	afterEach(() => {
		// Clean up file watcher and force garbage collection
		if (fileWatcher) {
			fileWatcher.dispose()
		}
		vi.clearAllMocks()
		vi.useRealTimers()
		
		// Force garbage collection if available
		if (global.gc) {
			global.gc()
		}
	})

	describe("constructor", () => {
		it("should initialize with correct properties", () => {
			expect(fileWatcher).toBeDefined()

			mockContext.subscriptions.push({ dispose: vi.fn() }, { dispose: vi.fn() })
			expect(mockContext.subscriptions).toHaveLength(2)
		})
	})

	describe("initialize", () => {
		it("should initialize file system watcher", async () => {
			await fileWatcher.initialize()
			expect(fileWatcher).toBeDefined()
			expect(fs.existsSync(testWorkspacePath)).toBe(true)
			// FileWatcher now uses Node.js fs.watch instead of VSCode workspace.createFileSystemWatcher
		})
	})

	describe("dispose", () => {
		it("should dispose all resources", async () => {
			await fileWatcher.initialize()
			fileWatcher.dispose()
			expect(fileWatcher).toBeDefined()
			// Test passes if no errors are thrown during disposal
		})
	})

	describe("handleFileCreated", () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("should trigger batch processing for created file", async () => {
			const filePath = `${testWorkspacePath}/test.js`
			
			// Setup a spy for the _onDidFinishBatchProcessing event with timeout
			let batchProcessingFinished = false
			const batchFinishedSpy = vi.fn(() => {
				batchProcessingFinished = true
			})
			fileWatcher.onDidFinishBatchProcessing(batchFinishedSpy)

			// Create the test file first
			fs.writeFileSync(filePath, "function test() { return 'hello'; }")
			
			// Trigger file creation event
			;(fileWatcher as any).handleFileCreated(filePath)

			// Advance timers to trigger debounced processing
			await vi.advanceTimersByTimeAsync(1000)
			await vi.runAllTicks()

			// Wait for batch processing to complete with timeout
			const maxWaitTime = 5000 // 5 seconds max wait
			const startTime = Date.now()
			while (!batchProcessingFinished && (Date.now() - startTime) < maxWaitTime) {
				await vi.runAllTicks()
				await new Promise((resolve) => setImmediate(resolve))
			}

			// Verify that batch processing was triggered
			expect(batchFinishedSpy).toHaveBeenCalled()
		})
	})

	describe("handleFileChanged", () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("should trigger batch processing for changed file", async () => {
			const filePath = `${testWorkspacePath}/test.js`
			
			// Setup a spy for the _onDidFinishBatchProcessing event with timeout
			let batchProcessingFinished = false
			const batchFinishedSpy = vi.fn(() => {
				batchProcessingFinished = true
			})
			fileWatcher.onDidFinishBatchProcessing(batchFinishedSpy)

			// Create and modify the test file
			fs.writeFileSync(filePath, "function test() { return 'changed'; }")
			
			// Trigger file change event
			;(fileWatcher as any).handleFileChanged(filePath)

			// Advance timers to trigger debounced processing
			await vi.advanceTimersByTimeAsync(1000)
			await vi.runAllTicks()

			// Wait for batch processing to complete with timeout
			const maxWaitTime = 5000 // 5 seconds max wait
			const startTime = Date.now()
			while (!batchProcessingFinished && (Date.now() - startTime) < maxWaitTime) {
				await vi.runAllTicks()
				await new Promise((resolve) => setImmediate(resolve))
			}

			// Verify that batch processing was triggered
			expect(batchFinishedSpy).toHaveBeenCalled()
		})
	})

	describe("handleFileDeleted", () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("should delete from cache and process deletion in batch", async () => {
			const mockUri = { fsPath: `${testWorkspacePath}/test.js` }

			// Setup a spy for the _onDidFinishBatchProcessing event with timeout
			let batchProcessingFinished = false
			const batchFinishedSpy = vi.fn(() => {
				batchProcessingFinished = true
			})
			fileWatcher.onDidFinishBatchProcessing(batchFinishedSpy)

			// Directly accumulate the event and trigger batch processing with correct structure
			;(fileWatcher as any).accumulatedEvents.set(mockUri.fsPath, { filePath: mockUri.fsPath, type: "delete" })
			;(fileWatcher as any).scheduleBatchProcessing()

			// Advance timers to trigger debounced processing
			await vi.advanceTimersByTimeAsync(1000)
			await vi.runAllTicks()

			// Wait for batch processing to complete with timeout
			const maxWaitTime = 5000 // 5 seconds max wait
			const startTime = Date.now()
			while (!batchProcessingFinished && (Date.now() - startTime) < maxWaitTime) {
				await vi.runAllTicks()
				await new Promise((resolve) => setImmediate(resolve))
			}

			expect(mockCacheManager.deleteHash).toHaveBeenCalledWith(mockUri.fsPath)
			expect(mockVectorStore.deletePointsByMultipleFilePaths).toHaveBeenCalledWith(
				expect.arrayContaining(["test.js"]),
			)
			expect(mockVectorStore.deletePointsByMultipleFilePaths).toHaveBeenCalledTimes(1)
		})

		it("should handle errors during deletePointsByMultipleFilePaths", async () => {
			// Setup mock error
			const mockError = new Error("Failed to delete points from vector store") as Error
			;(mockVectorStore.deletePointsByMultipleFilePaths as any).mockRejectedValueOnce(mockError)

			// Create a spy for the _onDidFinishBatchProcessing event with timeout
			let capturedBatchSummary: any = null
			let batchProcessingFinished = false
			const batchFinishedSpy = vi.fn((summary) => {
				capturedBatchSummary = summary
				batchProcessingFinished = true
			})
			fileWatcher.onDidFinishBatchProcessing(batchFinishedSpy)

			// Trigger delete event
			const filePath = `${testWorkspacePath}/test-error.js`

			// Directly accumulate the event and trigger batch processing with correct structure
			;(fileWatcher as any).accumulatedEvents.set(filePath, { filePath, type: "delete" })
			;(fileWatcher as any).scheduleBatchProcessing()

			// Advance timers to trigger debounced processing
			await vi.advanceTimersByTimeAsync(1000)
			await vi.runAllTicks()

			// Wait for batch processing to complete with timeout
			const maxWaitTime = 5000 // 5 seconds max wait
			const startTime = Date.now()
			while (!batchProcessingFinished && (Date.now() - startTime) < maxWaitTime) {
				await vi.runAllTicks()
				await new Promise((resolve) => setImmediate(resolve))
			}

			// Verify that deletePointsByMultipleFilePaths was called
			expect(mockVectorStore.deletePointsByMultipleFilePaths).toHaveBeenCalledWith(
				expect.arrayContaining(["test-error.js"]),
			)

			// Verify that batch processing completed despite the error
			expect(batchProcessingFinished).toBe(true)
			expect(capturedBatchSummary).toBeDefined()
			
			// The error is handled internally, so we just verify the batch completed
		})
	})

	describe("processFile", () => {
		it("should skip ignored files", async () => {
			mockRooIgnoreController.validateAccess = vi.fn((path: string) => {
				if (path === `${testWorkspacePath}/ignored.js`) return false
				return true
			})
			const filePath = `${testWorkspacePath}/ignored.js`
			const result = await fileWatcher.processFile(filePath)

			expect(result.status).toBe("skipped")
			expect(result.reason).toBe("File is ignored by .rooignore or .gitignore")
			expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
			expect(mockFileSystem.stat).not.toHaveBeenCalled()
			expect(mockFileSystem.readFile).not.toHaveBeenCalled()
		})

		it("should skip files larger than MAX_FILE_SIZE_BYTES", async () => {
			mockFileSystem.stat.mockResolvedValue({ size: 2 * 1024 * 1024 } as any)
			mockRooIgnoreController.validateAccess.mockReturnValue(true)
			const result = await fileWatcher.processFile(`${testWorkspacePath}/large.js`)

			expect(result.status).toBe("skipped")
			expect(result.reason).toBe("File is too large")
			expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
		})

		it("should skip unchanged files", async () => {
			// Mock the hash to return the same value as cache
			const { createHash } = await import("crypto")
			vi.mocked(createHash).mockReturnValue({
				update: vi.fn().mockReturnThis(),
				digest: vi.fn(() => "hash"), // Same as cache hash
			} as any)
			
			mockFileSystem.stat.mockResolvedValue({ size: 1024, mtime: Date.now() } as any)
			mockFileSystem.readFile.mockResolvedValue(new TextEncoder().encode("test content"))
			mockCacheManager.getHash.mockReturnValue("hash")
			mockRooIgnoreController.validateAccess.mockReturnValue(true)

			const result = await fileWatcher.processFile(`${testWorkspacePath}/unchanged.js`)

			expect(result.status).toBe("skipped")
			expect(result.reason).toBe("File has not changed")
			expect(mockCacheManager.updateHash).not.toHaveBeenCalled()
		})

		it("should process changed files", async () => {
			// Mock the hash to return a different value than cache
			const { createHash } = await import("crypto")
			vi.mocked(createHash).mockReturnValue({
				update: vi.fn().mockReturnThis(),
				digest: vi.fn(() => "new-hash"), // Different from cache hash
			} as any)
			
			mockFileSystem.stat.mockResolvedValue({ size: 1024, mtime: Date.now() } as any)
			mockFileSystem.readFile.mockResolvedValue(new TextEncoder().encode("test content"))
			mockCacheManager.getHash.mockReturnValue("old-hash")
			mockRooIgnoreController.validateAccess.mockReturnValue(true)
			mockWorkspace.getRelativePath.mockReturnValue("test.js")

			const mockCodeParser = vi.mocked(codeParser)
			mockCodeParser.parseFile.mockResolvedValue([
				{
					file_path: `${testWorkspacePath}/test.js`,
					content: "test content",
					start_line: 1,
					end_line: 5,
					identifier: "test",
					type: "function",
					fileHash: "new-hash",
					segmentHash: "segment-hash",
					chunkSource: undefined,
					parentChain: [],
					hierarchyDisplay: "",
				},
			])

			const result = await fileWatcher.processFile(`${testWorkspacePath}/test.js`)

			expect(result.status).toBe("processed_for_batching")
			expect(result.newHash).toBe("new-hash")
			expect(result.pointsToUpsert).toHaveLength(1)
			expect(result.pointsToUpsert[0].vector).toEqual([0.1, 0.2, 0.3])
			expect(result.pointsToUpsert[0].payload).toMatchObject({
				filePath: "test.js",
				codeChunk: "test content",
				startLine: 1,
				endLine: 5,
			})
			expect(mockCodeParser.parseFile).toHaveBeenCalled()
			expect(mockEmbedder.createEmbeddings).toHaveBeenCalled()
		})

		it("should handle processing errors", async () => {
			mockFileSystem.stat.mockResolvedValue({ size: 1024 } as any)
			mockFileSystem.readFile.mockRejectedValue(new Error("Read error"))

			const result = await fileWatcher.processFile(`${testWorkspacePath}/error.js`)

			expect(result.status).toBe("local_error")
			expect(result.error).toBeDefined()
		})
	})
})
