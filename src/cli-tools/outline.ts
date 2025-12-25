/**
 * CLI Tool: Code Outline Extractor
 *
 * Extracts code structure outlines from source files using tree-sitter parsing.
 * Provides both text and JSON output formats.
 *
 * Usage:
 *   codebase --outline <file>              # Text format
 *   codebase --outline <file> --json       # JSON format
 */

import { IFileSystem, IPathUtils, IWorkspace } from '../abstractions';
import { loadRequiredLanguageParsers } from '../tree-sitter/languageParser';
import { parseMarkdown } from '../tree-sitter/markdownParser';
import { getMinComponentLines, parseSourceCodeDefinitionsForFile } from '../tree-sitter';

/**
 * Options for outline extraction
 */
export interface OutlineOptions {
	/** Path to the file to extract outline from */
	filePath: string;
	/** Workspace root path (for resolving relative paths) */
	workspacePath: string;
	/** Whether to output JSON format */
	json: boolean;
	/** File system abstraction */
	fileSystem: IFileSystem;
	/** Workspace abstraction (optional, improves ignore/relative path handling) */
	workspace?: IWorkspace;
	/** Path utilities abstraction */
	pathUtils: IPathUtils;
	/** Logger (optional) */
	logger?: {
		info: (message: string) => void;
		error: (message: string) => void;
	};
}

/**
 * Extract code outline from a file
 *
 * @param options - Outline extraction options
 * @returns Formatted outline (text or JSON)
 */
export async function extractOutline(options: OutlineOptions): Promise<string> {
	const { filePath, workspacePath, json, fileSystem, pathUtils, logger } = options;

	// Resolve target path (handle both absolute and relative paths)
	let targetPath = filePath;
	if (!pathUtils.isAbsolute(filePath)) {
		targetPath = pathUtils.join(workspacePath, filePath);
	}

	// Check if file exists
	const exists = await fileSystem.exists(targetPath);
	if (!exists) {
		const error = `Error: File not found: ${targetPath}`;
		if (logger) {
			logger.error(error);
		}
		throw new Error(error);
	}

	// Check if file should be ignored (if workspace is provided)
	if (options.workspace && await options.workspace.shouldIgnore(targetPath)) {
		const error = `Error: File is ignored by workspace rules: ${targetPath}`;
		if (logger) {
			logger.error(error);
		}
		throw new Error(error);
	}

	// Return output based on format
	if (json) {
		const output = await getOutlineAsJson(targetPath, fileSystem, pathUtils);
		return output;
	} else {
		const output = await getOutlineAsText(
			targetPath,
			options.workspace ?? null,
			workspacePath,
			fileSystem,
			pathUtils
		);
		return output;
	}
}

function createFallbackWorkspace(workspaceRootPath: string, pathUtils: IPathUtils): IWorkspace {
	return {
		getRootPath: () => workspaceRootPath,
		getRelativePath: (fullPath: string) => pathUtils.relative(workspaceRootPath, fullPath),
		getIgnoreRules: () => [],
		shouldIgnore: async () => false,
		getName: () => 'outline-workspace',
		getWorkspaceFolders: () => [],
		findFiles: async () => []
	};
}

/**
 * Get outline as text format
 *
 * @param filePath - Absolute path to the file
 * @param workspace - Workspace abstraction (optional)
 * @param workspacePath - Workspace root path
 * @param fileSystem - File system abstraction
 * @param pathUtils - Path utilities abstraction
 * @returns Formatted text outline
 */
async function getOutlineAsText(
	filePath: string,
	workspace: IWorkspace | null,
	workspacePath: string,
	fileSystem: IFileSystem,
	pathUtils: IPathUtils
): Promise<string> {
	const output = await parseSourceCodeDefinitionsForFile(filePath, {
		fileSystem,
		workspace: workspace ?? createFallbackWorkspace(workspacePath, pathUtils),
		pathUtils
	});

	if (!output) {
		return `# ${pathUtils.basename(filePath)}\nNo code definitions found for this file type.`;
	}

	return output;
}

/**
 * Get outline as JSON format
 *
 * @param filePath - Absolute path to the file
 * @param fileSystem - File system abstraction
 * @param pathUtils - Path utilities abstraction
 * @returns JSON string with outline data
 */
async function getOutlineAsJson(
	filePath: string,
	fileSystem: IFileSystem,
	pathUtils: IPathUtils
): Promise<string> {
	// Read file content
	const fileContentArray = await fileSystem.readFile(filePath);
	const fileContent = new TextDecoder().decode(fileContentArray);
	const ext = pathUtils.extname(filePath).toLowerCase().slice(1);

	const languageParsers = await loadRequiredLanguageParsers([filePath]);

	const { parser, query } = languageParsers[ext] || {};

	// Handle unsupported file types
	if (!parser || !query) {
		// For markdown files, use markdown parser
		if (ext === 'md' || ext === 'markdown') {
			const captures = parseMarkdown(fileContent);
			const lines = fileContent.split(/\r?\n/);
			const definitions = processCapturesToJson(captures, lines, 'markdown', filePath);
			return JSON.stringify(definitions, null, 2);
		}

		return JSON.stringify({
			error: `Unsupported file type`,
			filePath,
			extension: ext
		}, null, 2);
	}

	// Parse the file
	const tree = parser.parse(fileContent);
	const captures = query.captures(tree.rootNode);
	const lines = fileContent.split(/\r?\n/);

	// Process captures to JSON format
	const definitions = processCapturesToJson(captures, lines, ext, filePath);

	return JSON.stringify(definitions, null, 2);
}

