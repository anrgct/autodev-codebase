import * as fs from "fs/promises"
import { vi } from "vitest"

import { parseSourceCodeForDefinitionsTopLevel, TreeSitterDependencies } from "../index"
import { listFiles } from "../../glob/list-files"
import { loadRequiredLanguageParsers } from "../languageParser"
import { fileExistsAtPath } from "../../utils/fs"
import { IFileSystem, IWorkspace, IPathUtils } from "../../abstractions"

// Mock dependencies
vi.mock("../../glob/list-files")
vi.mock("../languageParser")
vi.mock("../../utils/fs")
vi.mock("fs/promises")

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
		shouldIgnore: vi.fn().mockResolvedValue(false),
		getName: () => "test-workspace",
		getWorkspaceFolders: () => [],
		findFiles: vi.fn().mockResolvedValue([]),
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

describe("Tree-sitter Service", () => {
	let mockDependencies: TreeSitterDependencies

	beforeEach(() => {
		vi.clearAllMocks()
		mockDependencies = createMockDependencies()
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)
	})

	describe("parseSourceCodeForDefinitionsTopLevel", () => {
		it("should handle non-existent directory", async () => {
			vi.mocked(mockDependencies.fileSystem.exists).mockResolvedValue(false)

			const result = await parseSourceCodeForDefinitionsTopLevel("/non/existent/path", mockDependencies)
			expect(result).toBe("This directory does not exist or you do not have permission to access it.")
		})

		it("should handle empty directory", async () => {
			vi.mocked(mockDependencies.workspace.findFiles).mockResolvedValue([])

			const result = await parseSourceCodeForDefinitionsTopLevel("/test/path", mockDependencies)
			expect(result).toBe("No source code definitions found.")
		})

		it("should parse TypeScript files correctly", async () => {
			const mockFiles = ["/test/path/file1.ts", "/test/path/file2.tsx", "/test/path/readme.md"]

			vi.mocked(mockDependencies.workspace.findFiles).mockResolvedValue(mockFiles)

			const mockParser = {
				parse: vi.fn().mockReturnValue({
					rootNode: "mockNode",
				}),
			}

			const mockQuery = {
				captures: vi.fn().mockReturnValue([
					{
						// Must span 4 lines to meet MIN_COMPONENT_LINES
						node: {
							startPosition: { row: 0 },
							endPosition: { row: 3 },
							parent: {
								startPosition: { row: 0 },
								endPosition: { row: 3 },
							},
							text: () => "export class TestClass",
						},
						name: "name.definition",
					},
				]),
			}

			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
				ts: { parser: mockParser, query: mockQuery },
				tsx: { parser: mockParser, query: mockQuery },
			})
			vi.mocked(mockDependencies.fileSystem.readFile).mockResolvedValue(new TextEncoder().encode("export class TestClass {\n  constructor() {}\n}"))

			const result = await parseSourceCodeForDefinitionsTopLevel("/test/path", mockDependencies)

			expect(result).toContain("file1.ts")
			expect(result).toContain("file2.tsx")
			expect(result).not.toContain("readme.md")
			expect(result).toContain("export class TestClass")
		})

		it("should handle multiple definition types", async () => {
			const mockFiles = ["/test/path/file.ts"]
			vi.mocked(mockDependencies.workspace.findFiles).mockResolvedValue(mockFiles)

			const mockParser = {
				parse: vi.fn().mockReturnValue({
					rootNode: "mockNode",
				}),
			}

			const mockQuery = {
				captures: vi.fn().mockReturnValue([
					{
						node: {
							startPosition: { row: 0 },
							endPosition: { row: 3 },
							parent: {
								startPosition: { row: 0 },
								endPosition: { row: 3 },
							},
							text: () => "class TestClass",
						},
						name: "name.definition.class",
					},
					{
						node: {
							startPosition: { row: 2 },
							endPosition: { row: 5 },
							parent: {
								startPosition: { row: 2 },
								endPosition: { row: 5 },
							},
							text: () => "testMethod()",
						},
						name: "name.definition.function",
					},
				]),
			}

			;vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
				ts: { parser: mockParser, query: mockQuery },
			})

			const fileContent = "class TestClass {\n" + "  constructor() {}\n" + "  testMethod() {}\n" + "}"

			vi.mocked(mockDependencies.fileSystem.readFile).mockResolvedValue(new TextEncoder().encode(fileContent))

			const result = await parseSourceCodeForDefinitionsTopLevel("/test/path", mockDependencies)

			expect(result).toContain("class TestClass")
			expect(result).toContain("testMethod()")
		})

		it("should handle parsing errors gracefully", async () => {
			const mockFiles = ["/test/path/file.ts"]
			vi.mocked(mockDependencies.workspace.findFiles).mockResolvedValue(mockFiles)

			const mockParser = {
				parse: vi.fn().mockImplementation(() => {
					throw new Error("Parsing error")
				}),
			}

			const mockQuery = {
				captures: vi.fn(),
			}

			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
				ts: { parser: mockParser, query: mockQuery },
			})
			vi.mocked(mockDependencies.fileSystem.readFile).mockResolvedValue(new TextEncoder().encode("invalid code"))

			const result = await parseSourceCodeForDefinitionsTopLevel("/test/path", mockDependencies)
			expect(result).toBe("No source code definitions found.")
		})

		it("should capture arrow functions in JSX attributes with 4+ lines", async () => {
			const mockFiles = ["/test/path/jsx-arrow.tsx"]
			vi.mocked(mockDependencies.workspace.findFiles).mockResolvedValue(mockFiles)

			// Embed the fixture content directly
			const fixtureContent = `import React from 'react';

export const CheckboxExample = () => (
		<VSCodeCheckbox
		  checked={isCustomTemperature}
		  onChange={(e: any) => {
		    const isChecked = e.target.checked
		    setIsCustomTemperature(isChecked)
		
		    if (!isChecked) {
		      setInputValue(null) // Unset the temperature
		    } else {
		      setInputValue(value ?? 0) // Use value from config
		    }
		  }}>
		  <label className="block font-medium mb-1">
		    {t("settings:temperature.useCustom")}
		  </label>
		</VSCodeCheckbox>
);`
			vi.mocked(mockDependencies.fileSystem.readFile).mockResolvedValue(new TextEncoder().encode(fixtureContent))

			const lines = fixtureContent.split("\n")

			// Define the node type for proper TypeScript support
			interface TreeNode {
				type?: string
				toString?: () => string
				text?: () => string
				startPosition?: { row: number }
				endPosition?: { row: number }
				children?: TreeNode[]
				fields?: () => Record<string, any>
				printTree?: (depth?: number) => string
			}

			// Create a more detailed mock rootNode for debugging Tree-sitter structure
			// Helper function to print tree nodes
			const printTree = (node: TreeNode, depth = 0): string => {
				let result = ""
				const indent = "  ".repeat(depth)

				// Print node details
				result += `${indent}Type: ${node.type || "ROOT"}\n`
				result += `${indent}Text: "${node.text ? node.text() : "root"}"`

				// Print fields if available
				if (node.fields) {
					result += "\n" + indent + "Fields: " + JSON.stringify(node.fields(), null, 2)
				}

				// Print children recursively
				if (node.children && node.children.length > 0) {
					result += "\n" + indent + "Children:"
					for (const child of node.children) {
						result += "\n" + printTree(child, depth + 1)
					}
				}

				return result
			}

			const mockRootNode: TreeNode = {
				toString: () => fixtureContent,
				text: () => fixtureContent,
				printTree: function (depth = 0) {
					return printTree(this, depth)
				},
				children: [
					{
						type: "class_declaration",
						text: () => "class TestComponent extends React.Component",
						startPosition: { row: 0 },
						endPosition: { row: 20 },
						printTree: function (depth = 0) {
							return printTree(this, depth)
						},
						children: [
							{
								type: "type_identifier",
								text: () => "TestComponent",
								printTree: function (depth = 0) {
									return printTree(this, depth)
								},
							},
							{
								type: "extends_clause",
								text: () => "extends React.Component",
								printTree: function (depth = 0) {
									return printTree(this, depth)
								},
								children: [
									{
										type: "generic_type",
										text: () => "React.Component",
										children: [{ type: "member_expression", text: () => "React.Component" }],
									},
								],
							},
						],
						// Debug output to see field names
						fields: () => {
							return {
								name: [{ type: "type_identifier", text: () => "TestComponent" }],
								class_heritage: [{ type: "extends_clause", text: () => "extends React.Component" }],
							}
						},
					},
				],
			}

			const mockParser = {
				parse: vi.fn().mockReturnValue({
					rootNode: mockRootNode,
				}),
			}

			const mockQuery = {
				captures: vi.fn().mockImplementation(() => {
					// Log tree structure for debugging
					console.log("TREE STRUCTURE:")
					if (mockRootNode.printTree) {
						console.log(mockRootNode.printTree())
					} else {
						console.log("Tree structure:", JSON.stringify(mockRootNode, null, 2))
					}

					return [
						{
							node: {
								startPosition: { row: 4 },
								endPosition: { row: 14 },
								text: () => lines[4],
								parent: {
									startPosition: { row: 4 },
									endPosition: { row: 14 },
									text: () => lines[4],
								},
							},
							name: "definition.lambda",
						},
					]
				}),
			}

			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
				tsx: { parser: mockParser, query: mockQuery },
			})

			const result = await parseSourceCodeForDefinitionsTopLevel("/test/path", mockDependencies)

			// Verify function found and correctly parsed
			expect(result).toContain("jsx-arrow.tsx")
			expect(result).toContain("5--15 |")

			// Verify line count
			const capture = mockQuery.captures.mock.results[0].value[0]
			expect(capture.node.endPosition.row - capture.node.startPosition.row).toBeGreaterThanOrEqual(4)
		})

		it("should respect file limit", async () => {
			const mockFiles = Array(100)
				.fill(0)
				.map((_, i) => `/test/path/file${i}.ts`)
			vi.mocked(mockDependencies.workspace.findFiles).mockResolvedValue(mockFiles)

			const mockParser = {
				parse: vi.fn().mockReturnValue({
					rootNode: "mockNode",
				}),
			}

			const mockQuery = {
				captures: vi.fn().mockReturnValue([]),
			}

			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
				ts: { parser: mockParser, query: mockQuery },
			})

			await parseSourceCodeForDefinitionsTopLevel("/test/path", mockDependencies)

			// Should only process first 50 files
			expect(mockParser.parse).toHaveBeenCalledTimes(50)
		})

		it("should handle various supported file extensions", async () => {
			const mockFiles = [
				"/test/path/script.js",
				"/test/path/app.py",
				"/test/path/main.rs",
				"/test/path/program.cpp",
				"/test/path/code.go",
				"/test/path/app.kt",
				"/test/path/script.kts",
			]

			vi.mocked(mockDependencies.workspace.findFiles).mockResolvedValue(mockFiles)

			const mockParser = {
				parse: vi.fn().mockReturnValue({
					rootNode: "mockNode",
				}),
			}

			const mockQuery = {
				captures: vi.fn().mockReturnValue([
					{
						node: {
							startPosition: { row: 0 },
							endPosition: { row: 3 },
							parent: {
								startPosition: { row: 0 },
								endPosition: { row: 3 },
							},
							text: () => "function test() {}",
						},
						name: "name",
					},
				]),
			}

			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
				js: { parser: mockParser, query: mockQuery },
				py: { parser: mockParser, query: mockQuery },
				rs: { parser: mockParser, query: mockQuery },
				cpp: { parser: mockParser, query: mockQuery },
				go: { parser: mockParser, query: mockQuery },
				kt: { parser: mockParser, query: mockQuery },
				kts: { parser: mockParser, query: mockQuery },
			})
			vi.mocked(mockDependencies.fileSystem.readFile).mockResolvedValue(new TextEncoder().encode("function test() {}"))

			const result = await parseSourceCodeForDefinitionsTopLevel("/test/path", mockDependencies)

			expect(result).toContain("script.js")
			expect(result).toContain("app.py")
			expect(result).toContain("main.rs")
			expect(result).toContain("program.cpp")
			expect(result).toContain("code.go")
			expect(result).toContain("app.kt")
			expect(result).toContain("script.kts")
		})

		it("should normalize paths in output", async () => {
			const mockFiles = ["/test/path/dir/file.ts"] // Use normalized path in mock
			vi.mocked(mockDependencies.workspace.findFiles).mockResolvedValue(mockFiles)

			const mockParser = {
				parse: vi.fn().mockReturnValue({
					rootNode: "mockNode",
				}),
			}

			const mockQuery = {
				captures: vi.fn().mockReturnValue([
					{
						node: {
							startPosition: { row: 0 },
							endPosition: { row: 3 },
							parent: {
								startPosition: { row: 0 },
								endPosition: { row: 3 },
							},
							text: () => "class Test {}",
						},
						name: "name",
					},
				]),
			}

			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
				ts: { parser: mockParser, query: mockQuery },
			})
			vi.mocked(mockDependencies.fileSystem.readFile).mockResolvedValue(new TextEncoder().encode("class Test {}"))

			const result = await parseSourceCodeForDefinitionsTopLevel("/test/path", mockDependencies)

			// Should use forward slashes regardless of platform
			expect(result).toContain("dir/file.ts")
			expect(result).not.toContain("dir\\file.ts")
		})
	})
})
