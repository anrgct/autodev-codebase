import { vitest, describe, it, expect, beforeEach, vi } from "vitest"
import type { Mock } from "vitest"
import { createHash } from "crypto"
import debounce from "lodash.debounce"
import { CacheManager } from "../cache-manager"
import * as filesystem from "../../utils/filesystem"


// Mock debounce to execute immediately
vitest.mock("lodash.debounce", () => ({ default: vitest.fn((fn) => fn) }))

// Mock filesystem module
vitest.mock("../../utils/filesystem", () => ({
	readFile: vitest.fn(),
	writeFile: vitest.fn(),
}))

describe("CacheManager", () => {
	let mockWorkspacePath: string
	let mockCachePath: string
	let cacheManager: CacheManager

	beforeEach(() => {
		// Reset all mocks
		vitest.clearAllMocks()

		// Mock workspace path and cache path
		mockWorkspacePath = "/mock/workspace"
		// Cache path is now generated internally based on workspace hash
		const hash = createHash("sha256").update(mockWorkspacePath).digest("hex")
		mockCachePath = require("path").join(require("os").homedir(), ".autodev-cache", `roo-index-cache-${hash}.json`)

		// Create cache manager instance with only workspacePath
		cacheManager = new CacheManager(mockWorkspacePath)
	})

	describe("constructor", () => {
		it("should correctly set up cachePath using crypto.createHash", () => {
			const expectedHash = createHash("sha256").update(mockWorkspacePath).digest("hex")
			const expectedCachePath = require("path").join(require("os").homedir(), ".autodev-cache", `roo-index-cache-${expectedHash}.json`)

			expect(cacheManager.getCachePath).toBe(expectedCachePath)
		})

		it("should set up debounced save function", () => {
			expect(debounce).toHaveBeenCalledWith(expect.any(Function), 1500)
		})
	})

	describe("initialize", () => {
		it("should load existing cache file successfully", async () => {
			const mockCache = { "file1.ts": "hash1", "file2.ts": "hash2" }
			const mockBuffer = new TextEncoder().encode(JSON.stringify(mockCache))
			;(filesystem.readFile as Mock).mockResolvedValue(mockBuffer)

			await cacheManager.initialize()

			expect(filesystem.readFile).toHaveBeenCalledWith(mockCachePath)
			expect(cacheManager.getAllHashes()).toEqual(mockCache)
		})

		it("should handle missing cache file by creating empty cache", async () => {
			;(filesystem.readFile as Mock).mockRejectedValue(new Error("File not found"))

			await cacheManager.initialize()

			expect(cacheManager.getAllHashes()).toEqual({})
		})
	})

	describe("hash management", () => {
		it("should update hash and trigger save", () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash)

			expect(cacheManager.getHash(filePath)).toBe(hash)
			expect(filesystem.writeFile).toHaveBeenCalled()
		})

		it("should delete hash and trigger save", () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash)
			cacheManager.deleteHash(filePath)

			expect(cacheManager.getHash(filePath)).toBeUndefined()
			expect(filesystem.writeFile).toHaveBeenCalled()
		})

		it("should return shallow copy of hashes", () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash)
			const hashes = cacheManager.getAllHashes()

			// Modify the returned object
			hashes[filePath] = "modified"

			// Original should remain unchanged
			expect(cacheManager.getHash(filePath)).toBe(hash)
		})
	})

	describe("saving", () => {
		it("should save cache to disk with correct data", async () => {
			const filePath = "test.ts"
			const hash = "testhash"

			cacheManager.updateHash(filePath, hash)

			expect(filesystem.writeFile).toHaveBeenCalledWith(mockCachePath, expect.any(Uint8Array))

			// Verify the saved data
			const savedData = JSON.parse(
				new TextDecoder().decode((filesystem.writeFile as Mock).mock.calls[0][1]),
			)
			expect(savedData).toEqual({ [filePath]: hash })
		})

		it("should handle save errors gracefully", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
			;(filesystem.writeFile as Mock).mockRejectedValue(new Error("Save failed"))

			cacheManager.updateHash("test.ts", "hash")

			// Wait for any pending promises
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(consoleErrorSpy).toHaveBeenCalledWith("Failed to save cache:", expect.any(Error))

			consoleErrorSpy.mockRestore()
		})
	})

	describe("clearCacheFile", () => {
		it("should clear cache file and reset state", async () => {
			cacheManager.updateHash("test.ts", "hash")

			// Reset the mock to ensure writeFile succeeds for clearCacheFile
			;(filesystem.writeFile as Mock).mockClear()
			;(filesystem.writeFile as Mock).mockResolvedValue(undefined)

			await cacheManager.clearCacheFile()

			expect(filesystem.writeFile).toHaveBeenCalledWith(mockCachePath, new TextEncoder().encode("{}"))
			expect(cacheManager.getAllHashes()).toEqual({})
		})

		it("should handle clear errors gracefully", async () => {
			const consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
			;(filesystem.writeFile as Mock).mockRejectedValue(new Error("Save failed"))

			await cacheManager.clearCacheFile()

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Failed to clear cache file:",
				expect.any(Error),
				mockCachePath,
			)

			consoleErrorSpy.mockRestore()
		})
	})
})
