/**
 * Simplified CLI for @autodev/codebase
 * Uses Node.js native parseArgs without React/Ink dependencies
 */
import { parseArgs } from 'node:util';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as jsoncParser from 'jsonc-parser';
import { saveJsoncPreservingComments } from './utils/jsonc-helpers';
import { ensureGitGlobalIgnorePatterns } from './utils/git-global-ignore';
import { createNodeDependencies } from './adapters/nodejs';
import { CodeIndexManager } from './code-index/manager';
import { CodebaseHTTPMCPServer } from './mcp/http-server.js';
import { StdioToStreamableHTTPAdapter } from './mcp/stdio-adapter.js';
import createSampleFiles from './examples/create-sample-files';
import { getGlobalLogger, setGlobalLogger, Logger, LogLevel } from './utils/logger';
import { VectorStoreSearchResult, SearchFilter } from './code-index/interfaces';
import { DEFAULT_CONFIG } from './code-index/constants';
import { CodeIndexConfig } from './code-index/interfaces/config';
import { ConfigValidator } from './code-index/config-validator';
import { validateLimit, validateMinScore } from './code-index/validate-search-params';

// Initialize global logger with CLI settings
function initGlobalLogger(level: LogLevel) {
  const logger = new Logger({
    name: 'CLI',
    level,
    timestamps: true,
    colors: process.stdout.isTTY
  });
  setGlobalLogger(logger);
}

// Helper function to get logger - just returns global logger
function getLogger() {
  return getGlobalLogger();
}

/**
 * 格式化搜索结果的接口
 */
interface SearchResult {
  payload?: {
    filePath?: string;
    codeChunk?: string;
    startLine?: number;
    endLine?: number;
    hierarchyDisplay?: string;
  } | null;
  score?: number;
}

/**
 * 格式化搜索结果显示，包含去重、分组和优化显示
 * @param results 搜索结果数组
 * @param query 搜索查询
 * @returns 格式化后的显示字符串
 */
function formatSearchResults(results: SearchResult[], query: string): string {
  if (!results || results.length === 0) {
    return `No results found for query: "${query}"`;
  }

  // 按文件路径分组搜索结果
  const resultsByFile = new Map<string, SearchResult[]>();
  results.forEach((result: SearchResult) => {
    const filePath = result.payload?.filePath || 'Unknown file';
    if (!resultsByFile.has(filePath)) {
      resultsByFile.set(filePath, []);
    }
    resultsByFile.get(filePath)!.push(result);
  });

  const formattedResults = Array.from(resultsByFile.entries()).map(([filePath, fileResults]) => {
    // 对同一文件的结果按分数降序排序
    fileResults.sort((a, b) => {
      const scoreA = a.score || 0;
      const scoreB = b.score || 0;
      return scoreB - scoreA; // 降序排列
    });

    // 去重：移除被其他片段包含的重复片段
    const deduplicatedResults = [];
    for (let i = 0; i < fileResults.length; i++) {
      const current = fileResults[i];
      const currentStart = current.payload?.startLine || 0;
      const currentEnd = current.payload?.endLine || 0;

      // 检查当前片段是否被其他片段包含
      let isContained = false;
      for (let j = 0; j < fileResults.length; j++) {
        if (i === j) continue; // 跳过自己

        const other = fileResults[j];
        const otherStart = other.payload?.startLine || 0;
        const otherEnd = other.payload?.endLine || 0;

        // 如果当前片段被其他片段完全包含，则标记为重复
        if (otherStart <= currentStart && otherEnd >= currentEnd &&
            !(otherStart === currentStart && otherEnd === currentEnd)) {
          isContained = true;
          break;
        }
      }

      // 如果没有被包含，则保留这个片段
      if (!isContained) {
        deduplicatedResults.push(current);
      }
    }

    // 使用去重后的结果计算平均分数
    const avgScore = deduplicatedResults.length > 0
      ? deduplicatedResults.reduce((sum, r) => sum + (r.score || 0), 0) / deduplicatedResults.length
      : 0;

    // 合并代码片段，优化显示格式
    const codeChunks = deduplicatedResults.map((result: SearchResult) => {
      const codeChunk = result.payload?.codeChunk || 'No content available';
      const startLine = result.payload?.startLine;
      const endLine = result.payload?.endLine;
      const lineInfo = (startLine !== undefined && endLine !== undefined)
          ? `(L${startLine}-${endLine})`
          : '';
      const hierarchyInfo = result.payload?.hierarchyDisplay ? `< ${result.payload?.hierarchyDisplay} > `
          : '';
      const score = result.score?.toFixed(3) || '1.000';
      return `${hierarchyInfo}${lineInfo}
${codeChunk}`;
    }).join('\n' + '─'.repeat(5) + '\n');

    const snippetInfo = deduplicatedResults.length > 1 ? ` | ${deduplicatedResults.length} snippets` : '';
    const duplicateInfo = fileResults.length !== deduplicatedResults.length
      ? ` (${fileResults.length - deduplicatedResults.length} duplicates removed)`
      : '';

    return {
      filePath,
      avgScore,
      formattedText: `${'='.repeat(50)}\nFile: "${filePath}"${snippetInfo}${duplicateInfo}\n${'='.repeat(50)}\n${codeChunks}`
    };
  });

  // 按文件平均分降序排序
  formattedResults.sort((a, b) => b.avgScore - a.avgScore);

  const fileCount = resultsByFile.size;
  const summary = `Found ${results.length} result${results.length > 1 ? 's' : ''} in ${fileCount} file${fileCount > 1 ? 's' : ''} for: "${query}"

`;

  // 提取格式化后的文本
  const formattedTexts = formattedResults.map(r => r.formattedText);
  return summary + formattedTexts.join('\n\n');



  return summary + formattedResults.join('\n\n');
}

