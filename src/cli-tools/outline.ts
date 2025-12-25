/**
 * CLI Tool: Code Outline Extractor
 *
 * Extracts code structure outlines from source files using tree-sitter parsing.
 * Provides both text and JSON output formats with optional AI summarization.
 *
 * Usage:
 *   codebase --outline <file>                # Text format
 *   codebase --outline <file> --json         # JSON format
 *   codebase --outline <file> --summarize    # With AI summaries
 *   codebase --outline <file> --summarize --json  # JSON with summaries
 */

import { IFileSystem, IPathUtils, IWorkspace } from '../abstractions';
import { loadRequiredLanguageParsers } from '../tree-sitter/languageParser';
import { parseMarkdown } from '../tree-sitter/markdownParser';
import { getMinComponentLines } from '../tree-sitter';
import { createNodeDependencies } from '../adapters/nodejs';
import { CodeIndexServiceFactory } from '../code-index/service-factory';
import { CodeIndexConfigManager } from '../code-index/config-manager';
import { CacheManager } from '../code-index/cache-manager';
import { ISummarizer, SummarizerRequest } from '../code-index/interfaces';
import type { SummarizerConfig } from '../code-index/interfaces';
import * as path from 'path';

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
	/** Whether to generate AI summaries */
	summarize?: boolean;
	/** Optional config path (respects `--config`) */
	configPath?: string;
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
		warn?: (message: string) => void;
	};
}

/**
 * Structured definition from tree-sitter captures
 */
interface OutlineDefinition {
	name: string;
	type: string;
	startLine: number;
	endLine: number;
	fullText: string;
	lineContent: string;
	summary?: string;
}

/**
 * Structured outline data
 */
interface OutlineData {
	filePath: string;
	language: string;
	documentContent: string;  // Complete file content for summarization context
	definitions: OutlineDefinition[];
	fileSummary?: string;  // Summary for the entire file
}

/**
 * Extract code outline from a file
 *
 * @param options - Outline extraction options
 * @returns Formatted outline (text or JSON)
 */
