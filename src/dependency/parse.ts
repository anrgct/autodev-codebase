/**
 * Parser management and file parsing utilities
 */

import * as path from 'path'
import { fileURLToPath } from 'url'
import Parser from 'web-tree-sitter'
import { IFileSystem } from '../abstractions/core'
import { IPathUtils } from '../abstractions/workspace'
import { ParseOutput, FileParseResult, LanguageConfig, ParserCacheEntry, AnalysisOptions } from './models'
import { IGNORE_DIRS as CORE_IGNORE_DIRS, type IgnoreDir } from '../ignore/default-dirs'
import { IgnoreService } from '../ignore/IgnoreService'

// Default directories to ignore - now using centralized configuration
export const IGNORE_DIRS = CORE_IGNORE_DIRS

// Supported languages and their Tree-sitter configurations
const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  typescript: {
    name: 'TypeScript',
    extensions: ['.ts', '.tsx'],
    treeSitterName: 'typescript'
  },
  javascript: {
    name: 'JavaScript',
    extensions: ['.js', '.jsx'],
    treeSitterName: 'javascript'
  },
  python: {
    name: 'Python',
    extensions: ['.py'],
    treeSitterName: 'python'
  },
  java: {
    name: 'Java',
    extensions: ['.java'],
    treeSitterName: 'java'
  },
  rust: {
    name: 'Rust',
    extensions: ['.rs'],
    treeSitterName: 'rust'
  },
  go: {
    name: 'Go',
    extensions: ['.go'],
    treeSitterName: 'go'
  },
  c: {
    name: 'C',
    extensions: ['.c'],
    treeSitterName: 'c'
  },
  cpp: {
    name: 'C++',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.h'],
    treeSitterName: 'cpp'
  },
  ruby: {
    name: 'Ruby',
    extensions: ['.rb'],
    treeSitterName: 'ruby'
  },
  php: {
    name: 'PHP',
    extensions: ['.php'],
    treeSitterName: 'php'
  }
}

/**
 * Parser cache for loaded Tree-sitter parsers
 */
class ParserCache {
  private cache = new Map<string, ParserCacheEntry>()
  private maxSize: number
  private maxAge: number

  constructor(maxSize: number = 50, maxAge: number = 3600000) { // 1 hour default
    this.maxSize = maxSize
    this.maxAge = maxAge
  }

  get(language: string): ParserCacheEntry | undefined {
    const entry = this.cache.get(language)
    if (!entry) return undefined

    const now = Date.now()
    if (now - entry.lastUsed > this.maxAge) {
      this.cache.delete(language)
      return undefined
    }

    entry.lastUsed = now
    return entry
  }

  set(language: string, entry: ParserCacheEntry): void {
    if (this.cache.size >= this.maxSize) {
      // Remove oldest entry
      let oldestKey = ''
      let oldestTime = Date.now()

      for (const [key, value] of this.cache.entries()) {
        if (value.lastUsed < oldestTime) {
          oldestTime = value.lastUsed
          oldestKey = key
        }
      }

      if (oldestKey) {
        this.cache.delete(oldestKey)
      }
    }

    this.cache.set(language, entry)
  }

  clear(): void {
    this.cache.clear()
  }
}

const parserCache = new ParserCache()

/**
 * Find core tree-sitter.wasm path
 */
function findCoreWasmPath(): string {
  const fileName = 'tree-sitter.wasm'

  let basePath: string
  if (typeof import.meta !== 'undefined' && import.meta.url) {
    const currentFileUrl = import.meta.url
    const currentFilePath = fileURLToPath(currentFileUrl)
    basePath = path.dirname(currentFilePath)
  } else if (typeof __dirname !== 'undefined') {
    basePath = __dirname
  } else {
    basePath = process.cwd()
  }

  const possiblePaths = [
    path.join(basePath, '..', '..', 'dist', fileName),
    path.join(basePath, '..', 'dist', fileName),
    path.join(basePath, fileName),
    path.join(process.cwd(), 'dist', fileName),
    path.join(process.cwd(), 'src', 'tree-sitter', fileName),
    path.join(process.cwd(), 'node_modules', 'web-tree-sitter', fileName),
  ]

  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      return filePath
    }
  }

  return path.join('dist', fileName)
}

