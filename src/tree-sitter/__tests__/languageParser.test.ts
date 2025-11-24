import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { loadRequiredLanguageParsers } from "../languageParser"
import Parser from "web-tree-sitter"

// Mock tree-sitter queries
vi.mock("../queries", () => ({
	javascriptQuery: "mock-js-query",
	typescriptQuery: "mock-ts-query",
	tsxQuery: "mock-tsx-query",
	pythonQuery: "mock-py-query",
	rustQuery: "mock-rust-query",
	goQuery: "mock-go-query",
	cppQuery: "mock-cpp-query",
	cQuery: "mock-c-query",
	csharpQuery: "mock-csharp-query",
	rubyQuery: "mock-ruby-query",
	javaQuery: "mock-java-query",
	phpQuery: "mock-php-query",
	htmlQuery: "mock-html-query",
	swiftQuery: "mock-swift-query",
	kotlinQuery: "mock-kotlin-query",
	cssQuery: "mock-css-query",
	ocamlQuery: "mock-ocaml-query",
	solidityQuery: "mock-solidity-query",
	tomlQuery: "mock-toml-query",
	vueQuery: "mock-vue-query",
	luaQuery: "mock-lua-query",
	systemrdlQuery: "mock-systemrdl-query",
	tlaPlusQuery: "mock-tlaplus-query",
	zigQuery: "mock-zig-query",
	embeddedTemplateQuery: "mock-embedded-template-query",
	elispQuery: "mock-elisp-query",
	elixirQuery: "mock-elixir-query",
}))


// Mock web-tree-sitter
let mockSetLanguage: any
const mockParserInstances: any[] = []

vi.mock("web-tree-sitter", () => {
	const ParserMock = vi.fn().mockImplementation(() => {
		// Create setLanguage fresh for each instance
		const setLanguage = vi.fn()
		const instance = {
			setLanguage,
		}
		mockParserInstances.push(instance)
		return instance
	})

	// Add static methods
	ParserMock.init = vi.fn().mockResolvedValue(undefined)
	ParserMock.Language = {
		load: vi.fn().mockImplementation((wasmPath: string) => {
			// Extract language name from path for debugging
			const langName = wasmPath.split('/').pop()?.replace('tree-sitter-', '').replace('.wasm', '')
			return Promise.resolve({
				name: langName,
				// Mock the query method to return a Query object
				query: vi.fn().mockReturnValue({ 
					id: `query_${langName}`,
					captures: vi.fn(),
					matches: vi.fn(),
				}),
			})
		}),
		prototype: {}, // Required for TypeScript compatibility
	} as any

	return {
		__esModule: true,
		default: ParserMock,
	}
})

// Mock path module
vi.mock("path", async () => {
	const actual = await vi.importActual<typeof import("path")>("path")
	return {
		...actual,
		default: actual,
	}
})

// Mock url module
vi.mock("url", async () => {
	const actual = await vi.importActual<typeof import("url")>("url")
	return {
		...actual,
		fileURLToPath: vi.fn((url: string) => {
			// Simple mock implementation
			return url.replace('file://', '')
		}),
	}
})

// Mock fs to make WASM files appear to exist
vi.mock("fs", () => ({
	existsSync: vi.fn((filePath: string) => {
		// Always return true for WASM files to make the tests pass
		return (filePath.includes("tree-sitter-") && filePath.endsWith(".wasm")) ||
		       (filePath.includes("tree-sitter.wasm"))
	}),
	default: {
		existsSync: vi.fn((filePath: string) => {
			return (filePath.includes("tree-sitter-") && filePath.endsWith(".wasm")) ||
			       (filePath.includes("tree-sitter.wasm"))
		}),
	}
}))

