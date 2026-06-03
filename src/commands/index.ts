/**
 * Index command implementation
 */
import { Command } from 'commander';
import * as crypto from 'crypto';
import * as path from 'path';
import { CommandOptions, initializeManager, waitForIndexingCompletion, getLogger, initGlobalLogger, resolveWorkspacePath, registerProjectToCacheMap } from './shared';
import { CodeIndexManager } from '../code-index/manager';
import { CodebaseHTTPMCPServer } from '../mcp/http-server';
import {
  isGitWorktree,
  getMainWorktreePath,
} from '../utils/git-worktree';
import {
  cloneIndexFromSource,
  type IndexCloneResult,
} from '../utils/index-cloner';

/**
 * If `targetPath` is a git worktree (other than the main one) and the
 * `--no-clone-from-worktree` flag is not set, copy the main worktree's
 * index data into `targetPath`'s namespace before initializing the
 * CodeIndexManager. The clone is best-effort: any failure is logged but
 * does not abort the indexing flow.
 */
async function maybeCloneFromWorktree(
  targetPath: string,
  options: CommandOptions,
): Promise<IndexCloneResult | null> {
  const logger = getLogger();

  // Commander's `--no-clone-from-worktree` flag is normalized to
  // `options.cloneFromWorktree === false`. Undefined means the user did
  // not pass the flag, so the default behavior is to clone.
  if (options.cloneFromWorktree === false) {
    logger.debug('Worktree index clone disabled via --no-clone-from-worktree');
    return null;
  }

  let sourcePath: string;
  if (options.fromWorktree) {
    sourcePath = path.resolve(options.fromWorktree);
    logger.info(`--from-worktree specified, using source: ${sourcePath}`);
  } else {
    const isWorktree = await isGitWorktree(targetPath);
    if (!isWorktree) {
      logger.debug(`Workspace is not a git worktree; skipping clone`);
      return null;
    }
    const main = await getMainWorktreePath(targetPath);
    if (!main) {
      logger.debug('Could not determine main worktree path; skipping clone');
      return null;
    }
    // We want the source to be the same SUB-PATH (relative to the
    // worktree root) but on the main worktree. E.g.
    //   target:    <main>/.claude/worktrees/feature/demo
    //   toplevel:  <main>/.claude/worktrees/feature
    //   rel:       demo
    //   source:    <main>/demo
    const toplevel = await getWorktreeToplevel(targetPath)
    if (!toplevel) {
      logger.debug('Could not determine current worktree toplevel; skipping clone')
      return null
    }
    const relTarget = path.relative(toplevel, targetPath)
    if (!relTarget || relTarget.startsWith('..') || path.isAbsolute(relTarget)) {
      // Target is at the worktree root, or escapes it (pathological). Use
      // the main worktree root as the source.
      sourcePath = main
    } else {
      sourcePath = path.join(main, relTarget)
    }
    if (sourcePath === targetPath) {
      logger.debug('Target and source resolve to the same path; skipping clone')
      return null
    }
  }

  // Resolve the Qdrant URL. The index command defers configuration loading
  // to CodeIndexManager; for the cloner we need the URL up-front. Fall back
  // to the demo config's URL and finally the default.
  const qdrantUrl = await resolveQdrantUrl(targetPath, options);

  logger.info(
    `Attempting worktree index clone: ${sourcePath} -> ${targetPath}`,
  );

  try {
    const result = await cloneIndexFromSource({
      sourcePath,
      targetPath,
      qdrant: { url: qdrantUrl, apiKey: undefined, timeoutMs: 120_000 },
      deps: {
        logger,
      },
    });
    if (result.failureReasons.length > 0) {
      logger.warn(
        `Worktree index clone completed with ${result.failureReasons.length} issue(s); continuing with normal indexing`,
      );
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Worktree index clone failed: ${message}; continuing with normal indexing`);
    return null;
  }
}

async function resolveQdrantUrl(workspacePath: string, options: CommandOptions): Promise<string> {
  // 1. Try the project config (workspacePath/autodev-config.json)
  const configPath = options.config || path.join(workspacePath, 'autodev-config.json');
  try {
    const { promises: fs } = await import('fs');
    const raw = await fs.readFile(configPath, 'utf8');
    // Allow JSONC with comments and trailing commas
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      .replace(/,(\s*[}\]])/g, '$1')
    const parsed = JSON.parse(stripped) as { qdrantUrl?: string }
    if (parsed?.qdrantUrl) {
      return parsed.qdrantUrl
    }
  } catch {
    // fall through
  }
  // 2. Default
  return 'http://localhost:6333'
}

/**
 * Return the absolute path of the current worktree's working tree root
 * (the topmost directory that `git` considers part of this worktree).
 * Used to compute the relative sub-path of the target workspace, so we
 * can mirror the same sub-path under the main worktree.
 */
async function getWorktreeToplevel(workspacePath: string): Promise<string | null> {
  const { spawnSync } = await import('node:child_process')
  const res = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--show-toplevel'],
    { cwd: workspacePath, encoding: 'utf8', timeout: 15_000 },
  )
  if (res.status !== 0) {
    return null
  }
  const out = (res.stdout ?? '').split('\n')[0]?.trim() ?? ''
  return out || null
}

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
    title: false,
    fromWorktree: options.fromWorktree,
    cloneFromWorktree: options.cloneFromWorktree,
  };

  initGlobalLogger(commandOptions.logLevel);

  // Register workspace path for cache --list
  await registerProjectToCacheMap(commandOptions.path);

  // Detect git worktree and (best-effort) clone the main worktree's index
  // data into this worktree's namespace before initializing the manager.
  // This is a no-op when the workspace is not a worktree, or when
  // --no-clone-from-worktree is set, or when the target namespace is
  // already populated.
  await maybeCloneFromWorktree(commandOptions.path, commandOptions);

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
    .option('--from-worktree <path>', 'Clone index data from the given worktree path (defaults to auto-detected main worktree)')
    .option('--no-clone-from-worktree', 'Disable automatic worktree index cloning')
    .option('--port <port>', 'Server port (for --serve)', '3001')
    .option('--host <host>', 'Server host (for --serve)', 'localhost')
    .option('--log-level <level>', 'Log level: debug|info|warn|error', 'error')
    .option('--storage <path>', 'Custom storage path')
    .option('--cache <path>', 'Custom cache path')
    .option('--demo', 'Use demo workspace')
    .action(indexHandler);

  return command;
}
