import { LanguageParser, loadRequiredLanguageParsers } from "./languageParser"
import { parseMarkdown } from "./markdownParser"
import { IFileSystem } from "../abstractions/core"
import { IWorkspace, IPathUtils } from "../abstractions/workspace"

/**
 * Dependencies for tree-sitter parsing functions
 */
export interface TreeSitterDependencies {
	fileSystem: IFileSystem
	workspace: IWorkspace
	pathUtils: IPathUtils
}

// Private constant
const DEFAULT_MIN_COMPONENT_LINES_VALUE = 4

// Getter function for MIN_COMPONENT_LINES (for easier testing)
let currentMinComponentLines = DEFAULT_MIN_COMPONENT_LINES_VALUE

/**
 * Get the current minimum number of lines for a component to be included
 */
export function getMinComponentLines(): number {
	return currentMinComponentLines
}

/**
 * Set the minimum number of lines for a component (for testing)
 */
export function setMinComponentLines(value: number): void {
	currentMinComponentLines = value
}

const extensions = [
	"tla",
	"js",
	"mjs",
	"jsx",
	"ts",
	"vue",
	"tsx",
	"py",
	// Rust
	"rs",
	"go",
	// C
	"c",
	"h",
	// C++
	"cpp",
	"hpp",
	// C#
	"cs",
	// Ruby
	"rb",
	"java",
	"php",
	"swift",
	// Solidity
	"sol",
	// Kotlin
	"kt",
	"kts",
	// Elixir
	"ex",
	"exs",
	// Elisp
	"el",
	// HTML
	"html",
	"htm",
	// Markdown
	"md",
	"markdown",
	// JSON
	"json",
	// CSS
	"css",
	// SystemRDL
	"rdl",
	// OCaml
	"ml",
	"mli",
	// Lua
	"lua",
	// Scala
	"scala",
	// TOML
	"toml",
	// Zig
	"zig",
	// Elm
	"elm",
	// Embedded Template
	"ejs",
	"erb",
	// Visual Basic .NET
	"vb",
].map((e) => `.${e}`)

export { extensions }

export async function parseSourceCodeDefinitionsForFile(
	filePath: string,
	dependencies: TreeSitterDependencies,
): Promise<string | undefined> {
	// check if the file exists
	const fileExists = await dependencies.fileSystem.exists(filePath)
	if (!fileExists) {
		return "This file does not exist or you do not have permission to access it."
	}

	// Get file extension to determine parser
	const ext = dependencies.pathUtils.extname(filePath).toLowerCase()
	// Check if the file extension is supported
	if (!extensions.includes(ext)) {
		return undefined
	}

	// Special case for markdown files
	if (ext === ".md" || ext === ".markdown") {
		// Check if we have permission to access this file
		if (await dependencies.workspace.shouldIgnore(filePath)) {
			return undefined
		}

		// Read file content
		const fileContentArray = await dependencies.fileSystem.readFile(filePath)
		const fileContent = new TextDecoder().decode(fileContentArray)

		// Split the file content into individual lines
		const lines = fileContent.split("\n")

		// Parse markdown content to get captures
		const markdownCaptures = parseMarkdown(fileContent)

		// Process the captures
		const markdownDefinitions = processCaptures(markdownCaptures, lines, "markdown")

		if (markdownDefinitions) {
			return `# ${dependencies.pathUtils.basename(filePath)}\n${markdownDefinitions}`
		}
		return undefined
	}

	// For other file types, load parser and use tree-sitter
	const languageParsers = await loadRequiredLanguageParsers([filePath])

	// Parse the file if we have a parser for it
	const definitions = await parseFile(filePath, languageParsers, dependencies)
	if (definitions) {
		return `# ${dependencies.pathUtils.basename(filePath)}\n${definitions}`
	}

	return undefined
}

