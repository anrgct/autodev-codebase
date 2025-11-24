import { vitest, describe, it, expect, beforeEach, vi } from "vitest"
import { RooIgnoreController, LOCK_TEXT_SYMBOL } from "../RooIgnoreController"
import * as path from "path"
import type { IFileSystem, IWorkspace, IPathUtils, IFileWatcher } from "../../abstractions"

describe("RooIgnoreController", () => {
	const TEST_CWD = "/test/path"
	let controller: RooIgnoreController
	let mockFileSystem: vi.Mocked<IFileSystem>
	let mockWorkspace: vi.Mocked<IWorkspace>
	let mockPathUtils: vi.Mocked<IPathUtils>
	let mockFileWatcher: vi.Mocked<IFileWatcher>

	beforeEach(() => {
		// Reset mocks
		vitest.clearAllMocks()

		// Setup mock file system
		mockFileSystem = {
			readFile: vi.fn(),
			writeFile: vi.fn(),
			exists: vi.fn(),
			stat: vi.fn(),
			readdir: vi.fn(),
			mkdir: vi.fn(),
			delete: vi.fn(),
		}

		// Setup mock workspace
		mockWorkspace = {
			getRootPath: vi.fn().mockReturnValue(TEST_CWD),
			getRelativePath: vi.fn(),
			getIgnoreRules: vi.fn().mockReturnValue([]),
			shouldIgnore: vi.fn().mockResolvedValue(false),
			getName: vi.fn().mockReturnValue("test-workspace"),
			getWorkspaceFolders: vi.fn().mockReturnValue([]),
			findFiles: vi.fn().mockResolvedValue([]),
		}

		// Setup mock path utils
		mockPathUtils = {
			join: vi.fn().mockImplementation((...paths) => path.join(...paths)),
			dirname: vi.fn().mockImplementation((p) => path.dirname(p)),
			basename: vi.fn().mockImplementation((p, ext) => path.basename(p, ext)),
			extname: vi.fn().mockImplementation((p) => path.extname(p)),
			resolve: vi.fn().mockImplementation((...paths) => path.resolve(...paths)),
			isAbsolute: vi.fn().mockImplementation((p) => path.isAbsolute(p)),
			relative: vi.fn().mockImplementation((from, to) => path.relative(from, to)),
			normalize: vi.fn().mockImplementation((p) => path.normalize(p)),
		}

		// Setup mock file watcher
		mockFileWatcher = {
			watchFile: vi.fn().mockReturnValue(vi.fn()),
			watchDirectory: vi.fn().mockReturnValue(vi.fn()),
		}

		// Create controller
		controller = new RooIgnoreController(mockFileSystem, mockWorkspace, mockPathUtils, mockFileWatcher)
	})

	describe("initialization", () => {
		/**
		 * Tests the controller initialization when .rooignore exists
		 */
		it("should load .rooignore patterns on initialization when file exists", async () => {
			// Setup mocks to simulate existing .rooignore file
			mockFileSystem.readFile.mockResolvedValue(new TextEncoder().encode("node_modules\n.git\nsecrets.json"))

			// Initialize controller
			await controller.initialize()

			// Verify file was read
			const rooignorePath = path.join(TEST_CWD, ".rooignore")
			expect(mockFileSystem.readFile).toHaveBeenCalledWith(rooignorePath)

			// Verify content was stored
			expect(controller.rooIgnoreContent).toBe("node_modules\n.git\nsecrets.json")

			// Test that ignore patterns were applied - setup getRelativePath mock
			mockWorkspace.getRelativePath.mockImplementation((fullPath) => {
				if (fullPath.startsWith(TEST_CWD)) {
					return path.relative(TEST_CWD, fullPath)
				}
				return fullPath
			})

			expect(controller.validateAccess("node_modules/package.json")).toBe(false)
			expect(controller.validateAccess("src/app.ts")).toBe(true)
			expect(controller.validateAccess(".git/config")).toBe(false)
			expect(controller.validateAccess("secrets.json")).toBe(false)
		})

		/**
		 * Tests the controller behavior when .rooignore doesn't exist
		 */
		it("should allow all access when .rooignore doesn't exist", async () => {
			// Setup mocks to simulate missing .rooignore file
			mockFileSystem.readFile.mockRejectedValue(new Error("File not found"))

			// Initialize controller
			await controller.initialize()

			// Verify no content was stored
			expect(controller.rooIgnoreContent).toBeUndefined()

			// All files should be accessible
			expect(controller.validateAccess("node_modules/package.json")).toBe(true)
			expect(controller.validateAccess("secrets.json")).toBe(true)
		})

		/**
		 * Tests the file watcher setup
		 */
		it("should set up file watcher for .rooignore changes", async () => {
			// Initialize controller
			await controller.initialize()

			// Check that watcher was created with correct pattern
			const rooignorePath = path.join(TEST_CWD, ".rooignore")
			expect(mockFileWatcher.watchFile).toHaveBeenCalledWith(rooignorePath, expect.any(Function))
		})

		/**
		 * Tests error handling during initialization
		 */
		it("should handle errors when loading .rooignore", async () => {
			// Setup mocks to simulate error during readFile
			const testError = new Error("File system error")
			mockFileSystem.readFile.mockRejectedValue(testError)

			// Spy on console.error to capture any logged errors
			const consoleSpy = vitest.spyOn(console, "error").mockImplementation()

			// Initialize controller - shouldn't throw even if readFile fails
			await controller.initialize()

			// Controller should still be functional even if .rooignore couldn't be loaded
			expect(controller.rooIgnoreContent).toBeUndefined()
			expect(controller.validateAccess("node_modules/package.json")).toBe(true)
			expect(controller.validateAccess("src/app.ts")).toBe(true)

			// The implementation treats file reading errors as expected (file doesn't exist)
			// so no error should be logged for this case
			expect(consoleSpy).not.toHaveBeenCalled()

			// Cleanup
			consoleSpy.mockRestore()
		})
	})

	describe("validateAccess", () => {
		beforeEach(async () => {
			// Setup .rooignore content
			mockFileSystem.readFile.mockResolvedValue(new TextEncoder().encode("node_modules\n.git\nsecrets/**\n*.log"))

			// Setup getRelativePath mock
			mockWorkspace.getRelativePath.mockImplementation((fullPath) => {
				if (fullPath.startsWith(TEST_CWD)) {
					return path.relative(TEST_CWD, fullPath)
				}
				return fullPath
			})

			await controller.initialize()
		})

		/**
		 * Tests basic path validation
		 */
		it("should correctly validate file access based on ignore patterns", () => {
			// Test different path patterns
			expect(controller.validateAccess("node_modules/package.json")).toBe(false)
			expect(controller.validateAccess("node_modules")).toBe(false)
			expect(controller.validateAccess("src/node_modules/file.js")).toBe(false)
			expect(controller.validateAccess(".git/HEAD")).toBe(false)
			expect(controller.validateAccess("secrets/api-keys.json")).toBe(false)
			expect(controller.validateAccess("logs/app.log")).toBe(false)

			// These should be allowed
			expect(controller.validateAccess("src/app.ts")).toBe(true)
			expect(controller.validateAccess("package.json")).toBe(true)
			expect(controller.validateAccess("secret-file.json")).toBe(true)
		})

		/**
		 * Tests handling of absolute paths
		 */
		it("should handle absolute paths correctly", () => {
			// Test with absolute paths
			const absolutePath = path.join(TEST_CWD, "node_modules/package.json")
			expect(controller.validateAccess(absolutePath)).toBe(false)

			const allowedAbsolutePath = path.join(TEST_CWD, "src/app.ts")
			expect(controller.validateAccess(allowedAbsolutePath)).toBe(true)
		})

		/**
		 * Tests handling of paths outside cwd
		 */
		it("should allow access to paths outside cwd", () => {
			// Path traversal outside cwd
			expect(controller.validateAccess("../outside-project/file.txt")).toBe(true)

			// Completely different path
			expect(controller.validateAccess("/etc/hosts")).toBe(true)
		})

		/**
		 * Tests the default behavior when no .rooignore exists
		 */
		it("should allow all access when no .rooignore content", async () => {
			// Create a new controller with no .rooignore
			mockFileSystem.readFile.mockRejectedValue(new Error("File not found"))
			const emptyController = new RooIgnoreController(mockFileSystem, mockWorkspace, mockPathUtils, mockFileWatcher)
			await emptyController.initialize()

			// All paths should be allowed
			expect(emptyController.validateAccess("node_modules/package.json")).toBe(true)
			expect(emptyController.validateAccess("secrets/api-keys.json")).toBe(true)
			expect(emptyController.validateAccess(".git/HEAD")).toBe(true)
		})
	})

	describe("validateCommand", () => {
		beforeEach(async () => {
			// Setup .rooignore content
			mockFileSystem.readFile.mockResolvedValue(new TextEncoder().encode("node_modules\n.git\nsecrets/**\n*.log"))

			// Setup getRelativePath mock
			mockWorkspace.getRelativePath.mockImplementation((fullPath) => {
				if (fullPath.startsWith(TEST_CWD)) {
					return path.relative(TEST_CWD, fullPath)
				}
				return fullPath
			})

			await controller.initialize()
		})

		/**
		 * Tests validation of file reading commands
		 */
		it("should block file reading commands accessing ignored files", () => {
			// Cat command accessing ignored file
			expect(controller.validateCommand("cat node_modules/package.json")).toBe("node_modules/package.json")

			// Grep command accessing ignored file
			expect(controller.validateCommand("grep pattern .git/config")).toBe(".git/config")

			// Commands accessing allowed files should return undefined
			expect(controller.validateCommand("cat src/app.ts")).toBeUndefined()
			expect(controller.validateCommand("less README.md")).toBeUndefined()
		})

		/**
		 * Tests commands with various arguments and flags
		 */
		it("should handle command arguments and flags correctly", () => {
			// Command with flags
			expect(controller.validateCommand("cat -n node_modules/package.json")).toBe("node_modules/package.json")

			// Command with multiple files (only first ignored file is returned)
			expect(controller.validateCommand("grep pattern src/app.ts node_modules/index.js")).toBe(
				"node_modules/index.js",
			)

			// Command with PowerShell parameter style
			expect(controller.validateCommand("Get-Content -Path secrets/api-keys.json")).toBe("secrets/api-keys.json")

			// Arguments with colons are skipped due to the implementation
			// Adjust test to match actual implementation which skips arguments with colons
			expect(controller.validateCommand("Select-String -Path secrets/api-keys.json -Pattern key")).toBe(
				"secrets/api-keys.json",
			)
		})

		/**
		 * Tests validation of non-file-reading commands
		 */
		it("should allow non-file-reading commands", () => {
			// Commands that don't access files directly
			expect(controller.validateCommand("ls -la")).toBeUndefined()
			expect(controller.validateCommand("echo 'Hello'")).toBeUndefined()
			expect(controller.validateCommand("cd node_modules")).toBeUndefined()
			expect(controller.validateCommand("npm install")).toBeUndefined()
		})

		/**
		 * Tests behavior when no .rooignore exists
		 */
		it("should allow all commands when no .rooignore exists", async () => {
			// Create a new controller with no .rooignore
			mockFileSystem.readFile.mockRejectedValue(new Error("File not found"))
			const emptyController = new RooIgnoreController(mockFileSystem, mockWorkspace, mockPathUtils, mockFileWatcher)
			await emptyController.initialize()

			// All commands should be allowed
			expect(emptyController.validateCommand("cat node_modules/package.json")).toBeUndefined()
			expect(emptyController.validateCommand("grep pattern .git/config")).toBeUndefined()
		})
	})

	describe("filterPaths", () => {
		beforeEach(async () => {
			// Setup .rooignore content
			mockFileSystem.readFile.mockResolvedValue(new TextEncoder().encode("node_modules\n.git\nsecrets/**\n*.log"))

			// Setup getRelativePath mock
			mockWorkspace.getRelativePath.mockImplementation((fullPath) => {
				if (fullPath.startsWith(TEST_CWD)) {
					return path.relative(TEST_CWD, fullPath)
				}
				return fullPath
			})

			await controller.initialize()
		})

		/**
		 * Tests filtering an array of paths
		 */
		it("should filter out ignored paths from an array", () => {
			const paths = [
				"src/app.ts",
				"node_modules/package.json",
				"README.md",
				".git/HEAD",
				"secrets/keys.json",
				"build/app.js",
				"logs/error.log",
			]

			const filtered = controller.filterPaths(paths)

			// Expected filtered result
			expect(filtered).toEqual(["src/app.ts", "README.md", "build/app.js"])

			// Length should be reduced
			expect(filtered.length).toBe(3)
		})

		/**
		 * Tests error handling in filterPaths
		 */
		it("should handle errors in filterPaths and fail closed", () => {
			// Mock validateAccess to throw an error
			vitest.spyOn(controller, "validateAccess").mockImplementation(() => {
				throw new Error("Test error")
			})

			// Spy on console.error
			const consoleSpy = vitest.spyOn(console, "error").mockImplementation()

			// Should return empty array on error (fail closed)
			const result = controller.filterPaths(["file1.txt", "file2.txt"])
			expect(result).toEqual([])

			// Verify error was logged
			expect(consoleSpy).toHaveBeenCalledWith("Error filtering paths:", expect.any(Error))

			// Cleanup
			consoleSpy.mockRestore()
		})

		/**
		 * Tests empty array handling
		 */
		it("should handle empty arrays", () => {
			const result = controller.filterPaths([])
			expect(result).toEqual([])
		})
	})

	describe("getInstructions", () => {
		/**
		 * Tests instructions generation with .rooignore
		 */
		it("should generate formatted instructions when .rooignore exists", async () => {
			// Setup .rooignore content
			mockFileSystem.readFile.mockResolvedValue(new TextEncoder().encode("node_modules\n.git\nsecrets/**"))
			await controller.initialize()

			const instructions = controller.getInstructions()

			// Verify instruction format
			expect(instructions).toContain("# .rooignore")
			expect(instructions).toContain(LOCK_TEXT_SYMBOL)
			expect(instructions).toContain("node_modules")
			expect(instructions).toContain(".git")
			expect(instructions).toContain("secrets/**")
		})

		/**
		 * Tests behavior when no .rooignore exists
		 */
		it("should return undefined when no .rooignore exists", async () => {
			// Setup no .rooignore
			mockFileSystem.readFile.mockRejectedValue(new Error("File not found"))
			await controller.initialize()

			const instructions = controller.getInstructions()
			expect(instructions).toBeUndefined()
		})
	})

	describe("dispose", () => {
		/**
		 * Tests proper cleanup of resources
		 */
		it("should dispose all registered disposables", () => {
			// The implementation uses cleanupFunctions array, not disposables
			const cleanupSpy1 = vi.fn()
			const cleanupSpy2 = vi.fn()
			const cleanupSpy3 = vi.fn()

			// Access private property to test cleanup
			;(controller as any).cleanupFunctions = [cleanupSpy1, cleanupSpy2, cleanupSpy3]

			// Call dispose
			controller.dispose()

			// Verify all cleanup functions were called
			expect(cleanupSpy1).toHaveBeenCalledTimes(1)
			expect(cleanupSpy2).toHaveBeenCalledTimes(1)
			expect(cleanupSpy3).toHaveBeenCalledTimes(1)

			// Verify cleanup functions array was cleared
			expect((controller as any).cleanupFunctions).toEqual([])
		})
	})

	describe("file watcher", () => {
		/**
		 * Tests behavior when .rooignore is created
		 */
		it("should reload .rooignore when file is created", async () => {
			// Setup initial state without .rooignore
			mockFileSystem.readFile.mockRejectedValue(new Error("File not found"))
			await controller.initialize()

			// Verify initial state
			expect(controller.rooIgnoreContent).toBeUndefined()
			expect(controller.validateAccess("node_modules/package.json")).toBe(true)

			// Setup getRelativePath mock
			mockWorkspace.getRelativePath.mockImplementation((fullPath) => {
				if (fullPath.startsWith(TEST_CWD)) {
					return path.relative(TEST_CWD, fullPath)
				}
				return fullPath
			})

			// Now simulate file creation by finding the watch callback
			const rooignorePath = path.join(TEST_CWD, ".rooignore")
			const watchCallback = mockFileWatcher.watchFile.mock.calls[0][1]

			// Update mock to return file content
			mockFileSystem.readFile.mockResolvedValue(new TextEncoder().encode("node_modules"))

			// Simulate file change event
			watchCallback({ type: 'created', uri: rooignorePath })

			// Wait a bit for async operation to complete
			await new Promise(resolve => setTimeout(resolve, 10))

			// Now verify content was updated
			expect(controller.rooIgnoreContent).toBe("node_modules")
			expect(controller.validateAccess("node_modules/package.json")).toBe(false)
		})

		/**
		 * Tests behavior when .rooignore is changed
		 */
		it("should reload .rooignore when file is changed", async () => {
			// Setup initial state with .rooignore
			mockFileSystem.readFile.mockResolvedValue(new TextEncoder().encode("node_modules"))
			await controller.initialize()

			// Setup getRelativePath mock
			mockWorkspace.getRelativePath.mockImplementation((fullPath) => {
				if (fullPath.startsWith(TEST_CWD)) {
					return path.relative(TEST_CWD, fullPath)
				}
				return fullPath
			})

			// Verify initial state
			expect(controller.validateAccess("node_modules/package.json")).toBe(false)
			expect(controller.validateAccess(".git/config")).toBe(true)

			// Find the watch callback
			const rooignorePath = path.join(TEST_CWD, ".rooignore")
			const watchCallback = mockFileWatcher.watchFile.mock.calls[0][1]

			// Update mock to return new content
			mockFileSystem.readFile.mockResolvedValue(new TextEncoder().encode("node_modules\n.git"))

			// Simulate file change event
			watchCallback({ type: 'changed', uri: rooignorePath })

			// Wait a bit for async operation to complete
			await new Promise(resolve => setTimeout(resolve, 10))

			// Verify content was updated
			expect(controller.rooIgnoreContent).toBe("node_modules\n.git")
			expect(controller.validateAccess("node_modules/package.json")).toBe(false)
			expect(controller.validateAccess(".git/config")).toBe(false)
		})

		/**
		 * Tests behavior when .rooignore is deleted
		 */
		it("should reset when .rooignore is deleted", async () => {
			// Setup initial state with .rooignore
			mockFileSystem.readFile.mockResolvedValue(new TextEncoder().encode("node_modules"))
			await controller.initialize()

			// Setup getRelativePath mock
			mockWorkspace.getRelativePath.mockImplementation((fullPath) => {
				if (fullPath.startsWith(TEST_CWD)) {
					return path.relative(TEST_CWD, fullPath)
				}
				return fullPath
			})

			// Verify initial state
			expect(controller.validateAccess("node_modules/package.json")).toBe(false)

			// Find the watch callback
			const rooignorePath = path.join(TEST_CWD, ".rooignore")
			const watchCallback = mockFileWatcher.watchFile.mock.calls[0][1]

			// Update mock to simulate file deletion
			mockFileSystem.readFile.mockRejectedValue(new Error("File not found"))

			// Simulate file delete event
			watchCallback({ type: 'deleted', uri: rooignorePath })

			// Wait a bit for async operation to complete
			await new Promise(resolve => setTimeout(resolve, 10))

			// Verify content was reset
			expect(controller.rooIgnoreContent).toBeUndefined()
			expect(controller.validateAccess("node_modules/package.json")).toBe(true)
		})
	})
})