/**
 * Process captures into JSON format
 *
 * @param captures - Tree-sitter captures
 * @param lines - File content lines
 * @param language - Programming language
 * @param filePath - Full file path
 * @returns JSON object with definitions
 */
function processCapturesToJson(
	captures: any[],
	lines: string[],
	language: string,
	filePath: string
): {
	filePath: string;
	language: string;
	definitionCount: number;
	definitions: Array<{
		name: string;
		type: string;
		startLine: number;
		endLine: number;
		text: string;
		wasTruncated: boolean;
		textLength: number;
		lineContent: string;
	}>;
} {
	// Sort captures by start position
	captures.sort((a, b) => a.node.startPosition.row - b.node.startPosition.row);

	const getNodeText = (node: any): string => {
		if (!node) return '';
		if (typeof node.text === 'function') return String(node.text());
		if (typeof node.text === 'string') return node.text;
		return '';
	};

	const isDefinitionCaptureName = (captureName: string): boolean =>
		captureName.startsWith('definition.') || captureName === 'docstring' || captureName === 'doc';

	const isNameCaptureName = (captureName: string): boolean =>
		captureName === 'name' ||
		captureName === 'property.name.definition' ||
		captureName.startsWith('name.definition.');

	const extractKindFromCaptureName = (captureName: string): string => {
		if (captureName === 'docstring' || captureName === 'doc') return 'docstring';
		if (captureName.startsWith('definition.')) return captureName.slice('definition.'.length);
		if (captureName.startsWith('name.definition.')) return captureName.slice('name.definition.'.length);
		return captureName;
	};

	const isNodeWithin = (outer: any, inner: any): boolean => {
		if (!outer || !inner) return false;
		return (
			outer.startPosition?.row <= inner.startPosition?.row &&
			outer.endPosition?.row >= inner.endPosition?.row
		);
	};

	// Track processed lines to avoid duplicates
	const processedLines = new Set<string>();
	const definitions: Array<{
		name: string;
		type: string;
		startLine: number;
		endLine: number;
		text: string;
		wasTruncated: boolean;
		textLength: number;
		lineContent: string;
	}> = [];

	const definitionCaptures = captures.filter((c) => typeof c?.name === 'string' && isDefinitionCaptureName(c.name));
	const definitionNodes = definitionCaptures.map((c) => c.node);
	const nodeIdentifierMap = new Map<any, string>();

	// Map identifier nodes to their closest containing definition nodes (smallest span).
	for (const capture of captures) {
		const captureName = capture?.name;
		if (typeof captureName !== 'string' || !isNameCaptureName(captureName)) continue;

		const nameNode = capture?.node;
		if (!nameNode) continue;

		const candidateDefinitionNodes = definitionNodes.filter((defNode) => isNodeWithin(defNode, nameNode));
		if (candidateDefinitionNodes.length === 0) continue;

		const bestDefinitionNode = candidateDefinitionNodes.reduce((best: any, current: any) => {
			const bestSpan = (best.endPosition?.row ?? 0) - (best.startPosition?.row ?? 0);
			const currentSpan = (current.endPosition?.row ?? 0) - (current.startPosition?.row ?? 0);
			return currentSpan < bestSpan ? current : best;
		});

		let identifier = getNodeText(nameNode);
		if (
			captureName === 'property.name.definition' &&
			identifier.startsWith('"') &&
			identifier.endsWith('"')
		) {
			identifier = identifier.slice(1, -1);
		}
		if (identifier) {
			nodeIdentifierMap.set(bestDefinitionNode, identifier);
		}
	}

	// Only emit one record per definition capture.
	for (const capture of definitionCaptures) {
		const definitionNode = capture?.node;
		if (!definitionNode) continue;

		const startLine = definitionNode.startPosition.row;
		const endLine = definitionNode.endPosition.row;
		const lineCount = endLine - startLine + 1;

		// Find first non-empty line
		let displayStartLine = startLine;
		while (displayStartLine <= endLine && (lines[displayStartLine] ?? '').trim() === '') {
			displayStartLine++;
		}
		if (displayStartLine > endLine) {
			continue;
		}

		// Skip components that don't span enough lines
		if (lineCount < getMinComponentLines()) {
			continue;
		}

		const lineKey = `${displayStartLine}-${endLine}`;

		// Skip already processed lines
		if (processedLines.has(lineKey)) {
			continue;
		}

		const kind = extractKindFromCaptureName(String(capture.name));
		const identifier =
			nodeIdentifierMap.get(definitionNode) ||
			(typeof definitionNode.childForFieldName === 'function'
				? definitionNode.childForFieldName('name')?.text
				: null) ||
			null;

		// Get text preview (following plan: truncate at 50 chars with "first 50...last 50")
		const fullText = definitionNode.text;
		let textPreview = fullText;
		const maxLength = 50;
		let wasTruncated = false;

		if (fullText.length > maxLength) {
			wasTruncated = true;
			// Use "first 50...last 50" pattern as per plan
			const first = fullText.substring(0, 50);
			const last = fullText.substring(fullText.length - 20);
			textPreview = `${first} ... ${last}`;
		}

		// Get line content
		const lineContent = lines[displayStartLine]?.trim() || '';

		definitions.push({
			name: identifier ? String(identifier) : '',
			type: kind || String(definitionNode.type ?? ''),
			startLine: startLine + 1, // Convert to 1-indexed
			endLine: endLine + 1,     // Convert to 1-indexed
			text: textPreview,
			wasTruncated,
			textLength: fullText.length,
			lineContent
		});

		processedLines.add(lineKey);
	}

	return {
		filePath: filePath,
		language,
		definitionCount: definitions.length,
		definitions
	};
}