function formatSearchResultsAsJson(results: SearchResult[], query: string): string {
  if (!results) {
    return JSON.stringify({
      query,
      totalResults: 0,
      snippets: []
    }, null, 2);
  }

  // 首先确保结果按分数降序排序
  results.sort((a, b) => {
    const scoreA = a.score || 0;
    const scoreB = b.score || 0;
    return scoreB - scoreA; // 降序排列
  });

  // 去重：移除被其他片段包含的重复片段（仅在同一个文件内）
  const deduplicatedResults = [];
  for (let i = 0; i < results.length; i++) {
    const current = results[i];
    const currentFilePath = current.payload?.filePath;
    const currentStart = current.payload?.startLine || 0;
    const currentEnd = current.payload?.endLine || 0;

    // 检查当前片段是否被其他片段包含（仅在同一个文件内）
    let isContained = false;
    for (let j = 0; j < results.length; j++) {
      if (i === j) continue; // 跳过自己

      const other = results[j];
      const otherFilePath = other.payload?.filePath;

      // 只有在同文件内才检查包含关系
      if (otherFilePath !== currentFilePath) continue;

      const otherStart = other.payload?.startLine || 0;
      const otherEnd = other.payload?.endLine || 0;

      // 如果当前片段被其他片段完全包含，则标记为重复
      if (otherStart <= currentStart && otherEnd >= currentEnd &&
          !(otherStart === currentStart && otherEnd === currentEnd)) {
        isContained = true;
        break;
      }
    }

    // 如果没有被包含，则保留这个片段
    if (!isContained) {
      deduplicatedResults.push(current);
    }
  }

  // 转换格式
  const snippets = deduplicatedResults.map((result: SearchResult) => {
    const startLine = result.payload?.startLine;
    const endLine = result.payload?.endLine;
    return {
      filePath: result.payload?.filePath || 'Unknown file',
      code: result.payload?.codeChunk || '',
      startLine: startLine,
      endLine: endLine,
      lineRange: startLine !== undefined && endLine !== undefined ? `L${startLine}-${endLine}` : '',
      hierarchy: result.payload?.hierarchyDisplay || '',
      score: parseFloat((result.score || 0).toFixed(3))
    };
  });

  const jsonResponse = {
    query,
    totalResults: results.length,
    totalSnippets: deduplicatedResults.length,
    duplicatesRemoved: results.length - deduplicatedResults.length,
    snippets: snippets
  };

  return JSON.stringify(jsonResponse, null, 2);
}

// CLI Options interface
interface SimpleCliOptions {
  path: string;
  port: number;
  host: string;
  serverUrl?: string;
  timeoutMs?: number;
  config?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  demo: boolean;
  force: boolean;
  storage?: string;
  cache?: string;
  json: boolean;
  pathFilters?: string;
  limit?: string;
  'min-score'?: string;
  outline?: string;
  summarize?: boolean;
  dryRun?: boolean;
}

// Parse command line arguments using Node.js native parseArgs
const { values, positionals } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h' },
    serve: { type: 'boolean', short: 's' },
    'stdio-adapter': { type: 'boolean' },
    index: { type: 'boolean', short: 'i' },
    search: { type: 'string', short: 'q' },
    watch: { type: 'boolean', short: 'w' },
    clear: { type: 'boolean' },
    outline: { type: 'string' },
    summarize: { type: 'boolean' },
    // Path and config options
    path: { type: 'string', short: 'p', default: '.' },
    config: { type: 'string', short: 'c' },
    // Search filtering options
    'path-filters': { type: 'string', short: 'f' },
    // 添加limit和min-score参数
    limit: { type: 'string', short: 'l' },
    'min-score': { type: 'string', short: 'S' },
    // MCP server options
    port: { type: 'string', default: '3001' },
    host: { type: 'string', default: 'localhost' },
    // Stdio adapter options
    'server-url': { type: 'string' },
    timeout: { type: 'string' },
    // Logging
    'log-level': { type: 'string', default: 'error' },
    // Demo mode
    demo: { type: 'boolean' },
    force: { type: 'boolean' },
    // Storage paths
    storage: { type: 'string' },
    cache: { type: 'string' },
    // JSON output
    json: { type: 'boolean' },
    // Dry run option
    'dry-run': { type: 'boolean' },
    // Configuration management
    'get-config': { type: 'boolean' },
    'set-config': { type: 'string' },
    global: { type: 'boolean' },
  },
  allowPositionals: true
});

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
@autodev/codebase - Simplified CLI Codebase

Usage:
  codebase --serve               Start MCP HTTP MCP server
  codebase --stdio-adapter       Start stdio adapter (bridge stdio <-> HTTP MCP server)
  codebase --index               Index the codebase
  codebase --search="query"      Search the index (short: -q)
  codebase --outline <file>      Extract code outline from a file
  codebase --clear               Clear index data
  codebase --get-config [items...] View all config layers (default → global → project → effective)
  codebase --set-config k=v,...  Set project configuration (also updates Git global ignore)
  codebase --help                Show this help

Configuration Management:
  --get-config [items...]        View all config layers (default → global → project → effective)
  --get-config --json            Output in JSON format (script-friendly)
  --set-config k=v,...           Set project configuration (also updates Git global ignore)
  --set-config --global          Set global configuration
  --global                       Set global configuration (only used with --set-config)