// TODO: implement caching behavior to avoid having to keep analyzing project for new tasks.
export async function parseSourceCodeForDefinitionsTopLevel(
	dirPath: string,
	dependencies: TreeSitterDependencies,
): Promise<string> {
	// check if the path exists
	const dirExists = await dependencies.fileSystem.exists(dirPath)
	if (!dirExists) {
		return "This directory does not exist or you do not have permission to access it."
	}

	// Get all files at top level using workspace
	const allFiles = await dependencies.workspace.findFiles("**/*", undefined)

	let result = ""

	// Separate files to parse and remaining files
	const { filesToParse } = separateFiles(allFiles, dependencies.pathUtils)

	// Filter filepaths for access using workspace
	const allowedFilesToParse: string[] = []
	for (const file of filesToParse) {
		if (!(await dependencies.workspace.shouldIgnore(file))) {
			allowedFilesToParse.push(file)
		}
	}

	// Separate markdown files from other files
	const markdownFiles: string[] = []
	const otherFiles: string[] = []

	for (const file of allowedFilesToParse) {
		const ext = dependencies.pathUtils.extname(file).toLowerCase()
		if (ext === ".md" || ext === ".markdown") {
			markdownFiles.push(file)
		} else {
			otherFiles.push(file)
		}
	}

	// Load language parsers only for non-markdown files
	const languageParsers = await loadRequiredLanguageParsers(otherFiles)

	// Process markdown files
	for (const file of markdownFiles) {
		// Check if we have permission to access this file
		if (await dependencies.workspace.shouldIgnore(file)) {
			continue
		}

		try {
			// Read file content
			const fileContentArray = await dependencies.fileSystem.readFile(file)
			const fileContent = new TextDecoder().decode(fileContentArray)

			// Split the file content into individual lines
			const lines = fileContent.split("\n")

			// Parse markdown content to get captures
			const markdownCaptures = parseMarkdown(fileContent)

			// Process the captures
			const markdownDefinitions = processCaptures(markdownCaptures, lines, "markdown")

			if (markdownDefinitions) {
				const relativePath = dependencies.pathUtils.relative(dirPath, file)
				result += `# ${relativePath}\n${markdownDefinitions}\n`
			}
		} catch (error) {
			console.log(`Error parsing markdown file: ${error}\n`)
		}
	}

	// Process other files using tree-sitter
	for (const file of otherFiles) {
		const definitions = await parseFile(file, languageParsers, dependencies)
		if (definitions) {
			const relativePath = dependencies.pathUtils.relative(dirPath, file)
			result += `# ${relativePath}\n${definitions}\n`
		}
	}

	return result ? result : "No source code definitions found."
}

function separateFiles(allFiles: string[], pathUtils: IPathUtils): { filesToParse: string[]; remainingFiles: string[] } {
	const filesToParse = allFiles.filter((file) => extensions.includes(pathUtils.extname(file))).slice(0, 50) // 50 files max
	const remainingFiles = allFiles.filter((file) => !filesToParse.includes(file))
	return { filesToParse, remainingFiles }
}

/*
Parsing files using tree-sitter

1. Parse the file content into an AST (Abstract Syntax Tree) using the appropriate language grammar (set of rules that define how the components of a language like keywords, expressions, and statements can be combined to create valid programs).
2. Create a query using a language-specific query string, and run it against the AST's root node to capture specific syntax elements.
    - We use tag queries to identify named entities in a program, and then use a syntax capture to label the entity and its name. A notable example of this is GitHub's search-based code navigation.
	- Our custom tag queries are based on tree-sitter's default tag queries, but modified to only capture definitions.
3. Sort the captures by their position in the file, output the name of the definition, and format by i.e. adding "|----\n" for gaps between captured sections.

This approach allows us to focus on the most relevant parts of the code (defined by our language-specific queries) and provides a concise yet informative view of the file's structure and key elements.

- https://github.com/tree-sitter/node-tree-sitter/blob/master/test/query_test.js
- https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/test/query-test.js
- https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/test/helper.js
- https://tree-sitter.github.io/tree-sitter/code-navigation-systems
*/
/**
 * Parse a file and extract code definitions using tree-sitter
 *
 * @param filePath - Path to the file to parse
 * @param languageParsers - Map of language parsers
 * @param rooIgnoreController - Optional controller to check file access permissions
 * @returns A formatted string with code definitions or null if no definitions found
 */

/**
 * Process captures from tree-sitter or markdown parser
 *
 * @param captures - The captures to process
 * @param lines - The lines of the file
 * @param minComponentLines - Minimum number of lines for a component to be included
 * @returns A formatted string with definitions
 */