describe("Language Parser", () => {
	beforeEach(async () => {
		// Clear the parser instances array
		mockParserInstances.length = 0
		
		// Clear mock call history (but not implementations)
		// We need to do this manually since we removed global vi.clearAllMocks()
		if (Parser.init && 'mockClear' in Parser.init) {
			(Parser.init as any).mockClear()
		}
		if (Parser.Language.load && 'mockClear' in Parser.Language.load) {
			(Parser.Language.load as any).mockClear()
		}
	})

	afterEach(() => {
		// Restore console.warn
		console.warn = vi.fn()
	})

	describe("loadRequiredLanguageParsers", () => {
		it("should load JavaScript parser for .js, .mjs, .jsx, and .json files", async () => {
			const files = ["test.js", "test.jsx", "test.mjs", "test.json"]
			const parsers = await loadRequiredLanguageParsers(files)

			expect(Parser.Language.load).toHaveBeenCalledWith(
				expect.stringContaining("tree-sitter-javascript.wasm"),
			)
			expect(parsers.js).toBeDefined()
			expect(parsers.js.query).toBeDefined()
		})

		it("should load TypeScript parser for .ts and .tsx files", async () => {
			const files = ["test.ts", "test.tsx"]
			const parsers = await loadRequiredLanguageParsers(files)

			expect(Parser.Language.load).toHaveBeenCalledWith(
				expect.stringContaining("tree-sitter-typescript.wasm"),
			)
			expect(Parser.Language.load).toHaveBeenCalledWith(expect.stringContaining("tree-sitter-tsx.wasm"))
			expect(parsers.ts).toBeDefined()
			expect(parsers.tsx).toBeDefined()
		})

		it("should load Python parser for .py files", async () => {
			const files = ["test.py"]
			const parsers = await loadRequiredLanguageParsers(files)

			expect(Parser.Language.load).toHaveBeenCalledWith(expect.stringContaining("tree-sitter-python.wasm"))
			expect(parsers.py).toBeDefined()
		})

		it("should load multiple language parsers as needed", async () => {
			const files = ["test.js", "test.py", "test.rs", "test.go"]
			const parsers = await loadRequiredLanguageParsers(files)

			expect(Parser.Language.load).toHaveBeenCalledTimes(4)
			expect(parsers.js).toBeDefined()
			expect(parsers.py).toBeDefined()
			expect(parsers.rs).toBeDefined()
			expect(parsers.go).toBeDefined()
		})

		it("should handle C/C++ files correctly", async () => {
			const files = ["test.c", "test.h", "test.cpp", "test.hpp"]
			const parsers = await loadRequiredLanguageParsers(files)

			expect(Parser.Language.load).toHaveBeenCalledWith(expect.stringContaining("tree-sitter-c.wasm"))
			expect(Parser.Language.load).toHaveBeenCalledWith(expect.stringContaining("tree-sitter-cpp.wasm"))
			expect(parsers.c).toBeDefined()
			expect(parsers.h).toBeDefined()
			expect(parsers.cpp).toBeDefined()
			expect(parsers.hpp).toBeDefined()
		})

		it("should handle Kotlin files correctly", async () => {
			const files = ["test.kt", "test.kts"]
			const parsers = await loadRequiredLanguageParsers(files)

			expect(Parser.Language.load).toHaveBeenCalledWith(expect.stringContaining("tree-sitter-kotlin.wasm"))
			expect(parsers.kt).toBeDefined()
			expect(parsers.kts).toBeDefined()
			expect(parsers.kt.query).toBeDefined()
			expect(parsers.kts.query).toBeDefined()
		})

		it("should skip unsupported file extensions gracefully", async () => {
			const files = ["test.unsupported"]
			const parsers = await loadRequiredLanguageParsers(files)

			// Should return empty object for unsupported extensions
			expect(parsers).toEqual({})
		})

		it("should load each language only once for multiple files of same type", async () => {
			const files = ["test1.js", "test2.js", "test3.js"]
			await loadRequiredLanguageParsers(files)

			expect(Parser.Language.load).toHaveBeenCalledTimes(1)
			expect(Parser.Language.load).toHaveBeenCalledWith(
				expect.stringContaining("tree-sitter-javascript.wasm"),
			)
		})

		it("should set language for each parser instance", async () => {
			const files = ["test.js", "test.py"]
			await loadRequiredLanguageParsers(files)

			// Check that setLanguage was called on parser instances
			expect(mockParserInstances.length).toBeGreaterThanOrEqual(2)
			// Each instance should have had setLanguage called
			const setLanguageCalls = mockParserInstances.reduce((sum, instance) => {
				return sum + (instance.setLanguage.mock?.calls?.length || 0)
			}, 0)
			expect(setLanguageCalls).toBe(2)
		})

		it("should handle embedded template files correctly", async () => {
			const files = ["test.ejs", "test.erb"]
			const parsers = await loadRequiredLanguageParsers(files)

			expect(Parser.Language.load).toHaveBeenCalledWith(
				expect.stringContaining("tree-sitter-embedded_template.wasm"),
			)
			expect(parsers.embedded_template).toBeDefined()
		})

		it("should handle Elixir files correctly", async () => {
			const files = ["test.ex", "test.exs"]
			const parsers = await loadRequiredLanguageParsers(files)

			expect(Parser.Language.load).toHaveBeenCalledWith(
				expect.stringContaining("tree-sitter-elixir.wasm"),
			)
			expect(parsers.ex).toBeDefined()
			expect(parsers.exs).toBeDefined()
		})

		it("should handle case-insensitive file extensions", async () => {
			const files = ["test.JS", "test.PY", "test.TS"]
			const parsers = await loadRequiredLanguageParsers(files)

			expect(parsers.js).toBeDefined()
			expect(parsers.py).toBeDefined()
			expect(parsers.ts).toBeDefined()
		})

		it("should handle files with multiple dots", async () => {
			const files = ["test.component.js", "app.config.ts", "module.test.py"]
			const parsers = await loadRequiredLanguageParsers(files)

			expect(parsers.js).toBeDefined()
			expect(parsers.ts).toBeDefined()
			expect(parsers.py).toBeDefined()
		})

		it("should handle mixed supported and unsupported files", async () => {
			const files = ["test.js", "test.unsupported", "test.py"]
			const parsers = await loadRequiredLanguageParsers(files)

			// Should only load parsers for supported extensions
			expect(parsers.js).toBeDefined()
			expect(parsers.py).toBeDefined()
			expect(Object.keys(parsers)).toHaveLength(2)
		})

		it("should handle empty file list", async () => {
			const files: string[] = []
			const parsers = await loadRequiredLanguageParsers(files)

			expect(parsers).toEqual({})
		})
	})
})