Options:
  --path, -p <path>             Working directory path (default: current directory)
  --port <port>                 MCP server port (default: 3001)
  --host <host>                 MCP server host (default: localhost)
  --stdio-adapter               Run in stdio adapter mode (no indexing, no HTTP server)
  --server-url <url>            Target MCP HTTP endpoint (default: http://<host>:<port>/mcp)
  --timeout <ms>                Stdio adapter request timeout in ms (default: 30000)
  --config, -c <path>           Configuration file path
  --log-level <level>           Log level: debug|info|warn|error (default: error)
  --demo                        Create demo files in workspace
  --force                       Force reindex all files, ignoring cache
  --storage <path>              Custom storage path
  --cache <path>                Custom cache path
  --json                        Output results in JSON format
  --path-filters, -f <filters>   Filter search results by path patterns (comma-separated)
                                Logic:
                                - Include patterns (no ! prefix): OR logic - matches ANY pattern
                                - Exclude patterns (! prefix): AND logic - applied globally to exclude ALL matches
                                - Within each pattern: case-insensitive substring matching, order-independent
                                Supported: ** (recursive), * (single-level), {a,b} (braces), !prefix (exclude)
                                Examples:
                                  -f "src/**/*.ts"                # src tree only
                                  -f "components/*.tsx"           # all .tsx in components
                                  -f "{src,lib}/**/*.js"          # .js files in multiple dirs
                                  -f "!.md,!.txt"                 # exclude markdown/text files
                                  -f "src/**/*.ts,lib/**/*.ts"    # src OR lib .ts files
                                  -f "**/*.ts,!**/*.test.ts"      # all .ts excluding tests
  --limit, -l <number>           Maximum number of search results (default: from config, max 50)
                                Examples: --limit=30, -l 20
  --min-score, -S <number>       Minimum similarity score for search results (0-1, default: from config)
                                Examples: --min-score=0.7, -S 0.5
                                0 means accept all results, 1 means exact match only
  --outline <pattern>            Extract code outline from file(s) using tree-sitter parsing
                                Supports comma-separated patterns and exclusions (consistent with --path-filters):
                                - Include patterns (no ! prefix): OR logic - matches ANY pattern
                                - Exclude patterns (! prefix): AND logic - applied globally to exclude ALL matches
                                - Supports: ** (recursive), * (single-level), {a,b} (braces), !prefix (exclude)
                                Shows code structure with line ranges (e.g., 15--26)
                                Add --summarize to generate AI summaries for each code block
                                Add --json for detailed JSON output with metadata
                                Add --dry-run to preview matched files without extracting
                                Note: Glob patterns respect .gitignore/.rooignore/.codebaseignore,
                                      but single-file paths skip ignore checks (process any file directly)
                                Examples:
                                  --outline src/index.ts                                   # single file
                                  --outline "src/**/*.ts"                                  # single pattern
                                  --outline "src/**/*.ts,lib/**/*.ts"                      # multiple patterns (OR)
                                  --outline "src/**/*.ts,!**/*.test.ts"                    # include + exclude
                                  --outline "{src,test}/**/*.ts,!**/*.{test,spec}.ts"      # braces + exclusion
                                  --outline "src/**/*.ts" --dry-run                        # preview matched files
  --dry-run                      Preview files matched by the outline pattern without extracting
                                Lists all files that would be processed, useful for verifying filters
                                Must be used with --outline
                                Examples:
                                  --outline "src/**/*.ts" --dry-run                       # preview matched files
                                  --outline "src/**/*.ts,!test*.ts" --dry-run              # verify exclusions


Examples:
  # Start MCP server
  codebase --serve --path=/my/project

  # Start stdio adapter and connect to an existing MCP HTTP server
  codebase --stdio-adapter --server-url=http://localhost:3001/mcp

  # Index codebase
  codebase --index --path=/my/project

  # Search for code
  codebase --search="user authentication"

  # Search for code in JSON format
  codebase --search="user authentication" --json

  # Extract code outline from a file
  codebase --outline src/index.ts

  # Extract code outline using glob patterns
  codebase --outline "src/**/*.ts"
  codebase --outline "**/*.py" --summarize
  codebase --outline lib/utils.py --json

  # Extract code outline with AI summaries
  codebase --outline src/index.ts --summarize
  codebase --outline lib/utils.py --summarize --json

  # Clear index
  codebase --clear --path=/my/project

  # Configuration Management Examples:
  # View all config layers
  codebase --get-config

  # View specific config item layers
  codebase --get-config embedderProvider qdrantUrl

  # View in JSON format
  codebase --get-config --json
  codebase --get-config embedderProvider --json

  # Set project config
  codebase --set-config embedderProvider=ollama,embedderModelId=nomic-embed-text

  # Set global config
  codebase --set-config --global embedderProvider=openai,embedderOpenAiApiKey=sk-xxx

  # With custom paths
  codebase --path /my/project --get-config
  codebase --path /my/project --set-config key=value

  # Run with demo files
  codebase --serve --demo --log-level=debug

Note: Values containing commas will be split and cause an error (missing '=' in subsequent parts). For complex values, edit config files directly.
`);
}

/**
 * Resolve options from parsed arguments
 */
function resolveOptions(): SimpleCliOptions {
  let resolvedPath = values.path || '.';
  if (!path.isAbsolute(resolvedPath)) {
    resolvedPath = path.join(process.cwd(), resolvedPath);
  }

  const workspacePath = values.demo
    ? path.join(resolvedPath, 'demo')
    : resolvedPath;

  const timeoutMs = values.timeout ? parseInt(values.timeout, 10) : undefined;

  return {
    path: workspacePath,
    port: parseInt(values.port || '3001', 10),
    host: values.host || 'localhost',
    serverUrl: values['server-url'],
    timeoutMs: !Number.isNaN(timeoutMs || NaN) ? timeoutMs : undefined,
    config: values.config,
    logLevel: values['log-level'] as SimpleCliOptions['logLevel'],
    demo: !!values.demo,
    force: !!values.force,
    storage: values.storage,
    cache: values.cache,
    json: !!values.json,
    pathFilters: values['path-filters'],
    limit: values.limit,
    'min-score': values['min-score'],
    outline: values.outline,
    summarize: !!values.summarize,
    dryRun: !!values['dry-run'],
  };
}

/**
 * Create dependencies for CodeIndexManager
 */
function createDependencies(options: SimpleCliOptions) {
  const configPath = options.config || path.join(options.path, 'autodev-config.json');

  return createNodeDependencies({
    workspacePath: options.path,
    storageOptions: {
      globalStoragePath: options.storage || path.join(process.cwd(), '.autodev-storage'),
      ...(options.cache && { cacheBasePath: options.cache })
    },
    loggerOptions: {
      name: 'Autodev-Codebase-CLI',
      level: options.logLevel,
      timestamps: true,
      colors: true
    },
    configOptions: {
      configPath
    }
  });
}

/**
 * Initialize CodeIndexManager
 * @param options CLI options
 * @param initOptions Manager initialization options
 */
async function initializeManager(
  options: SimpleCliOptions,
  initOptions?: { searchOnly?: boolean }
): Promise<CodeIndexManager | undefined> {
  const deps = createDependencies(options);

  // Create demo files if requested
  if (options.demo) {
    const workspaceExists = await deps.fileSystem.exists(options.path);
    if (!workspaceExists) {
      fs.mkdirSync(options.path, { recursive: true });
      await createSampleFiles(deps.fileSystem, options.path);
      getLogger().info(`Demo files created in: ${options.path}`);
    }
  }

  // Load and validate configuration
  getLogger().info('Loading configuration...');
  await deps.configProvider.loadConfig();

  const validation = await deps.configProvider.validateConfig();
  if (!validation.isValid) {
    getLogger().warn('Configuration validation warnings:', validation.errors);
  } else {
    getLogger().info('Configuration validation passed');
  }

  // Create CodeIndexManager
  getLogger().info('Creating CodeIndexManager...');
  const manager = CodeIndexManager.getInstance(deps);

  if (!manager) {
    getLogger().error('Failed to create CodeIndexManager - workspace root path may be invalid');
    return undefined;
  }

  // Initialize manager
  getLogger().info('Initializing CodeIndexManager...');
  await manager.initialize({ force: options.force, ...initOptions });
  getLogger().info('CodeIndexManager initialization success');

  return manager;
}

/**
 * Start MCP Server
 */
async function startMCPServer(options: SimpleCliOptions): Promise<void> {
  getLogger().info('Starting MCP Server Mode');
  getLogger().info(`Workspace: ${options.path}`);

  const manager = await initializeManager(options);
  if (!manager) {
    process.exit(1);
  }

  // Start MCP Server
  getLogger().info('Starting MCP Server...');
  const server = new CodebaseHTTPMCPServer({
    codeIndexManager: manager,
    port: options.port,
    host: options.host
  });

  await server.start();
  getLogger().info('MCP Server started successfully');

  // Display configuration instructions
  getLogger().info('\nMCP Server is now running!');
  getLogger().info('To connect your IDE to the HTTP Streamable MCP server, use the following configuration:');
  console.log(JSON.stringify({
    "mcpServers": {
      "codebase": {
        "url": `http://${options.host}:${options.port}/mcp`
      }
    }
  }, null, 2));

  // Start indexing in background
  getLogger().info('Starting indexing process...');
  manager.onProgressUpdate((progressInfo) => {
    getLogger().info(`Indexing progress: ${progressInfo.systemStatus} - ${progressInfo.message || ''}`);
  });

  if (manager.isFeatureEnabled && manager.isInitialized) {
    manager.startIndexing(options.force)
      .then(() => {
        getLogger().info('Indexing completed');
      })
      .catch((err: Error) => {
        getLogger().error('Indexing failed:', err.message);
      });
  } else {
    getLogger().warn('Skipping indexing - feature not enabled or not initialized');
  }

  // Handle graceful shutdown
  const handleShutdown = async () => {
    getLogger().info('\nShutting down MCP Server...');
    await server.stop();
    getLogger().info('MCP Server stopped');
    process.exit(0);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  getLogger().info('MCP Server is ready for connections. Press Ctrl+C to stop.');

  // Keep the process alive
  return new Promise(() => {}); // This never resolves, keeping the server running
}