export async function extractOutline(options: OutlineOptions): Promise<string> {
	const { filePath, workspacePath, json, summarize, configPath, fileSystem, pathUtils, logger } = options;

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
		const output = await getOutlineAsJson(targetPath, fileSystem, pathUtils, workspacePath, summarize, configPath, logger);
		return output;
	} else {
		const output = await getOutlineAsText(
			targetPath,
			options.workspace ?? null,
			workspacePath,
			fileSystem,
			pathUtils,
			summarize,
			configPath,
			logger
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
 * @param summarize - Whether to generate AI summaries
 * @returns Formatted text outline
 */
async function getOutlineAsText(
	filePath: string,
	workspace: IWorkspace | null,
	workspacePath: string,
	fileSystem: IFileSystem,
	pathUtils: IPathUtils,
	summarize?: boolean,
	configPath?: string,
	logger?: {
		info: (message: string) => void;
		error: (message: string) => void;
		warn?: (message: string) => void;
	}
): Promise<string> {
	// 1. Build structured definitions (NEW single source of truth)
	const outlineData = await buildOutlineDefinitions(
		filePath,
		fileSystem,
		pathUtils,
		workspace ?? createFallbackWorkspace(workspacePath, pathUtils)
	);

	if (!outlineData) {
		return `# ${pathUtils.basename(filePath)}\nNo code definitions found for this file type.`;
	}

	// 2. If no summarization requested, render directly
	if (!summarize) {
		return renderDefinitionsAsText(outlineData);
	}

	// 3. Create summarizer
	const summarizer = await createSummarizerForOutline(workspacePath, configPath);
	if (!summarizer) {
		if (logger?.warn) logger.warn('Warning: Summarizer not configured. Continuing without summaries.');
		else logger?.info('Warning: Summarizer not configured. Continuing without summaries.');
		return renderDefinitionsAsText(outlineData);
	}

	// 4. Generate summaries
	const config = await loadSummarizerConfig(workspacePath, configPath);
	const language = config?.language || 'English';

	// 4.1 Generate file-level summary
	try {
		const fileSummaryResult = await summarizer.summarize({
			content: outlineData.documentContent,
			document: outlineData.documentContent,
			language,
			codeType: 'file',
			codeName: pathUtils.basename(filePath),
			filePath: outlineData.filePath
		});
		outlineData.fileSummary = fileSummaryResult.summary;
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : 'Unknown error';
		if (logger?.warn) logger.warn(`Warning: Failed to summarize file: ${errorMsg}`);
		else logger?.error(`Warning: Failed to summarize file: ${errorMsg}`);
		// File summary failure is not fatal, continue with definition summaries
	}

	// 4.2 Generate summaries for each definition
	for (const def of outlineData.definitions) {
		try {
			// Skip very large blocks (>1000 lines) to avoid timeout
			// Note: startLine/endLine are 1-based and inclusive, so actual line count = end - start + 1
			const lineCount = def.endLine - def.startLine + 1;
			if (lineCount > 1000) {
				def.summary = `[Code too large to summarize (${lineCount} lines)]`;
				continue;
			}

			const result = await summarizer.summarize({
				content: def.fullText,
				document: outlineData.documentContent,  // Pass full document context
				language,
				codeType: def.type,
				codeName: def.name,
				filePath: outlineData.filePath
			});

			def.summary = result.summary;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			if (logger?.warn) logger.warn(`Warning: Failed to summarize ${def.type} ${def.name}: ${errorMsg}`);
			else logger?.error(`Warning: Failed to summarize ${def.type} ${def.name}: ${errorMsg}`);
			def.summary = `[Summary failed: ${errorMsg}]`;
		}
	}

	// 5. Render with summaries
	return renderDefinitionsAsText(outlineData);
}

/**
 * Get outline as JSON format
 *
 * @param filePath - Absolute path to the file
 * @param fileSystem - File system abstraction
 * @param pathUtils - Path utilities abstraction
 * @param workspacePath - Workspace root path
 * @param summarize - Whether to generate AI summaries
 * @returns JSON string with outline data
 */
async function getOutlineAsJson(
	filePath: string,
	fileSystem: IFileSystem,
	pathUtils: IPathUtils,
	workspacePath: string,
	summarize?: boolean,
	configPath?: string,
	logger?: {
		info: (message: string) => void;
		error: (message: string) => void;
		warn?: (message: string) => void;
	}
): Promise<string> {
	// 1. Build structured definitions (same as text path)
	const workspace = createFallbackWorkspace(workspacePath, pathUtils);
	const outlineData = await buildOutlineDefinitions(filePath, fileSystem, pathUtils, workspace);

	if (!outlineData) {
		return JSON.stringify({
			error: 'Unsupported file type',
			filePath,
			extension: pathUtils.extname(filePath)
		}, null, 2);
	}

	// 2. Generate summaries if requested
	if (summarize) {
		const summarizer = await createSummarizerForOutline(workspacePath, configPath);
		if (summarizer) {
			const config = await loadSummarizerConfig(workspacePath, configPath);
			const language = config?.language || 'English';

			// 2.1 Generate file-level summary
			try {
				const fileSummaryResult = await summarizer.summarize({
					content: outlineData.documentContent,
					document: outlineData.documentContent,
					language,
					codeType: 'file',
					codeName: pathUtils.basename(filePath),
					filePath: outlineData.filePath
				});
				outlineData.fileSummary = fileSummaryResult.summary;
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : 'Unknown error';
				if (logger?.warn) logger.warn(`Warning: Failed to summarize file: ${errorMsg}`);
				else logger?.error(`Warning: Failed to summarize file: ${errorMsg}`);
				// File summary failure is not fatal, continue with definition summaries
			}

			// 2.2 Generate summaries for each definition
			for (const def of outlineData.definitions) {
				try {
					// Note: startLine/endLine are 1-based and inclusive, so actual line count = end - start + 1
					const lineCount = def.endLine - def.startLine + 1;
					if (lineCount > 1000) {
						def.summary = `[Code too large to summarize (${lineCount} lines)]`;
						continue;
					}

					const result = await summarizer.summarize({
						content: def.fullText,
						document: outlineData.documentContent,  // Pass full document context
						language,
						codeType: def.type,
						codeName: def.name,
						filePath: outlineData.filePath
					});

					def.summary = result.summary;
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : 'Unknown error';
					if (logger?.warn) logger.warn(`Warning: Failed to summarize ${def.type} ${def.name}: ${errorMsg}`);
					else logger?.error(`Warning: Failed to summarize ${def.type} ${def.name}: ${errorMsg}`);
					def.summary = `[Summary failed: ${errorMsg}]`;
				}
			}
		} else {
			if (logger?.warn) logger.warn('Warning: Summarizer not configured. Continuing without summaries.');
		}
	}

	// 3. Render to JSON
	return renderDefinitionsAsJson(outlineData);
}

/**
 * Builds structured outline definitions from tree-sitter captures.
 * This is the SINGLE SOURCE OF TRUTH for both text and JSON output.
 */
async function buildOutlineDefinitions(
	filePath: string,
	fileSystem: IFileSystem,
	pathUtils: IPathUtils,
	workspace: IWorkspace
): Promise<OutlineData | null> {
	// Read file content
	const fileContentArray = await fileSystem.readFile(filePath);
	const fileContent = new TextDecoder().decode(fileContentArray);
	const lines = fileContent.split(/\r?\n/);
	const ext = pathUtils.extname(filePath).toLowerCase().slice(1);

	// Special handling for markdown files
	if (ext === 'md' || ext === 'markdown') {
		const captures = parseMarkdown(fileContent);
		const definitions = extractDefinitionsFromCaptures(captures, lines, filePath);
		return {
			filePath,
			language: ext,
			documentContent: fileContent,  // Include complete document for context
			definitions
		};
	}

	// Load language parsers
	const languageParsers = await loadRequiredLanguageParsers([filePath]);
	const { parser, query } = languageParsers[ext] || {};

	if (!parser || !query) {
		return null;  // Unsupported file type
	}

	// Parse with tree-sitter
	const tree = parser.parse(fileContent);
	const captures = query.captures(tree.rootNode);

	// Extract definitions
	const definitions = extractDefinitionsFromCaptures(captures, lines, filePath);

	return {
		filePath,
		language: ext,
		documentContent: fileContent,  // Include complete document for context
		definitions
	};
}

/**
 * Extracts structured definitions from tree-sitter captures.
 */
function extractDefinitionsFromCaptures(
	captures: any[],
	lines: string[],
	filePath: string
): OutlineDefinition[] {
	// Sort captures by start position
	captures.sort((a, b) => a.node.startPosition.row - b.node.startPosition.row);

	const isDefinitionCaptureName = (name: string): boolean =>
		// 过滤掉 docstring，只保留真正的定义
		name.startsWith('definition.');

	const isNameCaptureName = (name: string): boolean =>
		name === 'name' || name === 'property.name.definition' || name.startsWith('name.definition.');

	const extractKindFromCaptureName = (name: string): string => {
		// docstring 已被过滤，不需要特殊处理
		if (name.startsWith('definition.')) return name.slice('definition.'.length);
		if (name.startsWith('name.definition.')) return name.slice('name.definition.'.length);
		return name;
	};

	const isNodeWithin = (outer: any, inner: any): boolean => {
		if (!outer || !inner) return false;
		return (
			outer.startPosition?.row <= inner.startPosition?.row &&
			outer.endPosition?.row >= inner.endPosition?.row
		);
	};

	const getNodeText = (node: any): string => {
		if (!node) return '';
		if (typeof node.text === 'function') return String(node.text());
		if (typeof node.text === 'string') return node.text;
		return '';
	};

	// Filter definition captures
	const definitionCaptures = captures.filter((c) => typeof c?.name === 'string' && isDefinitionCaptureName(c.name));
	const definitionNodes = definitionCaptures.map((c) => c.node);
	const nodeIdentifierMap = new Map<any, string>();

	// Map identifiers to definitions
	for (const capture of captures) {
		const captureName = capture?.name;
		if (typeof captureName !== 'string' || !isNameCaptureName(captureName)) continue;

		const nameNode = capture?.node;
		if (!nameNode) continue;

		const candidates = definitionNodes.filter((defNode) => isNodeWithin(defNode, nameNode));
		if (candidates.length === 0) continue;

		const best = candidates.reduce((best: any, current: any) => {
			const bestSpan = (best.endPosition?.row ?? 0) - (best.startPosition?.row ?? 0);
			const currentSpan = (current.endPosition?.row ?? 0) - (current.startPosition?.row ?? 0);
			return currentSpan < bestSpan ? current : best;
		});

		let identifier = getNodeText(nameNode);
		if (captureName === 'property.name.definition' && identifier.startsWith('"') && identifier.endsWith('"')) {
			identifier = identifier.slice(1, -1);
		}
		if (identifier) {
			nodeIdentifierMap.set(best, identifier);
		}
	}

	// Build definitions
	const definitions: OutlineDefinition[] = [];
	const processedLines = new Set<string>();

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
		if (displayStartLine > endLine) continue;

		// Skip small components
		if (lineCount < getMinComponentLines()) continue;

		const lineKey = `${displayStartLine}-${endLine}`;
		if (processedLines.has(lineKey)) continue;

		const kind = extractKindFromCaptureName(String(capture.name));
		const identifier = nodeIdentifierMap.get(definitionNode) ||
			(typeof definitionNode.childForFieldName === 'function'
				? definitionNode.childForFieldName('name')?.text
				: null) || '';

		// Skip definitions without a name (e.g., decorated_definition wrapper nodes)
		if (!identifier) continue;

		// Extract FULL code content (not truncated)
		const fullText = getNodeText(definitionNode);
		const lineContent = lines[displayStartLine]?.trim() || '';

		definitions.push({
			name: String(identifier),
			type: kind || String(definitionNode.type ?? ''),
			startLine: startLine + 1,   // Convert to 1-indexed
			endLine: endLine + 1,         // Convert to 1-indexed
			fullText,                    // Complete code
			lineContent
		});

		processedLines.add(lineKey);
	}

	return definitions;
}

/**
 * Renders structured definitions to text outline format.
 */
function renderDefinitionsAsText(
	outlineData: OutlineData,
	indent: string = '   '
): string {
	const lines: string[] = [];

	// Calculate file line range
	const fileLines = outlineData.documentContent.split(/\r?\n/);
	const totalLines = fileLines.length;
	const fileRange = `L1-${totalLines}`;

	lines.push(`# ${fileRange} | ${outlineData.filePath}`);

	// Display file summary if available
	if (outlineData.fileSummary) {
		lines.push(`└─ ${outlineData.fileSummary}`);
	}

	lines.push('');

	let lastType = '';
	for (const def of outlineData.definitions) {
		// 在不同类型之间添加空行
		if (lastType && lastType !== def.type) {
			lines.push('');
		}
		lastType = def.type;

		// Compact mode: 显示类型+名称
		const displayContent = `${def.type} ${def.name}`;
		lines.push(`${indent}${def.startLine}--${def.endLine} | ${displayContent}`);
		if (def.summary) {
			lines.push(`${indent}└─ ${def.summary}`);
		}
	}

	return lines.join('\n');
}

/**
 * Renders structured definitions to JSON format.
 */
function renderDefinitionsAsJson(outlineData: OutlineData): string {
	const result = {
		filePath: outlineData.filePath,
		language: outlineData.language,
		definitionCount: outlineData.definitions.length,
		fileSummary: outlineData.fileSummary || null,
		definitions: outlineData.definitions.map(def => ({
			name: def.name,
			type: def.type,
			startLine: def.startLine,
			endLine: def.endLine,
			text: def.fullText.length > 50
				? `${def.fullText.substring(0, 50)} ... ${def.fullText.slice(-20)}`
				: def.fullText,
			fullText: def.fullText,
			wasTruncated: def.fullText.length > 50,
			textLength: def.fullText.length,
			lineContent: def.lineContent,
			summary: def.summary
		}))
	};

	return JSON.stringify(result, null, 2);
}

/**
 * Creates a summarizer instance for the outline tool.
 */
async function createSummarizerForOutline(
	workspacePath: string,
	configPath?: string
): Promise<ISummarizer | undefined> {
	try {
		const resolvedConfigPath = configPath || path.join(workspacePath, 'autodev-config.json');

		// Create dependencies using existing factory
		const deps = createNodeDependencies({
			workspacePath,
			storageOptions: {
				globalStoragePath: workspacePath
			},
			loggerOptions: {
				name: 'Outline',
				level: 'error',
				timestamps: false,
				colors: false
			},
			configOptions: {
				configPath: resolvedConfigPath
			}
		});

		// Load configuration (4-layer priority handled by ConfigProvider)
		await deps.configProvider.loadConfig();

		// Create config manager
		const configManager = new CodeIndexConfigManager(deps.configProvider);
		await configManager.initialize();

		// Create service factory
		const factory = new CodeIndexServiceFactory(
			configManager,
			workspacePath,
			new CacheManager(workspacePath)
		);

		// Create and return summarizer
		return factory.createSummarizer();
	} catch (error) {
		// Silently fail - summarization is optional
		return undefined;
	}
}

/**
 * Loads summarizer configuration for the outline tool.
 */
async function loadSummarizerConfig(
	workspacePath: string,
	configPath?: string
): Promise<SummarizerConfig | undefined> {
	try {
		const resolvedConfigPath = configPath || path.join(workspacePath, 'autodev-config.json');

		const deps = createNodeDependencies({
			workspacePath,
			storageOptions: { globalStoragePath: workspacePath },
			loggerOptions: { name: 'Outline', level: 'error', timestamps: false, colors: false },
			configOptions: {
				configPath: resolvedConfigPath
			}
		});

		await deps.configProvider.loadConfig();

		// Create config manager to access summarizer config
		const configManager = new CodeIndexConfigManager(deps.configProvider);
		await configManager.initialize();

		// Access summarizer config through configManager
		return configManager.summarizerConfig;
	} catch (error) {
		return undefined;
	}
}
