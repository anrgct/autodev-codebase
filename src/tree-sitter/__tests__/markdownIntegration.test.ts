/// <reference types="../../types/vitest" />

import * as fs from "fs/promises"
import { vi } from "vitest"

import { parseSourceCodeDefinitionsForFile, TreeSitterDependencies } from "../index"
import { IFileSystem, IWorkspace, IPathUtils } from "../../abstractions"

// Create mock dependencies for testing
const createMockDependencies = (): TreeSitterDependencies => ({
	fileSystem: {
		exists: vi.fn().mockResolvedValue(true),
		readFile: vi.fn().mockResolvedValue(new TextEncoder().encode("mock content")),
		writeFile: vi.fn(),
		stat: vi.fn(),
		readdir: vi.fn(),
		mkdir: vi.fn(),
		delete: vi.fn(),
	} as IFileSystem,
	workspace: {
		getRootPath: () => "/test/path",
		getRelativePath: (path: string) => path.replace("/test/path/", ""),
		getIgnoreRules: () => [],
		getGlobIgnorePatterns: () => Promise.resolve([]),
		shouldIgnore: vi.fn().mockResolvedValue(false),
		getName: () => "test-workspace",
		getWorkspaceFolders: () => [],
		findFiles: vi.fn().mockResolvedValue([]),
		getIgnoreService: () => ({ getRules: () => [] } as any),
	} as IWorkspace,
	pathUtils: {
		join: (...paths: string[]) => paths.join("/"),
		dirname: (path: string) => path.split("/").slice(0, -1).join("/"),
		basename: (path: string, ext?: string) => {
			const base = path.split("/").pop() || ""
			return ext ? base.replace(ext, "") : base
		},
		extname: (path: string) => {
			const parts = path.split(".")
			return parts.length > 1 ? `.${parts.pop()}` : ""
		},
		resolve: (...paths: string[]) => paths.join("/"),
		isAbsolute: (path: string) => path.startsWith("/"),
		relative: (from: string, to: string) => to.replace(from + "/", ""),
		normalize: (path: string) => path.replace(/\\/g, "/"),
	} as IPathUtils,
})

// Mock fs.readFile
vi.mock("fs/promises", () => ({
	readFile: vi.fn().mockImplementation(() => Promise.resolve("")),
	stat: vi.fn().mockImplementation(() => Promise.resolve({ isDirectory: () => false })),
}))

// Mock fileExistsAtPath
vi.mock("../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockImplementation(() => Promise.resolve(true)),
}))

describe("Markdown Integration Tests", () => {
	let mockDependencies: TreeSitterDependencies

	beforeEach(() => {
		vi.clearAllMocks()
		mockDependencies = createMockDependencies()
	})

	it("should parse markdown files and extract headers", async () => {
		// Mock markdown content
		const markdownContent =
			"# Main Header\n\nThis is some content under the main header.\nIt spans multiple lines to meet the minimum section length.\n\n## Section 1\n\nThis is content for section 1.\nIt also spans multiple lines.\n\n### Subsection 1.1\n\nThis is a subsection with enough lines\nto meet the minimum section length requirement.\n\n## Section 2\n\nFinal section content.\nWith multiple lines.\n"

		// Mock fs.readFile to return our markdown content
		vi.mocked(mockDependencies.fileSystem.readFile).mockResolvedValue(new TextEncoder().encode(markdownContent))

		// Call the function with a markdown file path
		const result = await parseSourceCodeDefinitionsForFile("test.md", mockDependencies)

		// Verify mockDependencies.fileSystem.readFile was called with the correct path
		expect(mockDependencies.fileSystem.readFile).toHaveBeenCalledWith("test.md")

		// Check the result
		expect(result).toBeDefined()
		expect(result).toContain("# test.md")
		expect(result).toContain("1--5 | # Main Header")
		expect(result).toContain("6--10 | ## Section 1")
		expect(result).toContain("11--15 | ### Subsection 1.1")
		expect(result).toContain("16--20 | ## Section 2")
	})

	it("should handle markdown files with no headers", async () => {
		// Mock markdown content with no headers
		const markdownContent = "This is just some text.\nNo headers here.\nJust plain text."

		// Mock fs.readFile to return our markdown content
		vi.mocked(mockDependencies.fileSystem.readFile).mockResolvedValue(new TextEncoder().encode(markdownContent))

		// Call the function with a markdown file path
		const result = await parseSourceCodeDefinitionsForFile("no-headers.md", mockDependencies)

		// Verify mockDependencies.fileSystem.readFile was called with the correct path
		expect(mockDependencies.fileSystem.readFile).toHaveBeenCalledWith("no-headers.md")

		// Check the result
		expect(result).toBeUndefined()
	})

	it("should handle markdown files with headers that don't meet minimum section length", async () => {
		// Mock markdown content with headers but short sections
		const markdownContent = "# Header 1\nShort section\n\n# Header 2\nAnother short section"

		// Mock fs.readFile to return our markdown content
		vi.mocked(mockDependencies.fileSystem.readFile).mockResolvedValue(new TextEncoder().encode(markdownContent))

		// Call the function with a markdown file path
		const result = await parseSourceCodeDefinitionsForFile("short-sections.md", mockDependencies)

		// Verify mockDependencies.fileSystem.readFile was called with the correct path
		expect(mockDependencies.fileSystem.readFile).toHaveBeenCalledWith("short-sections.md")

		// Check the result - should be undefined since no sections meet the minimum length
		expect(result).toBeUndefined()
	})

	it("should handle markdown files with mixed header styles", async () => {
		// Mock markdown content with mixed header styles
		const markdownContent =
			"# ATX Header\nThis is content under an ATX header.\nIt spans multiple lines to meet the minimum section length.\n\nSetext Header\n============\nThis is content under a setext header.\nIt also spans multiple lines to meet the minimum section length.\n"

		// Mock fs.readFile to return our markdown content
		vi.mocked(mockDependencies.fileSystem.readFile).mockResolvedValue(new TextEncoder().encode(markdownContent))

		// Call the function with a markdown file path
		const result = await parseSourceCodeDefinitionsForFile("mixed-headers.md", mockDependencies)

		// Verify mockDependencies.fileSystem.readFile was called with the correct path
		expect(mockDependencies.fileSystem.readFile).toHaveBeenCalledWith("mixed-headers.md")

		// Check the result
		expect(result).toBeDefined()
		expect(result).toContain("# mixed-headers.md")
		expect(result).toContain("1--4 | # ATX Header")
		expect(result).toContain("5--9 | Setext Header")
	})
})