let isParserInitialized = false
let initializationPromise: Promise<void> | null = null

/**
 * Initialize tree-sitter parser (must be called before using parsers)
 */
async function ensureParserInitialized(): Promise<void> {
  if (isParserInitialized) return
  if (initializationPromise) {
    await initializationPromise
    return
  }

  initializationPromise = (async () => {
    const coreWasmPath = findCoreWasmPath()
    await Parser.init({
      locateFile(scriptName: string, scriptDirectory: string) {
        if (scriptName === 'tree-sitter.wasm') {
          return coreWasmPath
        }
        return scriptDirectory + scriptName
      }
    })
    isParserInitialized = true
  })()

  await initializationPromise
  initializationPromise = null
}

/**
 * Find WASM file path for a language
 */
function findWasmPath(language: string, wasmBasePath: string): string {
  const fileName = `tree-sitter-${language}.wasm`

  // Determine base path
  let basePath: string
  if (typeof import.meta !== 'undefined' && import.meta.url) {
    const currentFileUrl = import.meta.url
    const currentFilePath = fileURLToPath(currentFileUrl)
    basePath = path.dirname(currentFilePath)
  } else if (typeof __dirname !== 'undefined') {
    basePath = __dirname
  } else {
    basePath = process.cwd()
  }

  // Try custom path first, then default locations
  if (wasmBasePath !== 'dist/tree-sitter') {
    const customPath = path.join(wasmBasePath, fileName)
    return customPath
  }

  // Default locations
  const possiblePaths = [
    path.join(basePath, '..', '..', 'dist', 'tree-sitter', fileName),
    path.join(basePath, '..', 'dist', 'tree-sitter', fileName),
    path.join(basePath, 'tree-sitter', fileName),
    path.join(process.cwd(), 'dist', 'tree-sitter', fileName),
    path.join(process.cwd(), 'src', 'tree-sitter', fileName),
  ]

  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      return filePath
    }
  }

  return path.join(wasmBasePath, fileName)
}

import * as fs from 'fs'

/**
 * Initialize Tree-sitter parser for a language
 */
export async function initializeParser(
  language: string,
  fileSystem: IFileSystem,
  wasmBasePath: string = 'dist/tree-sitter'
): Promise<any> {
  const cached = parserCache.get(language)
  if (cached) {
    return cached.parser
  }

  try {
    // Ensure core parser is initialized
    await ensureParserInitialized()

    const wasmPath = findWasmPath(language, wasmBasePath)

    // Check if file exists
    if (!fs.existsSync(wasmPath)) {
      throw new Error(`WASM file not found: ${wasmPath}`)
    }

    // Initialize Tree-sitter parser with web-tree-sitter
    const languageObj = await Parser.Language.load(wasmPath)
    const parser = new Parser()
    parser.setLanguage(languageObj)

    const entry: ParserCacheEntry = {
      parser,
      language: languageObj,
      lastUsed: Date.now()
    }

    parserCache.set(language, entry)
    return parser
  } catch (error) {
    throw new Error(`Failed to initialize parser for ${language}: ${error}`)
  }
}

/**
 * Load language parser based on file extension
 */
export async function loadLanguageParser(
  filePath: string,
  fileSystem: IFileSystem,
  pathUtils: IPathUtils,
  wasmBasePath?: string
): Promise<{ parser: any; language: string } | null> {
  const ext = pathUtils.extname(filePath).toLowerCase()

  for (const [langKey, config] of Object.entries(LANGUAGE_CONFIGS)) {
    if (config.extensions.includes(ext)) {
      const parser = await initializeParser(config.treeSitterName, fileSystem, wasmBasePath)
      return { parser, language: langKey }
    }
  }

  return null
}

/**
 * Walk through directory and collect files
 *
 * @param directory - Directory to walk
 * @param fileSystem - File system abstraction
 * @param pathUtils - Path utilities abstraction
 * @param ignoreService - Unified ignore service for filtering
 * @param options - Analysis options
 * @returns Promise<string[]> Array of file paths
 */
