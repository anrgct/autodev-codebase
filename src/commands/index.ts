/**
 * Index command implementation
 */
import { Command } from 'commander';
import * as crypto from 'crypto';
import { CommandOptions, initializeManager, waitForIndexingCompletion, getLogger, initGlobalLogger, resolveWorkspacePath, registerProjectToCacheMap } from './shared';
import { CodeIndexManager } from '../code-index/manager';
import { CodebaseHTTPMCPServer } from '../mcp/http-server';

/**
 * Initialize CodeIndexManager for dry-run mode (without triggering indexing)
 */
async function initializeManagerForDryRun(
  options: CommandOptions
): Promise<CodeIndexManager | undefined> {
  const { createDependencies } = await import('./shared');
  const deps = createDependencies(options);

  getLogger().info('Loading configuration...');
  await deps.configProvider.loadConfig();

  getLogger().info('Creating CodeIndexManager...');
  const manager = CodeIndexManager.getInstance(deps);

  if (!manager) {
    getLogger().error('Failed to create CodeIndexManager - workspace root path may be invalid');
    return undefined;
  }

  getLogger().info('Initializing CodeIndexManager for dry-run...');
  await manager.initialize({ searchOnly: true });
  getLogger().info('CodeIndexManager initialization success');

  return manager;
}

/**
 * Perform dry-run analysis to preview what would be indexed
 */
