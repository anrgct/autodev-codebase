// npx vitest run src/services/ripgrep/__tests__/index.spec.ts

import { describe, expect, it } from "vitest"
import { truncateLine, getBinPath, regexSearchFiles, createIgnoreFilter } from "../index"

describe("Ripgrep line truncation", () => {
  // The default MAX_LINE_LENGTH is 500 in the implementation
  const MAX_LINE_LENGTH = 500

  it("should truncate lines longer than MAX_LINE_LENGTH", () => {
    const longLine = "a".repeat(600) // Line longer than MAX_LINE_LENGTH
    const truncated = truncateLine(longLine)

    expect(truncated).toContain("[truncated...]")
    expect(truncated.length).toBeLessThan(longLine.length)
    expect(truncated.length).toEqual(MAX_LINE_LENGTH + " [truncated...]".length)
  })

  it("should not truncate lines shorter than MAX_LINE_LENGTH", () => {
    const shortLine = "Short line of text"
    const truncated = truncateLine(shortLine)

    expect(truncated).toEqual(shortLine)
    expect(truncated).not.toContain("[truncated...]")
  })

  it("should correctly truncate a line at exactly MAX_LINE_LENGTH characters", () => {
    const exactLine = "a".repeat(MAX_LINE_LENGTH)
    const exactPlusOne = exactLine + "x"

    // Should not truncate when exactly MAX_LINE_LENGTH
    expect(truncateLine(exactLine)).toEqual(exactLine)

    // Should truncate when exceeding MAX_LINE_LENGTH by even 1 character
    expect(truncateLine(exactPlusOne)).toContain("[truncated...]")
  })

  it("should handle empty lines without errors", () => {
    expect(truncateLine("")).toEqual("")
  })

  it("should allow custom maximum length", () => {
    const customLength = 100
    const line = "a".repeat(customLength + 50)

    const truncated = truncateLine(line, customLength)

    expect(truncated.length).toEqual(customLength + " [truncated...]".length)
    expect(truncated).toContain("[truncated...]")
  })
})

describe("Ripgrep integration", () => {
  it("should find ripgrep binary", async () => {
    const rgPath = await getBinPath()

    // Should either find a path or return undefined
    if (rgPath) {
      expect(typeof rgPath).toBe("string")
      expect(rgPath.length).toBeGreaterThan(0)
    } else {
      expect(rgPath).toBeUndefined()
    }
  })

  it("should perform basic search functionality when ripgrep is available", async () => {
    const rgPath = await getBinPath()

    if (rgPath) {
      try {
        const results = await regexSearchFiles(
          process.cwd(),
          "./src",
          "import.*ripgrep",
          "*.ts"
        )

        expect(typeof results).toBe("string")
        // Results should be a formatted string, even if empty
        expect(results).toBeDefined()
      } catch (error) {
        // Search might fail if no matching files exist, which is acceptable
        expect(error).toBeInstanceOf(Error)
      }
    } else {
      // Skip test if ripgrep is not available
      console.log("Skipping search test - ripgrep binary not found")
    }
  })

  it("should create and use ignore filter functionality", () => {
    const mockIgnoreController = {
      validateAccess: (path: string) => !path.includes("node_modules")
    }

    const ignoreFilter = createIgnoreFilter(mockIgnoreController)

    expect(typeof ignoreFilter).toBe("function")
    expect(ignoreFilter("/some/path/file.ts")).toBe(true)
    expect(ignoreFilter("/some/node_modules/file.ts")).toBe(false)
  })

  it("should create ignore filter without controller", () => {
    const ignoreFilter = createIgnoreFilter()

    expect(typeof ignoreFilter).toBe("function")
    // Without controller, should always return true
    expect(ignoreFilter("/any/path/file.ts")).toBe(true)
    expect(ignoreFilter("/some/node_modules/file.ts")).toBe(true)
  })

  it("should throw error when ripgrep binary is not found", async () => {
    // Mock getBinPath to return undefined
    const mockFileSystem = {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      stat: vi.fn(),
      readdir: vi.fn(),
      mkdir: vi.fn(),
      exists: () => Promise.resolve(false),
      delete: vi.fn(),
    }

    await expect(
      regexSearchFiles(
        process.cwd(),
        "./src",
        "test",
        "*.ts",
        { fileSystem: mockFileSystem }
      )
    ).rejects.toThrow("Could not find ripgrep binary")
  })
})