/**
 * Wait for indexing to complete on a given manager instance.
 * Shared by `--index` 与自动索引搜索场景。
 */
async function waitForIndexingCompletion(manager: CodeIndexManager): Promise<void> {
  return new Promise((resolve, reject) => {
    const checkState = () => {
      const currentState = manager.state;
      getLogger().info(`Current state: ${currentState}`);

      if (currentState === 'Indexed') {
        getLogger().info('Indexing completed successfully');
        resolve();
      } else if (currentState === 'Error') {
        getLogger().error('Indexing failed');
        reject(new Error('Indexing failed'));
      } else if (currentState === 'Standby') {
        getLogger().warn('Indexing stopped unexpectedly');
        reject(new Error('Indexing stopped unexpectedly'));
      } else {
        // Still indexing, check again in 2 seconds
        setTimeout(checkState, 2000);
      }
    };

    manager.startIndexing()
      .then(() => {
        // Start monitoring the state
        setTimeout(checkState, 2000);
      })
      .catch(reject);
  });
}

/**
 * Index the codebase
 */
async function indexCodebase(options: SimpleCliOptions): Promise<void> {
  getLogger().info('Starting indexing mode');
  getLogger().info(`Workspace: ${options.path}`);

  const manager = await initializeManager(options);
  if (!manager) {
    process.exit(1);
  }

  if (!manager.isFeatureEnabled) {
    getLogger().error('Code indexing feature is not enabled');
    process.exit(1);
  }

  try {
    getLogger().info('Starting indexing process...');

    // Set up progress monitoring
    manager.onProgressUpdate((progressInfo) => {
      getLogger().info(`Indexing progress: ${progressInfo.systemStatus} - ${progressInfo.message || ''}`);
    });

    // Wait for indexing to complete
    await waitForIndexingCompletion(manager);
  } finally {
    // Ensure watcher is stopped so the process can exit cleanly
    manager.dispose();
    getLogger().info('Indexing mode completed. Exiting...');
  }
}

/**
 * Split path filters by comma, but respect brace expansion {a,b}
 * @param filtersString Comma-separated filter string
 * @returns Array of filter patterns
 */
function parsePathFilters(filtersString: string): string[] {
  const filters: string[] = []
  let current = ''
  let braceDepth = 0

  for (let i = 0; i < filtersString.length; i++) {
    const char = filtersString[i]

    if (char === '{') {
      braceDepth++
      current += char
    } else if (char === '}') {
      braceDepth--
      current += char
    } else if (char === ',' && braceDepth === 0) {
      // Only split on comma when not inside braces
      const trimmed = current.trim()
      if (trimmed.length > 0) {
        filters.push(trimmed)
      }
      current = ''
    } else {
      current += char
    }
  }

  // Add the last segment
  const trimmed = current.trim()
  if (trimmed.length > 0) {
    filters.push(trimmed)
  }

  return filters
}

