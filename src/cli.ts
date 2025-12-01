#!/usr/bin/env node
/**
 * Simplified CLI for @autodev/codebase
 * Uses Node.js native parseArgs without React/Ink dependencies
 */

import { parseArgs } from 'node:util';
import * as path from 'path';
import * as fs from 'fs';
import { createNodeDependencies } from './adapters/nodejs';
import { CodeIndexManager } from './code-index/manager';
import { CodebaseHTTPMCPServer } from './mcp/http-server.js';
import createSampleFiles from './examples/create-sample-files';
import { getGlobalLogger, setGlobalLogger, Logger, LogLevel } from './utils/logger';
import { VectorStoreSearchResult } from './code-index/interfaces';

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
    // 对同一文件的结果按行号排序
    fileResults.sort((a, b) => {
      const lineA = a.payload?.startLine || 0;
      const lineB = b.payload?.startLine || 0;
      return lineA - lineB;
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

    return `${'='.repeat(50)}\nFile: "${filePath}" | Avg Score: ${avgScore.toFixed(3)}${snippetInfo}${duplicateInfo}\n${'='.repeat(50)}\n${codeChunks}`;
  });

  const fileCount = resultsByFile.size;
  const summary = `Found ${results.length} result${results.length > 1 ? 's' : ''} in ${fileCount} file${fileCount > 1 ? 's' : ''} for: "${query}"

`;



  return summary + formattedResults.join('\n\n');
}

// CLI Options interface
interface SimpleCliOptions {
  path: string;
  port: number;
  host: string;
  config?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  demo: boolean;
  force: boolean;
  storage?: string;
  cache?: string;
}

// Parse command line arguments using Node.js native parseArgs
const { values, positionals } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h' },
    serve: { type: 'boolean', short: 's' },
    index: { type: 'boolean', short: 'i' },
    search: { type: 'string' },
    watch: { type: 'boolean', short: 'w' },
    clear: { type: 'boolean' },
    // Path and config options
    path: { type: 'string', short: 'p', default: '.' },
    config: { type: 'string', short: 'c' },
    // MCP server options
    port: { type: 'string', default: '3001' },
    host: { type: 'string', default: 'localhost' },
    // Logging
    'log-level': { type: 'string', default: 'error' },
    // Demo mode
    demo: { type: 'boolean' },
    force: { type: 'boolean' },
    // Storage paths
    storage: { type: 'string' },
    cache: { type: 'string' },
  },
  allowPositionals: true
});

/**
 * Print help message
 */
function printHelp(): void {
  getLogger().info(`
@autodev/codebase - Simplified CLI (No React/Ink dependencies)

Usage:
  codebase --serve           Start MCP server
  codebase --index           Index the codebase
  codebase --search="query"  Search the index
  codebase --clear           Clear index data
  codebase --help            Show this help

Options:
  --path, -p <path>         Working directory path (default: current directory)
  --port <port>             MCP server port (default: 3001)
  --host <host>             MCP server host (default: localhost)
  --config, -c <path>       Configuration file path
  --log-level <level>       Log level: debug|info|warn|error (default: info)
  --demo                    Create demo files in workspace
  --force                   Force reindex all files, ignoring cache
  --storage <path>          Storage directory path
  --cache <path>            Cache directory path

Examples:
  # Start MCP server
  codebase --serve --path=/my/project

  # Index codebase
  codebase --index --path=/my/project

  # Search for code
  codebase --search="user authentication"

  # Clear index
  codebase --clear --path=/my/project

  # Run with demo files
  codebase --serve --demo --log-level=debug
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

  return {
    path: workspacePath,
    port: parseInt(values.port || '3001', 10),
    host: values.host || 'localhost',
    config: values.config,
    logLevel: values['log-level'] as SimpleCliOptions['logLevel'],
    demo: !!values.demo,
    force: !!values.force,
    storage: values.storage,
    cache: values.cache,
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
    manager.startIndexing()
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
  * Search the index
  */
  async function searchIndex(query: string, options: SimpleCliOptions): Promise<void> {
  getLogger().info('Search mode');
  getLogger().info(`Query: "${query}"`);
  getLogger().info(`Workspace: ${options.path}`);

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
      results = await manager.searchIndex(query);
    } catch (error) {
      // 如果索引尚未准备好，则先执行一次索引再重试搜索
      if (error instanceof Error && error.message.startsWith('Code index is not ready for search')) {
        getLogger().info('Index is not ready. Running indexing before search...');
        await waitForIndexingCompletion(manager);
        getLogger().info('Retrying search after indexing...');
        results = await manager.searchIndex(query);
      } else {
        throw error;
      }
    }

    if (!results || results.length === 0) {
      getLogger().info('No results found');
      return;
    }

    // 使用新的格式化函数显示搜索结果
    const formattedOutput = formatSearchResults(results as SearchResult[], query);
    console.log(formattedOutput);
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
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    if (values.help) {
      printHelp();
      process.exit(0);
    }

    const options = resolveOptions();

    // Initialize global logger with the specified log level
    initGlobalLogger(options.logLevel);

    if (values.serve) {
      await startMCPServer(options);
    } else if (values.index) {
      await indexCodebase(options);
    } else if (values.search) {
      await searchIndex(values.search, options);
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
