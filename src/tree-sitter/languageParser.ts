import * as path from "path"
import { fileURLToPath } from "url"
import * as fs from "fs"
import Parser from "web-tree-sitter"
import {
	javascriptQuery,
	typescriptQuery,
	tsxQuery,
	pythonQuery,
	rustQuery,
	goQuery,
	cppQuery,
	cQuery,
	csharpQuery,
	rubyQuery,
	javaQuery,
	phpQuery,
	htmlQuery,
	swiftQuery,
	kotlinQuery,
	cssQuery,
	ocamlQuery,
	solidityQuery,
	tomlQuery,
	vueQuery,
	luaQuery,
	systemrdlQuery,
	tlaPlusQuery,
	zigQuery,
	embeddedTemplateQuery,
	elispQuery,
	elixirQuery,
} from "./queries"

export interface LanguageParser {
	[key: string]: {
		parser: Parser
		query: Parser.Query
	}
}

/**
 * 查找 WASM 文件的完整路径
 * 支持开发环境和打包后环境的路径解析
 */
function findWasmFile(langName: string): string {
	const fileName = `tree-sitter-${langName}.wasm`

	// 确定当前模块的基础路径
	let basePath: string
	if (typeof import.meta !== 'undefined' && import.meta.url) {
		// ES 模块环境
		const currentFileUrl = import.meta.url
		const currentFilePath = fileURLToPath(currentFileUrl)
		basePath = path.dirname(currentFilePath)
	} else if (typeof __dirname !== 'undefined') {
		// CommonJS 环境
		basePath = __dirname
	} else {
		// 降级处理：使用当前工作目录
		basePath = process.cwd()
	}

	// 可能的文件位置（按优先级排序）
	const possiblePaths = [
		// 1. 当前模块目录（开发环境，WASM 文件被复制到这里）
		path.join(basePath, fileName),
		// 2. 打包后的情况：相对于 dist/index.js 找到 dist/tree-sitter/
		path.join(basePath, 'tree-sitter', fileName)
	]

	// 逐个检查文件是否存在
	for (const [index, filePath] of possiblePaths.entries()) {
		try {
			if (fs.existsSync(filePath)) {
				// console.log(`Found WASM file for ${langName} at: ${filePath}, filePath: ${filePath}, index: ${index}`)
				return filePath
			}
		} catch (error) {
			// 忽略访问权限等错误，继续尝试下一个路径
			continue
		}
	}

	// 如果都找不到，抛出详细的错误信息
	const error = new Error(`无法找到 WASM 文件: ${fileName}`)
	;(error as any).details = {
		searchedPaths: possiblePaths,
		currentWorkingDirectory: process.cwd(),
		basePath,
		moduleUrl: typeof import.meta !== 'undefined' ? import.meta.url : undefined,
		dirname: typeof __dirname !== 'undefined' ? __dirname : undefined,
	}
	throw error
}

function findCoreTreeSitterWasm(): string {
	const fileName = 'tree-sitter.wasm'

	// 确定当前模块的基础路径
	let basePath: string
	if (typeof import.meta !== 'undefined' && import.meta.url) {
		// ES 模块环境
		const currentFileUrl = import.meta.url
		const currentFilePath = fileURLToPath(currentFileUrl)
		basePath = path.dirname(currentFilePath)
	} else if (typeof __dirname !== 'undefined') {
		// CommonJS 环境
		basePath = __dirname
	} else {
		// 降级处理：使用当前工作目录
		basePath = process.cwd()
	}

	// 可能的文件位置（按优先级排序）
	const possiblePaths = [
		// 1. 打包后的 dist 目录根（优先）
		path.join(basePath, fileName),
		// 2. 打包后的 dist 目录相对路径
		path.join(basePath, '..', fileName),
		// 3. 当前模块目录
		path.join(basePath, 'tree-sitter', fileName),
		// 4. 项目根目录
		path.join(process.cwd(), fileName),
		// 5. dist 目录（如果当前不在 dist 中）
		path.join(process.cwd(), 'dist', fileName),
		// 6. 源码目录（开发环境）
		path.join(process.cwd(), 'src', 'tree-sitter', fileName),
		// 7. node_modules 中的文件（开发环境备选）
		path.join(process.cwd(), 'node_modules', 'web-tree-sitter', fileName),
	]

	// 逐个检查文件是否存在
	for (const filePath of possiblePaths) {
		try {
			if (fs.existsSync(filePath)) {
				// console.log(`Found core tree-sitter WASM file at: ${filePath}`)
				return filePath
			}
		} catch (error) {
			// 忽略访问权限等错误，继续尝试下一个路径
			continue
		}
	}

	// 如果都找不到，抛出详细的错误信息
	const error = new Error(`无法找到核心 tree-sitter WASM 文件: ${fileName}`)
	;(error as any).details = {
		searchedPaths: possiblePaths,
		currentWorkingDirectory: process.cwd(),
		basePath,
		moduleUrl: typeof import.meta !== 'undefined' ? import.meta.url : undefined,
		dirname: typeof __dirname !== 'undefined' ? __dirname : undefined,
	}
	throw error
}

async function loadLanguage(langName: string) {
	try {
		const wasmPath = findWasmFile(langName)
		return await Parser.Language.load(wasmPath)
	} catch (error) {
		console.warn(`Failed to load language parser for ${langName}:`, error instanceof Error ? error.message : String(error))
		throw error
	}
}

let isParserInitialized = false
let initializationPromise: Promise<void> | null = null