/**
  * Search the index
  */
  async function searchIndex(query: string, options: SimpleCliOptions): Promise<void> {
  getLogger().info('Search mode');
  getLogger().info(`Query: "${query}"`);
  getLogger().info(`Workspace: ${options.path}`);

  // Parse path filters if provided
  const filter: SearchFilter = {};
  if (options.pathFilters) {
    const filters = parsePathFilters(options.pathFilters)
      .map((f: string) => f.startsWith('=') ? f.slice(1) : f) // Remove leading '=' from short format args
      .filter((f: string) => f.length > 0);
    filter.pathFilters = filters;
    getLogger().info(`Path filters: ${filters.join(', ')}`);
  }

  // 只有用户显式传入才设置，否则让 service/config 决定
  if (options.limit !== undefined) {
    filter.limit = validateLimit(options.limit);
    getLogger().info(`Limit: ${filter.limit}`);
  }

  if (options['min-score'] !== undefined) {
    filter.minScore = validateMinScore(options['min-score']);
    getLogger().info(`Min score: ${filter.minScore}`);
  }

  // Debug: Log parsed options
  getLogger().info(`Debug: pathFilters value = "${options.pathFilters}"`);
  getLogger().info(`Debug: limit value = "${options.limit}"`);
  getLogger().info(`Debug: min-score value = "${options['min-score']}"`);
  getLogger().info(`Debug: filter object =`, filter);

  // Use searchOnly to prevent background indexing from starting
  const manager = await initializeManager(options, { searchOnly: true });
  if (!manager) {
    process.exit(1);
  }

  if (!manager.isFeatureEnabled) {
    getLogger().error('Code indexing feature is not enabled');
    process.exit(1);
  }

  try {
    getLogger().info('Searching index (first attempt)...');
    let results: VectorStoreSearchResult[];

    try {
      results = await manager.searchIndex(query, filter);
    } catch (error) {
      // 如果索引尚未准备好，则先执行一次索引再重试搜索
      if (error instanceof Error && error.message.startsWith('Code index is not ready for search')) {
        getLogger().info('Index is not ready. Running indexing before search...');
        await waitForIndexingCompletion(manager);
        getLogger().info('Retrying search after indexing...');
        results = await manager.searchIndex(query, filter);
      } else {
        throw error;
      }
    }

    // 根据json选项选择输出格式
    if (options.json) {
      const jsonOutput = formatSearchResultsAsJson(results as SearchResult[], query);
      console.log(jsonOutput);
    } else {
      const formattedOutput = formatSearchResults(results as SearchResult[], query);
      console.log(formattedOutput);
    }

    if (!results || results.length === 0) {
      getLogger().info('No results found');
      return;
    }
  } catch (error) {
    if (error instanceof Error) {
      getLogger().error('Search failed:', error.message);
    } else {
      getLogger().error('Search failed with unknown error:', error);
    }
    process.exit(1);
  } finally {
    // 停止后台服务以允许程序退出
    manager.dispose();
    getLogger().info('Search completed. Exiting...');
  }
}

/**
 * Clear index data
 */
async function clearIndex(options: SimpleCliOptions): Promise<void> {
  getLogger().info('Clear index mode');
  getLogger().info(`Workspace: ${options.path}`);

  // 使用 searchOnly 模式初始化：
  // - 只连接到向量存储，不自动启动后台索引
  // - 避免在仅清理数据时触发不必要的 full indexing 流程
  const manager = await initializeManager(options, { searchOnly: true });
  if (!manager) {
    process.exit(1);
  }

  if (!manager.isFeatureEnabled) {
    getLogger().error('Code indexing feature is not enabled');
    process.exit(1);
  }

  getLogger().info('Clearing index data...');
  await manager.clearIndexData();
  getLogger().info('Index data cleared successfully');
}

/**
 * Start stdio adapter mode.
 *
 * This bridges stdio-based MCP clients (e.g. Claude Desktop) to an existing
 * HTTP/Streamable MCP server (CodebaseHTTPMCPServer or any compatible server).
 */
async function startStdioAdapter(options: SimpleCliOptions): Promise<void> {
  // Derive default target from host/port, allow explicit override via --server-url
  const targetUrl =
    options.serverUrl || `http://${options.host}:${options.port}/mcp`;
  const timeout =
    options.timeoutMs && !Number.isNaN(options.timeoutMs)
      ? options.timeoutMs
      : 30000;

  getLogger().info('Starting stdio adapter mode');
  getLogger().info(`Target MCP HTTP endpoint: ${targetUrl}`);
  getLogger().info(`Request timeout: ${timeout}ms`);

  const adapter = new StdioToStreamableHTTPAdapter({
    serverUrl: targetUrl,
    timeout,
  });

  const handleShutdown = () => {
    getLogger().info('Shutting down stdio adapter...');
    adapter.stop();
    process.exit(0);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  await adapter.start();

  // Adapter keeps the process alive by listening on stdin; no further work here.
  return new Promise(() => {}); // never resolves
}

/**
 * Format configuration value for display
 */
function formatValue(value: any): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Sanitize sensitive configuration values
 */
function sanitizeConfig(config: Record<string, any>): Record<string, any> {
  const sanitized = { ...config };
  const sensitiveKeys = ['key', 'token', 'password', 'secret', 'apiKey'];

  for (const [key, value] of Object.entries(sanitized)) {
    // Check if key contains any sensitive keyword
    const isSensitive = sensitiveKeys.some(sensitive =>
      key.toLowerCase().includes(sensitive.toLowerCase())
    );

    if (isSensitive && typeof value === 'string' && value.length > 0) {
      // Show first 3 characters and last 3 characters, with asterisks in between
      if (value.length <= 6) {
        sanitized[key] = '***';
      } else {
        sanitized[key] = value.substring(0, 3) + '***' + value.substring(value.length - 3);
      }
    }
  }

  return sanitized;
}

function isSensitiveConfigKey(key: string): boolean {
  const sensitiveKeys = ['key', 'token', 'password', 'secret', 'apiKey'];
  return sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive.toLowerCase()));
}

function formatConfigValueForDisplay(key: string, value: any): string {
  return formatValue(value);
}

/**
 * Print all configuration layers in detail
 */
function printAllConfigLayers(
  defaultConfig: Record<string, any>,
  globalConfig: Record<string, any> | null,
  projectConfig: Record<string, any> | null,
  effectiveConfig: Record<string, any>,
  globalConfigPath: string,
  projectConfigPath: string
): void {
  console.log('\n=== Configuration Layers (Highest Priority First) ===\n');

  // 1. Effective configuration (highest priority)
  console.log('【1. Effective Configuration】(Final values after merging all layers)');
  console.log(JSON.stringify(effectiveConfig, null, 2));
  console.log();

  // 2. Project configuration
  console.log('【2. Project Configuration】(Overrides global and default values)');
  if (projectConfig) {
    console.log(`File path: ${projectConfigPath}`);
    console.log(JSON.stringify(projectConfig, null, 2));
  } else {
    console.log('(Not configured)');
  }
  console.log();

  // 3. Global configuration
  console.log('【3. Global Configuration】(Overrides default values)');
  if (globalConfig) {
    console.log(`File path: ${globalConfigPath}`);
    console.log(JSON.stringify(globalConfig, null, 2));
  } else {
    console.log('(Not configured)');
  }
  console.log();

  // 4. Default values (lowest priority)
  console.log('【4. Default Values】(Built-in fallback values)');
  console.log(JSON.stringify(defaultConfig, null, 2));
}