export async function walkFiles(
  directory: string,
  fileSystem: IFileSystem,
  pathUtils: IPathUtils,
  ignoreService: IgnoreService,  // New parameter
  options: AnalysisOptions = {}
): Promise<string[]> {
  const files: string[] = []
  const maxSize = options.fileFilter?.maxFileSize || 10 * 1024 * 1024 // 10MB default

  // Ensure ignore service is initialized
  await ignoreService.initialize()

  async function walk(currentDir: string): Promise<void> {
    try {
      const entries = await fileSystem.readdir(currentDir)

      for (const entry of entries) {
        const fullPath = pathUtils.join(currentDir, entry)
        const stat = await fileSystem.stat(fullPath)

        if (stat.isDirectory) {
          // 🔥 Use unified directory pruning logic
          if (ignoreService.shouldSkipDirectory(fullPath)) {
            continue  // Skip entire directory early
          }

          await walk(fullPath)
        } else if (stat.isFile) {
          if (stat.size > maxSize) {
            continue
          }

          // 🔥 Use unified file filtering logic
          if (ignoreService.shouldIgnore(fullPath)) {
            continue
          }

          const ext = pathUtils.extname(fullPath).toLowerCase()
          const basename = pathUtils.basename(fullPath)

          // Skip test files if not included
          if (!options.includeTests && (basename.includes('.test.') || basename.includes('.spec.'))) {
            continue
          }

          // Check if file has supported extension
          const hasSupportedExt = Object.values(LANGUAGE_CONFIGS).some(config =>
            config.extensions.includes(ext)
          )

          if (hasSupportedExt) {
            files.push(fullPath)
          }
        }
      }
    } catch (error) {
      console.warn(`Error walking directory ${currentDir}: ${error}`)
    }
  }

  await walk(directory)
  return files
}

/**
 * Parse a single file
 */
export async function parseFile(
  filePath: string,
  fileSystem: IFileSystem,
  pathUtils: IPathUtils,
  wasmBasePath?: string
): Promise<FileParseResult> {
  try {
    const bytes = await fileSystem.readFile(filePath)
    const content = new TextDecoder('utf-8').decode(bytes)

    const parserResult = await loadLanguageParser(filePath, fileSystem, pathUtils, wasmBasePath)

    if (!parserResult) {
      return {
        filePath,
        content,
        language: 'unknown',
        ast: null,
        success: false,
        error: 'No parser available for this file type'
      }
    }

    const { parser, language } = parserResult
    const tree = parser.parse(content)

    return {
      filePath,
      content,
      language,
      ast: tree,
      success: true
    }
  } catch (error) {
    return {
      filePath,
      content: '',
      language: 'unknown',
      ast: null,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Parse all files in a directory
 */
export async function parseDirectory(
  directory: string,
  fileSystem: IFileSystem,
  pathUtils: IPathUtils,
  ignoreService: IgnoreService,  // New parameter
  options: AnalysisOptions = {},
  wasmBasePath?: string,
  onProgress?: (filePath: string, index: number, total: number) => void
): Promise<FileParseResult[]> {
  const files = await walkFiles(directory, fileSystem, pathUtils, ignoreService, options)
  const results: FileParseResult[] = []

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const result = await parseFile(file, fileSystem, pathUtils, wasmBasePath)
    results.push(result)

    if (onProgress) {
      onProgress(file, i + 1, files.length)
    }
  }

  return results
}

/**
 * Get language configuration by extension
 */
export function getLanguageConfig(extension: string): LanguageConfig | null {
  const normalizedExt = extension.toLowerCase()
  for (const config of Object.values(LANGUAGE_CONFIGS)) {
    if (config.extensions.includes(normalizedExt)) {
      return config
    }
  }
  return null
}

/**
 * Clear parser cache
 */
export function clearParserCache(): void {
  parserCache.clear()
}

/**
 * Get supported languages
 */
export function getSupportedLanguages(): string[] {
  return Object.keys(LANGUAGE_CONFIGS)
}

/**
 * Get all language configurations
 */
export function getLanguageConfigs(): Record<string, LanguageConfig> {
  return { ...LANGUAGE_CONFIGS }
}
