import * as path from "path"
import Parser from "web-tree-sitter"
import { resolveWasmPath, createLocateFileFunction } from "./wasm-loader"
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

async function loadLanguage(langName: string) {
	try {
		const wasmPath = resolveWasmPath(`tree-sitter-${langName}.wasm`)
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
		await Parser.init(createLocateFileFunction())
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
				// Silently skip unsupported file types (e.g., .cff, .yml, .sh)
				// console.warn(`Unsupported language: ${ext}`)
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