/**
 * Print detailed layers for specific configuration items
 */
function printConfigItemLayers(
  keys: string[],
  defaultConfig: Record<string, any>,
  globalConfig: Record<string, any> | null,
  projectConfig: Record<string, any> | null,
  effectiveConfig: Record<string, any>
): void {
  for (const key of keys) {
    console.log(`\n=== ${key} ===`);

    const defaultValue = defaultConfig[key];
    const globalValue = globalConfig?.[key];
    const projectValue = projectConfig?.[key];
    const effectiveValue = effectiveConfig[key];

    console.log(`Default: ${formatConfigValueForDisplay(key, defaultValue)}`);
    console.log(`Global: ${globalValue !== undefined ? formatConfigValueForDisplay(key, globalValue) : '(Not set)'}`);
    console.log(`Project: ${projectValue !== undefined ? formatConfigValueForDisplay(key, projectValue) : '(Not set)'}`);
    console.log(`Effective: ${formatConfigValueForDisplay(key, effectiveValue)}`);
  }
}

/**
 * Handle --get-config command
 */
async function getConfigHandler(positionals: string[], json?: boolean): Promise<void> {
  // 1. Determine configuration paths (supports --path and --config)
  const options = resolveOptions();
  const projectConfigPath = options.config || path.join(options.path, 'autodev-config.json');
  const globalConfigPath = path.join(os.homedir(), '.autodev-cache', 'autodev-config.json');

  // 2. Get default configuration
  const defaultConfig = DEFAULT_CONFIG;

  // 3. Get global configuration (if exists)
  let globalConfig: Record<string, any> | null = null;
  try {
    if (fs.existsSync(globalConfigPath)) {
      const content = fs.readFileSync(globalConfigPath, 'utf-8');
      globalConfig = jsoncParser.parse(content);
    }
  } catch (error) {
    console.error(`Failed to read global configuration: ${error}`);
    console.error(`Path: ${globalConfigPath}`);
    process.exit(1);
  }

  // 4. Get project configuration (if exists)
  let projectConfig: Record<string, any> | null = null;
  try {
    if (fs.existsSync(projectConfigPath)) {
      const content = fs.readFileSync(projectConfigPath, 'utf-8');
      projectConfig = jsoncParser.parse(content);
    }
  } catch (error) {
    console.error(`Failed to read project configuration: ${error}`);
    console.error(`Path: ${projectConfigPath}`);
    process.exit(1);
  }

  // 5. Calculate effective configuration (fix null merge bug)
  const effectiveConfig = {
    ...defaultConfig,
    ...(globalConfig ?? {}),
    ...(projectConfig ?? {})
  };

  // 6. Handle output
  if (json) {
    // JSON format output
    if (positionals.length === 0) {
      console.log(JSON.stringify({
        paths: {
          default: '(Built-in)',
          global: globalConfigPath,
          project: projectConfigPath
        },
        default: defaultConfig,
        global: globalConfig || {},
        project: projectConfig || {},
        effective: effectiveConfig
      }, null, 2));
    } else {
      // JSON output for specific configuration items
      const result: Record<string, any> = {};
      for (const key of positionals) {
        const globalValue = globalConfig?.[key as keyof CodeIndexConfig] ?? null;
        const projectValue = projectConfig?.[key as keyof CodeIndexConfig] ?? null;
        const effectiveValue = effectiveConfig[key as keyof CodeIndexConfig];

        result[key] = {
          default: defaultConfig[key as keyof CodeIndexConfig],
          global: globalValue,
          project: projectValue,
          effective: effectiveValue
        };
      }
      console.log(JSON.stringify(result, null, 2));
    }
  } else {
    // Human-readable format
    if (positionals.length === 0) {
      printAllConfigLayers(defaultConfig, globalConfig, projectConfig, effectiveConfig, globalConfigPath, projectConfigPath);
    } else {
      printConfigItemLayers(
        positionals,
        defaultConfig,
        globalConfig,
        projectConfig,
        effectiveConfig
      );
    }
  }
}

/**
 * Parse configuration value with type conversion and validation
 */
function parseConfigValue(key: string, value: string): any {
  // Boolean validation
  if (key === 'isEnabled' || key === 'rerankerEnabled') {
    if (value !== 'true' && value !== 'false') {
      console.error(`Invalid boolean value for ${key}: ${value} (must be 'true' or 'false')`);
      process.exit(1);
    }
    return value === 'true';
  }

  // Numeric validation
  const integerKeys = new Set([
    'embedderModelDimension',
    'embedderOllamaBatchSize',
    'embedderOpenAiBatchSize',
    'embedderOpenAiCompatibleBatchSize',
    'embedderGeminiBatchSize',
    'embedderMistralBatchSize',
    'embedderOpenRouterBatchSize',
    'rerankerBatchSize',
    'vectorSearchMaxResults'
  ]);
  const numberKeys = new Set([
    'vectorSearchMinScore',
    'rerankerMinScore'
  ]);

  if (integerKeys.has(key) || numberKeys.has(key)) {
    const isInteger = integerKeys.has(key);
    const pattern = isInteger ? /^-?\d+$/ : /^-?\d+(?:\.\d+)?$/;
    if (!pattern.test(value)) {
      console.error(`Invalid numeric value for ${key}: ${value} (must be a ${isInteger ? 'integer' : 'number'})`);
      process.exit(1);
    }
    const parsed = isInteger ? parseInt(value, 10) : parseFloat(value);
    if (!Number.isFinite(parsed)) {
      console.error(`Invalid numeric value for ${key}: ${value}`);
      process.exit(1);
    }
    if (key === 'embedderModelDimension' && parsed <= 0) {
      console.error(`Invalid value for ${key}: ${value} (must be positive)`);
      process.exit(1);
    }
    return parsed;
  }

  // EmbedderProvider validation
  if (key === 'embedderProvider') {
    const validProviders = ['openai', 'ollama', 'openai-compatible', 'jina', 'gemini', 'mistral', 'vercel-ai-gateway', 'openrouter'];
    if (!validProviders.includes(value)) {
      console.error(`Invalid embedderProvider: ${value}`);
      console.error(`Valid providers: ${validProviders.join(', ')}`);
      process.exit(1);
    }
    return value;
  }

  // RerankerProvider validation
  if (key === 'rerankerProvider') {
    const validProviders = ['ollama', 'openai-compatible'];
    if (!validProviders.includes(value)) {
      console.error(`Invalid rerankerProvider: ${value}`);
      console.error(`Valid providers: ${validProviders.join(', ')}`);
      process.exit(1);
    }
    return value;
  }

  // String (return as-is)
  return value;
}