async function performIndexDryRun(manager: CodeIndexManager, options: CommandOptions): Promise<void> {
  getLogger().info('Starting dry-run mode');
  getLogger().info(`Workspace: ${options.path}`);

  try {
    const { scanner, cacheManager, vectorStore, workspace, fileSystem, pathUtils } = manager.getDryRunComponents();

    getLogger().info('Scanning workspace for supported files...');
    const allFilePaths = await scanner.getAllFilePaths(options.path);

    let vectorStoreAvailable = false;
    let indexedRelativePaths: string[] = [];
    try {
      await vectorStore.initialize();
      indexedRelativePaths = await vectorStore.getAllFilePaths();
      vectorStoreAvailable = true;
      getLogger().info(`Vector store connected: ${indexedRelativePaths.length} files indexed`);
    } catch (error) {
      getLogger().warn('Vector store not available or empty - will only show file scan results');
    }

    const analysisResults = {
      totalFiles: 0,
      newFiles: 0,
      changedFiles: 0,
      unchangedFiles: 0,
      deletedFiles: 0,
      unsupportedFiles: 0,
      files: [] as Array<{
        path: string;
        status: 'new' | 'changed' | 'unchanged' | 'deleted' | 'unsupported';
        reason?: string;
      }>
    };

    const cachedHashes = cacheManager.getAllHashes();
    const currentFileSet = new Set(allFilePaths);

    for (const cachedPath of Object.keys(cachedHashes)) {
      if (!currentFileSet.has(cachedPath)) {
        analysisResults.deletedFiles++;
        analysisResults.files.push({
          path: workspace.getRelativePath(cachedPath),
          status: 'deleted'
        });
      }
    }

    const { scannerExtensions } = await import('../code-index/shared/supported-extensions');

    for (const filePath of allFilePaths) {
      analysisResults.totalFiles++;

      try {
        const ext = pathUtils.extname(filePath).toLowerCase();
        if (!scannerExtensions.includes(ext)) {
          analysisResults.unsupportedFiles++;
          analysisResults.files.push({
            path: workspace.getRelativePath(filePath),
            status: 'unsupported',
            reason: `Unsupported extension: ${ext}`
          });
          continue;
        }

        const relativePath = workspace.getRelativePath(filePath);
        const cachedHash = cachedHashes[filePath];

        if (options.force) {
          if (!cachedHash) {
            analysisResults.newFiles++;
            analysisResults.files.push({
              path: relativePath,
              status: 'new'
            });
          } else {
            analysisResults.changedFiles++;
            analysisResults.files.push({
              path: relativePath,
              status: 'changed'
            });
          }
          continue;
        }

        const buffer = await fileSystem.readFile(filePath);
        const content = new TextDecoder().decode(buffer);
        const currentHash = crypto.createHash('sha256').update(content).digest('hex');

        if (!cachedHash) {
          analysisResults.newFiles++;
          analysisResults.files.push({
            path: relativePath,
            status: 'new'
          });
        } else if (cachedHash !== currentHash) {
          analysisResults.changedFiles++;
          analysisResults.files.push({
            path: relativePath,
            status: 'changed'
          });
        } else {
          analysisResults.unchangedFiles++;
          analysisResults.files.push({
            path: relativePath,
            status: 'unchanged'
          });
        }
      } catch (error) {
        getLogger().warn(`Failed to analyze ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log('\n=== Dry-Run Analysis Report ===\n');
    console.log(`Workspace: ${options.path}`);

    console.log('\n--- Statistics ---');
    console.log(`\nCache Manager Stats:`);
    console.log(`  Files in cache: ${Object.keys(cachedHashes).length}`);

    console.log(`\nVector Store Stats:`);
    if (vectorStoreAvailable) {
      console.log(`  Status: Available`);
      console.log(`  Files in vector store: ${indexedRelativePaths.length}`);
    } else {
      console.log(`  Status: Not Available or Empty`);
    }

    console.log(`\nScanner Stats:`);
    console.log(`  Total files found: ${allFilePaths.length}`);
    console.log(`  Supported files: ${analysisResults.totalFiles}`);

    console.log(`\n--- Analysis Results ---`);
    console.log('\nSummary:');
    console.log(`  Total files found: ${analysisResults.totalFiles}`);
    console.log(`  New files: ${analysisResults.newFiles}`);
    console.log(`  Changed files: ${analysisResults.changedFiles}`);
    console.log(`  Unchanged files: ${analysisResults.unchangedFiles}`);
    console.log(`  Deleted files: ${analysisResults.deletedFiles}`);
    console.log(`  Unsupported files: ${analysisResults.unsupportedFiles}`);
    console.log(`  Files to be indexed: ${analysisResults.newFiles + analysisResults.changedFiles}`);
    if (options.force) {
      console.log(`  ⚠️  Force mode: All files will be reindexed`);
    }
    console.log('');

    const grouped = {
      new: analysisResults.files.filter(f => f.status === 'new'),
      changed: analysisResults.files.filter(f => f.status === 'changed'),
      unchanged: analysisResults.files.filter(f => f.status === 'unchanged'),
      deleted: analysisResults.files.filter(f => f.status === 'deleted'),
      unsupported: analysisResults.files.filter(f => f.status === 'unsupported')
    };

    const totalToProcess = grouped.new.length + grouped.changed.length + grouped.deleted.length;
    if (totalToProcess > 0) {
      console.log('Files that will be processed:');

      if (grouped.new.length > 0) {
        console.log(`\n  New files (${grouped.new.length}):`);
        grouped.new.forEach(f => console.log(`    + ${f.path}`));
      }

      if (grouped.changed.length > 0) {
        console.log(`\n  Changed files (${grouped.changed.length}):`);
        grouped.changed.forEach(f => console.log(`    ~ ${f.path}`));
      }

      if (grouped.deleted.length > 0) {
        console.log(`\n  Deleted files (${grouped.deleted.length}):`);
        grouped.deleted.forEach(f => console.log(`    - ${f.path}`));
      }

      if (grouped.unsupported.length > 0) {
        console.log(`\n  Unsupported files (${grouped.unsupported.length}):`);
        grouped.unsupported.forEach(f => console.log(`    ! ${f.path} (${f.reason})`));
      }
    } else {
      console.log('No files need processing - all files are unchanged.');
    }

    console.log('\n=== End of Dry-Run Report ===\n');

  } catch (error) {
    getLogger().error(`Dry-run failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Index command handler
 */
async function indexHandler(options: any): Promise<void> {
  const workspacePath = resolveWorkspacePath(options.path, options.demo);

  const commandOptions: CommandOptions = {
    path: workspacePath,
    port: parseInt(options.port || '3001', 10),
    host: options.host || 'localhost',
    config: options.config,
    logLevel: options.logLevel || 'error',
    demo: !!options.demo,
    force: !!options.force,
    storage: options.storage,
    cache: options.cache,
    json: false,
    dryRun: !!options.dryRun,
    watch: !!options.watch,
    serve: !!options.serve,
    clearCache: !!options.clearCache,
    summarize: false,
    title: false
  };

  initGlobalLogger(commandOptions.logLevel);

  // Register workspace path for cache --list
  await registerProjectToCacheMap(commandOptions.path);

  // Handle --clear-cache
  if (commandOptions.clearCache) {
    getLogger().info('Clear index mode');
    getLogger().info(`Workspace: ${commandOptions.path}`);

    const manager = await initializeManager(commandOptions, { searchOnly: true });
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
    return;
  }

  // Handle --serve
  if (commandOptions.serve) {
    getLogger().info('Starting MCP Server Mode');
    getLogger().info(`Workspace: ${commandOptions.path}`);

    const manager = await initializeManager(commandOptions);
    if (!manager) {
      process.exit(1);
    }

    getLogger().info('Starting MCP Server...');
    const server = new CodebaseHTTPMCPServer({
      codeIndexManager: manager,
      port: commandOptions.port,
      host: commandOptions.host
    });

    await server.start();
    getLogger().info('MCP Server started successfully');

    getLogger().info('\nMCP Server is now running!');
    getLogger().info('To connect your IDE to the HTTP Streamable MCP server, use the following configuration:');
    console.log(JSON.stringify({
      "mcpServers": {
        "codebase": {
          "url": `http://${commandOptions.host}:${commandOptions.port}/mcp`
        }
      }
    }, null, 2));

    getLogger().info('Starting indexing process...');
    manager.onProgressUpdate((progressInfo) => {
      getLogger().info(`Indexing progress: ${progressInfo.systemStatus} - ${progressInfo.message || ''}`);
    });

    if (manager.isFeatureEnabled && manager.isInitialized) {
      manager.startIndexing(commandOptions.force)
        .then(() => {
          getLogger().info('Indexing completed');
        })
        .catch((err: Error) => {
          getLogger().error('Indexing failed:', err.message);
        });
    } else {
      getLogger().warn('Skipping indexing - feature not enabled or not initialized');
    }

    const handleShutdown = async () => {
      getLogger().info('\nShutting down MCP Server...');
      await server.stop();
      getLogger().info('MCP Server stopped');
      process.exit(0);
    };

    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);

    getLogger().info('MCP Server is ready for connections. Press Ctrl+C to stop.');
    return new Promise(() => {}); // Keep alive
  }

  // Handle --dry-run
  if (commandOptions.dryRun) {
    const manager = await initializeManagerForDryRun(commandOptions);
    if (!manager) {
      process.exit(1);
    }

    if (!manager.isFeatureEnabled) {
      getLogger().error('Code indexing feature is not enabled');
      process.exit(1);
    }

    try {
      await performIndexDryRun(manager, commandOptions);
    } finally {
      manager.dispose();
      getLogger().info('Dry-run mode completed.');
    }
    return;
  }

  // Normal indexing mode
  getLogger().info('Starting indexing mode');
  getLogger().info(`Workspace: ${commandOptions.path}`);

  const manager = await initializeManager(commandOptions);
  if (!manager) {
    process.exit(1);
  }

  if (!manager.isFeatureEnabled) {
    getLogger().error('Code indexing feature is not enabled');
    process.exit(1);
  }

  try {
    getLogger().info('Starting indexing process...');

    manager.onProgressUpdate((progressInfo) => {
      getLogger().info(`Indexing progress: ${progressInfo.systemStatus} - ${progressInfo.message || ''}`);
    });

    await waitForIndexingCompletion(manager);
  } finally {
    manager.dispose();
    getLogger().info('Indexing mode completed. Exiting...');
  }
}

/**
 * Create index command
 */
export function createIndexCommand(): Command {
  const command = new Command('index');

  command
    .description('Index the codebase')
    .option('-p, --path <path>', 'Working directory path', '.')
    .option('-c, --config <path>', 'Configuration file path')
    .option('--force', 'Force rebuild index')
    .option('--dry-run', 'Preview what would be indexed')
    .option('-w, --watch', 'Watch for file changes')
    .option('-s, --serve', 'Start MCP HTTP server')
    .option('--clear-cache', 'Clear index cache')
    .option('--port <port>', 'Server port (for --serve)', '3001')
    .option('--host <host>', 'Server host (for --serve)', 'localhost')
    .option('--log-level <level>', 'Log level: debug|info|warn|error', 'error')
    .option('--storage <path>', 'Custom storage path')
    .option('--cache <path>', 'Custom cache path')
    .option('--demo', 'Use demo workspace')
    .action(indexHandler);

  return command;
}