function processCaptures(captures: any[], lines: string[], language: string): string | null {
	// No definitions found
	if (captures.length === 0) {
		return null
	}

	let formattedOutput = ""

	// Sort captures by their start position
	captures.sort((a, b) => a.node.startPosition.row - b.node.startPosition.row)

	// Track already processed lines to avoid duplicates
	const processedLines = new Set<string>()

	const promoteToLineStartAncestor = (node: any): any => {
		let current = node
		const startRow = current?.startPosition?.row
		if (typeof startRow !== "number") return current

		// Prefer the highest ancestor that starts on the same line as the capture.
		// This typically maps `name.definition.*` captures back to their containing
		// definition node while keeping the output anchored to the correct line.
		while (
			current?.parent &&
			typeof current.parent.startPosition?.row === "number" &&
			current.parent.startPosition.row === startRow
		) {
			current = current.parent
		}
		return current
	}

	// First pass - categorize captures by type
	captures.forEach((capture) => {
		const { node, name } = capture

		// Skip captures that don't represent definitions or docstrings
		if (!name.includes("definition") && !name.includes("name") && name !== "docstring") {
			return
		}

		// For name captures (e.g. `name.definition.*`), promote to the nearest
		// containing node that starts on the same line so we can show the full
		// construct users expect (and tests rely on).
		const isNameDefinitionCapture = typeof name === "string" && name.includes("name.definition")

		// For docstrings, use the actual node.
		// For definitions, use the definition node itself.
		const definitionNode =
			name === "docstring" || name === "doc"
				? node
				: isNameDefinitionCapture
					? promoteToLineStartAncestor(node)
					: node
		if (!definitionNode) return

		// Get the start and end lines of the definition
		const startLine = definitionNode.startPosition.row
		const endLine = definitionNode.endPosition.row
		const lineCount = endLine - startLine + 1

		// Prefer showing the first non-empty line within the captured range.
		// This avoids outputting blank lines (common in fixtures that start with
		// a leading newline), while keeping the original end range.
		let displayStartLine = startLine
		while (displayStartLine <= endLine && (lines[displayStartLine] ?? "").trim() === "") {
			displayStartLine++
		}
		if (displayStartLine > endLine) {
			return
		}

		// Skip components that don't span enough lines
		if (lineCount < getMinComponentLines()) {
			return
		}

		// Create unique key for this definition based on line range
		// This ensures we don't output the same line range multiple times
		const lineKey = `${displayStartLine}-${endLine}`

		// Skip already processed lines
		if (processedLines.has(lineKey)) {
			return
		}

		// Check if this is a valid component definition (not an HTML element)
		const startLineContent = lines[displayStartLine].trim()

		// Special handling for docstrings
		if (name === "docstring") {
			// For docstrings, only show the docstring itself
			const docstringEndLine = node.endPosition.row
			const docstringLineCount = docstringEndLine - startLine + 1
			
			// Only include if the docstring spans at least the minimum lines
			if (docstringLineCount >= getMinComponentLines()) {
				const docstringKey = `${startLine}-${docstringEndLine}`
				if (!processedLines.has(docstringKey)) {
					formattedOutput += `${startLine + 1}--${docstringEndLine + 1} | ${lines[startLine]}\n`
					processedLines.add(docstringKey)
				}
			}
			return
		}

		// For other component definitions (classes, functions, etc.)
		formattedOutput += `${displayStartLine + 1}--${endLine + 1} | ${lines[displayStartLine]}\n`
		processedLines.add(lineKey)
	})

	if (formattedOutput.length > 0) {
		return formattedOutput
	}

	return null
}

/**
 * Parse a file and extract code definitions using tree-sitter
 *
 * @param filePath - Path to the file to parse
 * @param languageParsers - Map of language parsers
 * @param dependencies - Dependencies for file system, workspace, and path operations
 * @returns A formatted string with code definitions or null if no definitions found
 */
async function parseFile(
	filePath: string,
	languageParsers: LanguageParser,
	dependencies: TreeSitterDependencies,
): Promise<string | null> {
	// Check if we have permission to access this file
	if (await dependencies.workspace.shouldIgnore(filePath)) {
		return null
	}

	// Read file content
	const fileContentArray = await dependencies.fileSystem.readFile(filePath)
	const fileContent = new TextDecoder().decode(fileContentArray)
	const extLang = dependencies.pathUtils.extname(filePath).toLowerCase().slice(1)

	// Check if we have a parser for this file type
	const { parser, query } = languageParsers[extLang] || {}
	if (!parser || !query) {
		return `Unsupported file type: ${filePath}`
	}

	try {
		// Parse the file content into an Abstract Syntax Tree (AST)
		const tree = parser.parse(fileContent)

		// Apply the query to the AST and get the captures
		const captures = query.captures(tree.rootNode)

		// Split the file content into individual lines
		const lines = fileContent.split("\n")

		// Process the captures
		return processCaptures(captures, lines, extLang)
	} catch (error) {
		console.log(`Error parsing file: ${error}\n`)
		// Return null on parsing error to avoid showing error messages in the output
		return null
	}
}