/**
 * Handle --set-config command
 */
async function setConfigHandler(configString: string, global?: boolean): Promise<void> {
  // 1. Parse configuration string (split by first = to support = in values)
  const configPairs = configString.split(',').map(s => s.trim());
  const newConfig: Record<string, any> = {};

  for (const pair of configPairs) {
    const firstEqualIndex = pair.indexOf('=');
    if (firstEqualIndex === -1) {
      console.error(`Invalid configuration format: ${pair} (should be key=value)`);
      process.exit(1);
    }

    const key = pair.substring(0, firstEqualIndex).trim();
    const value = pair.substring(firstEqualIndex + 1).trim();

    if (!key || value === '') {
      console.error(`Invalid configuration format: ${pair} (empty key or value)`);
      process.exit(1);
    }

    // Type conversion and validation
    newConfig[key] = parseConfigValue(key, value);
  }

  // 2. Validate configuration item names (using TypeScript type checking)
  type ConfigKey = keyof CodeIndexConfig;
  const validKeys: ConfigKey[] = [
    'isEnabled',
    'embedderProvider', 'embedderModelId', 'embedderModelDimension',
    'embedderOllamaBaseUrl', 'embedderOllamaBatchSize',
    'embedderOpenAiApiKey', 'embedderOpenAiBatchSize',
    'embedderOpenAiCompatibleBaseUrl', 'embedderOpenAiCompatibleApiKey', 'embedderOpenAiCompatibleBatchSize',
    'embedderGeminiApiKey', 'embedderGeminiBatchSize',
    'embedderMistralApiKey', 'embedderMistralBatchSize',
    'embedderVercelAiGatewayApiKey',
    'embedderOpenRouterApiKey', 'embedderOpenRouterBatchSize',
    'qdrantUrl', 'qdrantApiKey',
    'vectorSearchMinScore', 'vectorSearchMaxResults',
    'rerankerEnabled', 'rerankerProvider',
    'rerankerOllamaBaseUrl', 'rerankerOllamaModelId',
    'rerankerOpenAiCompatibleBaseUrl', 'rerankerOpenAiCompatibleModelId', 'rerankerOpenAiCompatibleApiKey',
    'rerankerMinScore', 'rerankerBatchSize'
  ];

  for (const key of Object.keys(newConfig)) {
    if (!validKeys.includes(key as ConfigKey)) {
      console.error(`Invalid configuration item: ${key}`);
      console.error(`Supported configuration items: ${validKeys.join(', ')}`);
      process.exit(1);
    }
  }

  // 3. Determine configuration path (supports --path and --config)
  const options = resolveOptions();
  const projectConfigPath = options.config || path.join(options.path, 'autodev-config.json');
  const globalConfigPath = path.join(os.homedir(), '.autodev-cache', 'autodev-config.json');
  const configPath = global ? globalConfigPath : projectConfigPath;

  // 4. Read existing configuration (using jsonc-parser, handle corrupted files)
  let existingConfig: Record<string, any> = {};
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      existingConfig = jsoncParser.parse(content);
    }
  } catch (error) {
    console.error(`Failed to read existing configuration: ${error}`);
    console.error(`File path: ${configPath}`);
    console.error('Please check file format or fix manually using a text editor');
    process.exit(1);
  }

  // 5. Merge configuration
  // Use built-in defaults as baseline so users can set a subset of config keys
  // without needing to redundantly specify required defaults (e.g. qdrantUrl).
  const mergedConfig = { ...DEFAULT_CONFIG, ...existingConfig, ...newConfig };

  // 6. Validate the complete configuration using ConfigValidator
  const validationResult = ConfigValidator.validate(mergedConfig as CodeIndexConfig);
  if (!validationResult.valid) {
    console.error('Configuration validation failed:');
    for (const issue of validationResult.issues) {
      console.error(`  - ${issue.path}: ${issue.message}`);
    }
    process.exit(1);
  }

  // 7. Ensure directory exists
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 8. Save configuration (preserving JSONC comments)
  try {
    // Read original content to preserve formatting and comments
    const originalContent = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, 'utf-8')
      : '';

    // Use helper to save while preserving comments
    const content = saveJsoncPreservingComments(originalContent, mergedConfig);

    fs.writeFileSync(configPath, content);
    console.log(`Configuration saved to: ${configPath}`);
    console.log('Updated configuration items:');
    for (const [key, value] of Object.entries(newConfig)) {
      console.log(`  ${key}: ${value}`);
    }

    // Best-effort: protect config files across all repos by adding to Git global excludes file.
    try {
      const ignoreResult = await ensureGitGlobalIgnorePatterns(['autodev-config.json']);
      if (ignoreResult.didUpdate && ignoreResult.excludesFilePath) {
        console.log(`Added 'autodev-config.json' to git global ignore: ${ignoreResult.excludesFilePath}`);
      }
    } catch {
      // Intentionally best-effort; configuration write already succeeded.
    }
  } catch (error) {
    console.error(`Failed to save configuration: ${error}`);
    process.exit(1);
  }
}

/**
 * Check if a path string contains glob pattern characters
 */
function isGlobPattern(path: string): boolean {
  return /[*?{}\[\]]/.test(path);
}

/**
 * Handle --outline command with glob pattern support
 */
