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

import { IFileSystem, IPathUtils, IWorkspace, IStorage } from '../abstractions';
import { loadRequiredLanguageParsers } from '../tree-sitter/languageParser';
import { parseMarkdown } from '../tree-sitter/markdownParser';
import { getMinComponentLines } from '../tree-sitter';
import { createNodeDependencies } from '../adapters/nodejs';
import { CodeIndexServiceFactory } from '../code-index/service-factory';
import { CodeIndexConfigManager } from '../code-index/config-manager';
import { CacheManager } from '../code-index/cache-manager';
import { ISummarizer, SummarizerRequest, SummarizerBatchRequest, SummarizerBatchResult } from '../code-index/interfaces';
import type { SummarizerConfig } from '../code-index/interfaces';
import { SummaryCacheManager } from './summary-cache';
import * as path from 'path';
import { DEFAULT_CONFIG } from '../code-index/constants';

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
  /** Whether to show only file-level summary (no function details) */
  title?: boolean;
  /** Whether to clear all summary caches before generating */
  clearSummarizeCache?: boolean;
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
    debug: (message: string) => void;
    info: (message: string) => void;
    error: (message: string) => void;
    warn?: (message: string) => void;
  };
  /** Skip workspace ignore checks (for single-file mode) */
  skipIgnoreCheck?: boolean;
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
  relativePath: string;  // Relative path from workspace root
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
  const { filePath, workspacePath, json, summarize, title, clearSummarizeCache, configPath, fileSystem, pathUtils, logger } = options;

  // Resolve target path (handle both absolute and relative paths)
  let targetPath = filePath;
  if (!pathUtils.isAbsolute(filePath)) {
    targetPath = pathUtils.join(workspacePath, filePath);
  }

  // Check if file exists
  const exists = await fileSystem.exists(targetPath);
  if (!exists) {
    const errorMsg = `File not found: ${targetPath}`;
    logger?.error(errorMsg);
    throw new Error(errorMsg);
  }

  // Check if file should be ignored (if workspace is provided and skipIgnoreCheck is false)
  if (!options.skipIgnoreCheck && options.workspace && await options.workspace.shouldIgnore(targetPath)) {
    throw new Error(`File is ignored by workspace rules: ${targetPath}`);
  }

  // Return output based on format
  if (json) {
    const output = await getOutlineAsJson(targetPath, fileSystem, pathUtils, workspacePath, summarize, title, clearSummarizeCache, configPath, logger);
    return output;
  } else {
    const output = await getOutlineAsText(
      targetPath,
      options.workspace ?? null,
      workspacePath,
      fileSystem,
      pathUtils,
      summarize,
      title,
      clearSummarizeCache,
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
    getGlobIgnorePatterns: async () => [],
    shouldIgnore: async () => false,
    getIgnoreService: () => {
      throw new Error('getIgnoreService not implemented in fallback workspace')
    },
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
  title?: boolean,
  clearSummarizeCache?: boolean,
  configPath?: string,
  logger?: {
    debug: (message: string) => void;
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
    return renderDefinitionsAsText(outlineData, title);
  }

  // 3. Create summarizer
  const summarizer = await createSummarizerForOutline(workspacePath, configPath);
  if (!summarizer) {
    if (logger?.warn) logger.warn('Warning: Summarizer not configured. Continuing without summaries.');
    else logger?.info('Warning: Summarizer not configured. Continuing without summaries.');
    return renderDefinitionsAsText(outlineData, title);
  }

  // 4. Apply cache and generate summaries
  await applySummaryCache(
    outlineData,
    filePath,
    workspacePath,
    summarizer,
    fileSystem,
    pathUtils,
    clearSummarizeCache,
    logger,
    title
  );

  // 5. Render with summaries
  return renderDefinitionsAsText(outlineData, title);
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
  title?: boolean,
  clearSummarizeCache?: boolean,
  configPath?: string,
  logger?: {
    debug: (message: string) => void;
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
      // Apply cache and generate summaries
      await applySummaryCache(
        outlineData,
        filePath,
        workspacePath,
        summarizer,
        fileSystem,
        pathUtils,
        clearSummarizeCache,
        logger,
        title
      );
    } else {
      if (logger?.warn) logger.warn('Warning: Summarizer not configured. Continuing without summaries.');
    }
  }

  // 3. Render to JSON
  return renderDefinitionsAsJson(outlineData, title);
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
  // Calculate relative path
  const relativePath = workspace.getRelativePath(filePath);

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
      relativePath,
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
    relativePath,
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
  title?: boolean,
  indent: string = '   '
): string {
  const lines: string[] = [];

  // Calculate file line count
  const fileLines = outlineData.documentContent.split(/\r?\n/);
  const totalLines = fileLines.length;

  lines.push(`# ${outlineData.relativePath} (${totalLines} lines)`);

  // Display file summary if available
  if (outlineData.fileSummary) {
    lines.push(`└─ ${outlineData.fileSummary}`);
  }

  // If title mode, only show file summary (no function details)
  if (title) {
    return lines.join('\n');
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
function renderDefinitionsAsJson(outlineData: OutlineData, title?: boolean): string {
  const result = {
    filePath: outlineData.filePath,
    language: outlineData.language,
    definitionCount: outlineData.definitions.length,
    fileSummary: outlineData.fileSummary || null,
    definitions: title ? [] : outlineData.definitions.map(def => ({
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
 * Creates a storage abstraction for the outline tool.
 */
export async function createStorageForOutline(workspacePath: string): Promise<IStorage> {
  const { createNodeDependencies } = await import('../adapters/nodejs');

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
    configOptions: {}
  });

  await deps.configProvider.loadConfig();

  return deps.storage;
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
        timestamps: true,
        colors: true
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

    // Create service factory (pass logger so summarizer can use it)
    const factory = new CodeIndexServiceFactory(
      configManager,
      workspacePath,
      new CacheManager(workspacePath),
      deps.logger
    );

    // Create and return summarizer
    return await factory.createSummarizer();
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

/**
 * Applies summary cache and generates new summaries if needed.
 * This is a shared utility for both text and JSON outline generation.
 */

/**
 * Batch summarization with concurrency control and retry logic
 * Processes code blocks in batches with configurable concurrency and retry behavior
 */
async function generateSummariesWithRetry(
  summarizer: ISummarizer,
  blocksNeedingSummaries: Array<{
    definition: OutlineDefinition;
    request: SummarizerRequest;
  }>,
  config: SummarizerConfig,
  logger?: {
    info: (message: string) => void;
    error: (message: string) => void;
    warn?: (message: string) => void;
  }
): Promise<void> {
  // Get batch processing configuration from config or use defaults
  const batchSize = config.batchSize ?? DEFAULT_CONFIG.summarizerBatchSize;
  const concurrency = config.concurrency ?? DEFAULT_CONFIG.summarizerConcurrency;
  const maxRetries = config.maxRetries ?? DEFAULT_CONFIG.summarizerMaxRetries;
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_CONFIG.summarizerRetryDelayMs;

  // Validate configuration values to prevent infinite loops and type errors
  // Use Number.isFinite() to check for valid finite numbers (not NaN, Infinity, or non-numeric)
  const validatedBatchSize = (Number.isFinite(batchSize) && (batchSize ?? 0) > 0 ? Math.floor(batchSize!) : DEFAULT_CONFIG.summarizerBatchSize) as number;
  const validatedConcurrency = (Number.isFinite(concurrency) && (concurrency ?? 0) > 0 ? Math.floor(concurrency!) : DEFAULT_CONFIG.summarizerConcurrency) as number;
  const validatedMaxRetries = (Number.isFinite(maxRetries) && (maxRetries ?? -1) >= 0 ? Math.floor(maxRetries!) : DEFAULT_CONFIG.summarizerMaxRetries) as number;
  const validatedRetryDelayMs = (Number.isFinite(retryDelayMs) && (retryDelayMs ?? -1) >= 0 ? Math.floor(retryDelayMs!) : DEFAULT_CONFIG.summarizerRetryDelayMs) as number;

  // Warn if configuration values were invalid and had to be corrected
  if (validatedBatchSize !== batchSize || validatedConcurrency !== concurrency ||
    validatedMaxRetries !== maxRetries || validatedRetryDelayMs !== retryDelayMs) {
    if (logger?.warn) {
      logger.warn(
        `Invalid summarizer batch config detected. Using corrected values: ` +
        `batchSize=${validatedBatchSize}, concurrency=${validatedConcurrency}, ` +
        `maxRetries=${validatedMaxRetries}, retryDelayMs=${validatedRetryDelayMs}`
      );
    }
  }

  // Group blocks into batches
  const batches: Array<typeof blocksNeedingSummaries> = [];
  for (let i = 0; i < blocksNeedingSummaries.length; i += validatedBatchSize) {
    batches.push(blocksNeedingSummaries.slice(i, i + validatedBatchSize));
  }

  logger?.info(
    `Processing ${blocksNeedingSummaries.length} blocks in ${batches.length} batches ` +
    `(batch size: ${validatedBatchSize}, concurrency: ${validatedConcurrency}, max retries: ${validatedMaxRetries})`
  );

  // Process batches with concurrency control
  let completedBatches = 0;
  const processBatch = async (batch: typeof blocksNeedingSummaries, batchIndex: number): Promise<void> => {
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < validatedMaxRetries) {
      try {
        // Try batch processing first
        const batchRequest: SummarizerBatchRequest = {
          document: batch[0].request.document, // Shared context
          filePath: batch[0].request.filePath, // Shared context
          blocks: batch.map(b => ({
            content: b.request.content,
            codeType: b.request.codeType,
            codeName: b.request.codeName
          })),
          language: batch[0].request.language as 'English' | 'Chinese'
        };

        const result: SummarizerBatchResult = await summarizer.summarizeBatch(batchRequest);

        // Update summaries
        for (let i = 0; i < batch.length; i++) {
          batch[i].definition.summary = result.summaries[i].summary;
        }

        completedBatches++;
        if (completedBatches % 5 === 0 || completedBatches === batches.length) {
          if (logger?.info) {
            logger.info(`Progress: ${completedBatches}/${batches.length} batches completed`);
          }
        }
        return; // Success, exit retry loop
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        attempt++;

        if (attempt < validatedMaxRetries) {
          // Exponential backoff
          const delay = validatedRetryDelayMs * Math.pow(2, attempt - 1);
          if (logger?.warn) {
            logger.warn(
              `Batch ${batchIndex + 1} failed (attempt ${attempt}/${validatedMaxRetries}): ` +
              `${lastError.message}. Retrying in ${delay}ms...`
            );
          }
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // Max retries reached, fall back to individual processing
          if (logger?.warn) {
            logger.warn(
              `Batch ${batchIndex + 1} failed after ${validatedMaxRetries} attempts. ` +
              `Falling back to individual processing...`
            );
          }

          for (const item of batch) {
            let individualAttempt = 0;
            while (individualAttempt < validatedMaxRetries) {
              try {
                const result = await summarizer.summarize(item.request);
                item.definition.summary = result.summary;
                break;
              } catch (individualError) {
                individualAttempt++;
                if (individualAttempt < validatedMaxRetries) {
                  const delay = validatedRetryDelayMs * Math.pow(2, individualAttempt - 1);
                  await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                  const errorMsg = individualError instanceof Error
                    ? individualError.message
                    : 'Unknown error';
                  item.definition.summary = `[Summary failed: ${errorMsg}]`;
                  if (logger?.warn) {
                    logger.warn(
                      `Failed to summarize ${item.request.codeType} ${item.request.codeName || ''}: ${errorMsg}`
                    );
                  }
                }
              }
            }
          }

          completedBatches++;
          if (completedBatches % 5 === 0 || completedBatches === batches.length) {
            if (logger?.info) {
              logger.info(`Progress: ${completedBatches}/${batches.length} batches completed`);
            }
          }
        }
      }
    }
  };

  // Process batches with concurrency control
  // createContext on @realtimex/node-llama-cpp is thread-safe (verified experimentally).
  // Each batch creates its own context so concurrent execution is safe.
  for (let i = 0; i < batches.length; i += validatedConcurrency) {
    const batchGroup = batches.slice(i, i + validatedConcurrency);
    await Promise.all(batchGroup.map((batch, j) => processBatch(batch, i + j)));
  }
}

async function applySummaryCache(
  outlineData: OutlineData,
  filePath: string,
  workspacePath: string,
  summarizer: ISummarizer,
  fileSystem: IFileSystem,
  pathUtils: IPathUtils,
  clearSummarizeCache?: boolean,
  logger?: {
    debug: (message: string) => void;
    info: (message: string) => void;
    error: (message: string) => void;
    warn?: (message: string) => void;
  },
  title?: boolean
): Promise<void> {
  // 1. Load cache configuration
  const config = await loadSummarizerConfig(workspacePath);
  if (!config) {
    if (logger?.warn) {
      logger.warn('Warning: Summarizer config not found. Skipping cache.');
    }
    return;
  }

  const cacheManager = new SummaryCacheManager(
    workspacePath,
    await createStorageForOutline(workspacePath),
    fileSystem,
    logger
  );

  // 2. Clear all caches if requested
  if (clearSummarizeCache) {
    logger?.info('Clearing all summary caches...');
    const removed = await cacheManager.clearAllCaches();
    logger?.info(`Cleared ${removed} cache file(s)`);
  }

  // 3. Preserve lineContent mapping before cache update
  const lineContentMap = new Map<string, string>();
  for (const def of outlineData.definitions) {
    lineContentMap.set(`${def.name}-${def.startLine}`, def.lineContent);
  }

  // 4. Filter blocks needing summarization
  const cacheResult = await cacheManager.filterBlocksNeedingSummarization(
    filePath,
    outlineData.documentContent,
    outlineData.definitions,
    config
  );

  // 4. Update outline data with cached summaries (preserve lineContent)
  outlineData.definitions = cacheResult.blocks.map(block => ({
    ...block,
    lineContent: lineContentMap.get(`${block.name}-${block.startLine}`) || ''
  }));
  outlineData.fileSummary = cacheResult.fileSummary;

  // 5. Log cache statistics
  logger?.info(
    `Cache stats: ${(cacheResult.stats.hitRate * 100).toFixed(1)}% hit rate ` +
    `(${cacheResult.stats.cachedBlocks}/${cacheResult.stats.totalBlocks} blocks)` +
    (cacheResult.stats.invalidReason ? ` [${cacheResult.stats.invalidReason}]` : '')
  );

  // 6. Generate new summaries only for blocks that need them
  if (cacheResult.stats.hitRate < 1) {
    const language = config?.language || 'English';

    // 6.1 Generate file-level summary if needed
    if (!cacheResult.fileSummary) {
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
      }
    }

    // 6.2 If title mode, skip function-level summaries
    if (title) {
      logger?.debug('Title mode: skipping function-level summaries');
    } else {
      // Collect blocks needing summaries (excluding very large blocks)
      const blocksNeedingSummaries: Array<{
        definition: OutlineDefinition;
        request: SummarizerRequest;
      }> = [];

      for (const def of outlineData.definitions) {
        // Skip if already has cached summary
        if (def.summary) continue;

        // Skip very large blocks (>1000 lines) to avoid timeout
        const lineCount = def.endLine - def.startLine + 1;
        if (lineCount > 1000) {
          def.summary = `[Code too large to summarize (${lineCount} lines)]`;
          continue;
        }

        blocksNeedingSummaries.push({
          definition: def,
          request: {
            content: def.fullText,
            document: outlineData.documentContent,
            language,
            codeType: def.type,
            codeName: def.name,
            filePath: outlineData.filePath
          }
        });
      }

      // 6.3 Generate summaries in batches with concurrency control
      if (blocksNeedingSummaries.length > 0) {
        await generateSummariesWithRetry(summarizer, blocksNeedingSummaries, config, logger);
      }
    }

    // 7. Update cache with new summaries
    await cacheManager.updateCache(
      filePath,
      outlineData.documentContent,
      outlineData.definitions,
      outlineData.fileSummary,
      config
    );
  }

}
