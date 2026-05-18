import { parseSourceCodeDefinitionsForFile, setMinComponentLines } from ".."
import * as fs from "fs/promises"
import * as path from "path"
import Parser from "web-tree-sitter"
import tsxQuery from "../queries/tsx"
import { vi, expect } from "vitest"
import { resolveWasmPath } from "../wasm-loader"

// Mock setup
vi.mock("fs/promises")
export const mockedFs = vi.mocked(fs)

vi.mock("../../../utils/fs", () => ({
  fileExistsAtPath: vi.fn().mockImplementation(() => Promise.resolve(true)),
}))

vi.mock("../languageParser", () => ({
  loadRequiredLanguageParsers: vi.fn(),
  LanguageParser: vi.fn(),
}))

// Global debug flag - read from environment variable or default to 0
export const DEBUG = process.env['DEBUG'] ? parseInt(process.env['DEBUG'], 10) : 0

// Debug function to conditionally log messages
export const debugLog = (message: string, ...args: any[]) => {
  if (DEBUG) {
    console.debug(message, ...args)
  }
}

// Store the initialized flag
let treeSitterInitialized = false

// Function to initialize tree-sitter
export async function initializeTreeSitter(): Promise<typeof Parser> {
  if (!treeSitterInitialized) {
    await Parser.init()
    treeSitterInitialized = true
  }
  return Parser
}

// Function to initialize a working parser with correct WASM path
// DO NOT CHANGE THIS FUNCTION
export async function initializeWorkingParser() {
  const TreeSitter = Parser

  // Initialize directly using the default export or the module itself
  const ParserConstructor = (TreeSitter as any).default || TreeSitter
  await ParserConstructor.init()

  // Override the Parser.Language.load to use dist directory
  const originalLoad = (TreeSitter as any).Language.load
  ;(TreeSitter as any).Language.load = async (wasmPath: string) => {
    const filename = path.basename(wasmPath)
    const correctPath = resolveWasmPath(filename)
    // console.log(`Redirecting WASM load from ${wasmPath} to ${correctPath}`)
    return originalLoad(correctPath)
  }

  return TreeSitter
}

// Test helper for parsing source code definitions
export async function testParseSourceCodeDefinitions(
  testFilePath: string,
  content: string,
  options: {
    language?: string
    wasmFile?: string
    queryString?: string
    extKey?: string
  } = {},
): Promise<string | undefined> {
  // Set minimum component lines to 0 for tests
  setMinComponentLines(0)

  // Set default options
  const wasmFile = options.wasmFile || "tree-sitter-tsx.wasm"
  const queryString = options.queryString || tsxQuery
  const extKey = options.extKey || "tsx"

  // Clear any previous mocks and set up fs mock
  vi.clearAllMocks()
  // Use the mocked fs that was already set up at the top - return a Buffer instead of string
  mockedFs.readFile.mockResolvedValue(Buffer.from(content, 'utf-8'))

  // Get the mock function
  const languageParserModule = await import("../languageParser")
  const mockedLoadRequiredLanguageParsers = languageParserModule.loadRequiredLanguageParsers

  // Initialize TreeSitter and create a real parser
  await initializeTreeSitter()
  const parser = new Parser()

  // Load language and configure parser
  const wasmPath = resolveWasmPath(wasmFile)
  const lang = await Parser.Language.load(wasmPath)
  parser.setLanguage(lang)

  // Create a real query
  const query = lang.query(queryString)

  // Set up our language parser with real parser and query
  const mockLanguageParser: any = {}
  mockLanguageParser[extKey] = { parser, query }

  // Configure the mock to return our parser
  vi.mocked(mockedLoadRequiredLanguageParsers).mockResolvedValue(mockLanguageParser)

  // Call the function under test with mock dependencies
  const mockDependencies = {
    fileSystem: {
      ...mockedFs,
      exists: vi.fn().mockResolvedValue(true),
    },
    workspace: {
      getRootPath: vi.fn().mockReturnValue(process.cwd()),
      shouldIgnore: vi.fn().mockResolvedValue(false),
    },
    pathUtils: {
      extname: vi.fn().mockImplementation((filePath: string) => {
        // Extract the actual extension from the file path
        const match = filePath.match(/\.([^.]+)$/)
        return match ? `.${match[1]}` : ''
      }),
      basename: vi.fn().mockImplementation((filePath: string) => {
        // Extract the actual basename from the file path
        return filePath.split('/').pop() || filePath
      }),
    },
  }
  const result = await parseSourceCodeDefinitionsForFile(testFilePath, mockDependencies as any)

  // Verify loadRequiredLanguageParsers was called with the expected file path
  expect(mockedLoadRequiredLanguageParsers).toHaveBeenCalledWith([testFilePath])
  expect(mockedLoadRequiredLanguageParsers).toHaveBeenCalled()

  debugLog(`Result:\n${result}`)
  return result
}

// Helper function to inspect tree structure
export async function inspectTreeStructure(content: string, language: string = "typescript"): Promise<string> {
  await initializeTreeSitter()
  const parser = new Parser()
  const wasmPath = resolveWasmPath(`tree-sitter-${language}.wasm`)
  const lang = await Parser.Language.load(wasmPath)
  parser.setLanguage(lang)

  // Parse the content
  const tree = parser.parse(content)

  // Print the tree structure
  debugLog(`TREE STRUCTURE (${language}):\n${tree.rootNode.toString()}`)
  return tree.rootNode.toString()
}