async function handleOutlineCommand(filePath: string, options: SimpleCliOptions): Promise<void> {
  // Create dependencies
  const deps = createDependencies(options);

  // Import extractOutline and fast-glob
  const { extractOutline } = await import('./cli-tools/outline');
  const fastGlob = (await import('fast-glob')).default;

  const workspacePath = options.path;
  const configPath = options.config || path.join(options.path, 'autodev-config.json');
  const workspace = deps.workspace;

  try {
    // Check if input is a glob pattern
    if (isGlobPattern(filePath)) {
      // Check if the pattern contains comma-separated multiple patterns
      if (filePath.includes(',')) {
        // Multi-pattern support with include/exclude logic
        const patterns = parsePathFilters(filePath);

        // Separate include and exclude patterns
        const includePatterns = patterns.filter(p => !p.startsWith('!'));
        const excludePatterns = patterns
          .filter(p => p.startsWith('!'))
          .map(p => p.slice(1)); // Remove ! prefix

        deps.logger?.debug(`Include patterns: ${includePatterns.join(', ')}`);
        deps.logger?.debug(`Exclude patterns: ${excludePatterns.join(', ')}`);

        // Get ignore patterns from workspace
        const globIgnorePatterns = await workspace.getGlobIgnorePatterns();

        // Merge workspace ignore patterns with user-specified exclude patterns
        const allIgnorePatterns = [...globIgnorePatterns, ...excludePatterns];

        // Use fast-glob with multiple include patterns and combined ignore patterns
        let files = await fastGlob(includePatterns, {
          cwd: workspacePath,
          absolute: true,
          ignore: allIgnorePatterns
        });

        // Layer 2: Flexible filtering (project-specific rules)
        const filteredFiles = [];
        for (const file of files) {
          if (!(await workspace.shouldIgnore(file))) {
            filteredFiles.push(file);
          }
        }

        if (filteredFiles.length === 0) {
          deps.logger?.warn(`No files found matching pattern: ${filePath}`);
          return;
        }

        // Handle --dry-run mode
        if (options.dryRun) {
          console.log(`Dry-run mode: Files matched by pattern "${filePath}"\n`);
          console.log(`Total: ${filteredFiles.length} file(s)\n`);

          filteredFiles.forEach((file, index) => {
            const relativePath = workspace.getRelativePath(file);
            console.log(`${index + 1}. ${relativePath}`);
          });

          return; // Don't execute actual outline extraction
        }

        deps.logger?.info(`Found ${filteredFiles.length} file(s) matching pattern: ${filePath}`);

        // Process each file
        for (const file of filteredFiles) {
          try {
            const result = await extractOutline({
              filePath: file,
              workspacePath,
              json: options.json,
              summarize: options.summarize,
              configPath,
              fileSystem: deps.fileSystem,
              workspace,
              pathUtils: deps.pathUtils,
              logger: deps.logger
            });

            console.log(result);
            console.log('===\n');
          } catch (error) {
            // Skip failed files but continue processing others
            if (error instanceof Error) {
              deps.logger?.warn(`Failed to process ${file}: ${error.message}`);
            }
          }
        }
      } else {
        // Single pattern (original logic)
        // Get ignore patterns from workspace (reuses existing ignore logic)
        const globIgnorePatterns = await workspace.getGlobIgnorePatterns()

        // Use fast-glob for pattern matching with dual-layer filtering
        let files = await fastGlob(filePath, {
          cwd: workspacePath,
          absolute: true,
          // Layer 1: High-performance filtering (prune during traversal)
          ignore: globIgnorePatterns
        });

        // Layer 2: Flexible filtering (project-specific rules)
        const filteredFiles = [];
        for (const file of files) {
          if (!(await workspace.shouldIgnore(file))) {
            filteredFiles.push(file);
          }
        }

        if (filteredFiles.length === 0) {
          deps.logger?.warn(`No files found matching pattern: ${filePath}`);
          return;
        }

        // Handle --dry-run mode
        if (options.dryRun) {
          console.log(`Dry-run mode: Files matched by pattern "${filePath}"\n`);
          console.log(`Total: ${filteredFiles.length} file(s)\n`);

          filteredFiles.forEach((file, index) => {
            const relativePath = workspace.getRelativePath(file);
            console.log(`${index + 1}. ${relativePath}`);
          });

          return; // Don't execute actual outline extraction
        }

        deps.logger?.info(`Found ${filteredFiles.length} file(s) matching pattern: ${filePath}`);

        // Process each file
        for (const file of filteredFiles) {
          try {
            const result = await extractOutline({
              filePath: file,
              workspacePath,
              json: options.json,
              summarize: options.summarize,
              configPath,
              fileSystem: deps.fileSystem,
              workspace,
              pathUtils: deps.pathUtils,
              logger: deps.logger
            });

            console.log(result);
            console.log('===\n');
          } catch (error) {
            // Skip failed files but continue processing others
            if (error instanceof Error) {
              deps.logger?.warn(`Failed to process ${file}: ${error.message}`);
            }
          }
        }
      }
    } else {
      // Single file processing (original logic) - skip ignore checks
      const result = await extractOutline({
        filePath,
        workspacePath,
        json: options.json,
        summarize: options.summarize,
        configPath,
        fileSystem: deps.fileSystem,
        workspace,
        pathUtils: deps.pathUtils,
        logger: deps.logger,
        skipIgnoreCheck: true  // Skip ignore checks for single-file mode
      });

      console.log(result);
    }
  } catch (error) {
    if (error instanceof Error) {
      deps.logger?.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    if (values.help) {
      printHelp();
      process.exit(0);
    }

    // Handle configuration management commands
    if (values['get-config']) {
      // --global parameter is ignored for --get-config
      await getConfigHandler(positionals, values.json);
      process.exit(0);
    }
    if (values['set-config']) {
      await setConfigHandler(values['set-config'], values.global);
      process.exit(0);
    }

    const options = resolveOptions();

    // Initialize global logger with the specified log level
    initGlobalLogger(options.logLevel);

    // Mutual exclusion check: only one command can be used at a time
    const commandFlags = [
      values.serve,
      values['stdio-adapter'],
      values.index,
      !!values.search,
      !!values.outline,
      values.clear,
    ].filter(Boolean);

    if (commandFlags.length > 1) {
      console.error('Error: Only one command can be used at a time (serve|stdio-adapter|index|search|outline|clear).');
      process.exit(1);
    }

    if (values.serve) {
      await startMCPServer(options);
    } else if (values['stdio-adapter']) {
      await startStdioAdapter(options);
    } else if (values.index) {
      await indexCodebase(options);
    } else if (values.search) {
      await searchIndex(values.search, options);
    } else if (values.outline) {
      await handleOutlineCommand(values.outline, options);
    } else if (values.clear) {
      await clearIndex(options);
    } else {
      printHelp();
      process.exit(0);
    }
  } catch (error) {
    if (error instanceof Error) {
      getLogger().error('Error:', error.message);
    } else {
      getLogger().error('Unknown error:', error);
    }
    process.exit(1);
  }
}

// Run the CLI
main();