export async function initializeParser() {
	// If already initialized, return immediately
	if (isParserInitialized) {
		return
	}

	// If initialization is in progress, wait for it to complete
	if (initializationPromise) {
		await initializationPromise
		return
	}

	// Start initialization
	initializationPromise = (async () => {
		// console.log("🌲 Initializing tree-sitter parser...\n")
		// 动态查找核心 tree-sitter.wasm 文件路径
		const wasmPath = findCoreTreeSitterWasm()
		await Parser.init({
			locateFile(scriptName: string, scriptDirectory: string) {
				if (scriptName === 'tree-sitter.wasm') {
					return wasmPath
				}
				return scriptDirectory + scriptName
			}
		})
		isParserInitialized = true
	})()

	await initializationPromise
	initializationPromise = null
}

/*
Using node bindings for tree-sitter is problematic in vscode extensions
because of incompatibility with electron. Going the .wasm route has the
advantage of not having to build for multiple architectures.

We use web-tree-sitter and tree-sitter-wasms which provides auto-updating prebuilt WASM binaries for tree-sitter's language parsers.

This function loads WASM modules for relevant language parsers based on input files:
1. Extracts unique file extensions
2. Maps extensions to language names
3. Loads corresponding WASM files (containing grammar rules)
4. Uses WASM modules to initialize tree-sitter parsers

This approach optimizes performance by loading only necessary parsers once for all relevant files.

Sources:
- https://github.com/tree-sitter/node-tree-sitter/issues/169
- https://github.com/tree-sitter/node-tree-sitter/issues/168
- https://github.com/Gregoor/tree-sitter-wasms/blob/main/README.md
- https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md
- https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/test/query-test.js
*/
export async function loadRequiredLanguageParsers(filesToParse: string[]): Promise<LanguageParser> {
	await initializeParser()
	const extensionsToLoad = new Set(filesToParse.map((file) => path.extname(file).toLowerCase().slice(1)))
	// console.log(`📝 Loading parsers for files: ${filesToParse.join(', ')} -> extensions: ${Array.from(extensionsToLoad).join(', ')}`)
	const parsers: LanguageParser = {}
	for (const ext of Array.from(extensionsToLoad)) {
		try {
			let language: Parser.Language
			let query: Parser.Query
			let parserKey = ext // Default to using extension as key
			switch (ext) {
				case "js":
				case "mjs":
				case "jsx":
				case "json":
					language = await loadLanguage("javascript")
					query = language.query(javascriptQuery)
					break
			case "ts":
				language = await loadLanguage("typescript")
				query = language.query(typescriptQuery)
				break
			case "tsx":
				language = await loadLanguage("tsx")
				query = language.query(tsxQuery)
				break
			case "py":
				language = await loadLanguage("python")
				query = language.query(pythonQuery)
				break
			case "rs":
				language = await loadLanguage("rust")
				query = language.query(rustQuery)
				break
			case "go":
				language = await loadLanguage("go")
				query = language.query(goQuery)
				break
			case "cpp":
			case "hpp":
				language = await loadLanguage("cpp")
				query = language.query(cppQuery)
				break
			case "c":
			case "h":
				language = await loadLanguage("c")
				query = language.query(cQuery)
				break
			case "cs":
				language = await loadLanguage("c_sharp")
				query = language.query(csharpQuery)
				break
			case "rb":
				language = await loadLanguage("ruby")
				query = language.query(rubyQuery)
				break
			case "java":
				language = await loadLanguage("java")
				query = language.query(javaQuery)
				break
			case "php":
				language = await loadLanguage("php")
				query = language.query(phpQuery)
				break
			case "swift":
				language = await loadLanguage("swift")
				query = language.query(swiftQuery)
				break
			case "kt":
			case "kts":
				language = await loadLanguage("kotlin")
				query = language.query(kotlinQuery)
				break
			case "css":
				language = await loadLanguage("css")
				query = language.query(cssQuery)
				break
			case "html":
				language = await loadLanguage("html")
				query = language.query(htmlQuery)
				break
			case "ml":
			case "mli":
				language = await loadLanguage("ocaml")
				query = language.query(ocamlQuery)
				break
			case "scala":
				language = await loadLanguage("scala")
				query = language.query(luaQuery) // Temporarily use Lua query until Scala is implemented
				break
			case "sol":
				language = await loadLanguage("solidity")
				query = language.query(solidityQuery)
				break
			case "toml":
				language = await loadLanguage("toml")
				query = language.query(tomlQuery)
				break
			case "vue":
				language = await loadLanguage("vue")
				query = language.query(vueQuery)
				break
			case "lua":
				language = await loadLanguage("lua")
				query = language.query(luaQuery)
				break
			case "rdl":
				language = await loadLanguage("systemrdl")
				query = language.query(systemrdlQuery)
				break
			case "tla":
				language = await loadLanguage("tlaplus")
				query = language.query(tlaPlusQuery)
				break
			case "zig":
				language = await loadLanguage("zig")
				query = language.query(zigQuery)
				break
			case "ejs":
			case "erb":
				language = await loadLanguage("embedded_template")
				parserKey = "embedded_template" // Use same key for both extensions
				query = language.query(embeddedTemplateQuery)
				break
			case "el":
				language = await loadLanguage("elisp")
				query = language.query(elispQuery)
				break
			case "ex":
			case "exs":
				language = await loadLanguage("elixir")
				query = language.query(elixirQuery)
				break
			default:
				console.warn(`Unsupported language: ${ext}`)
				continue
		}
		const parser = new Parser()
		parser.setLanguage(language)
		parsers[parserKey] = { parser, query }
		} catch (error) {
			console.warn(`Failed to load parser for extension ${ext}:`, error instanceof Error ? error.message : String(error))
			continue
		}
	}
	return parsers
}
