/**
 * Outline command implementation
 */
import { Command } from 'commander';
import * as path from 'path';
import { CommandOptions, getLogger, initGlobalLogger, resolveWorkspacePath, createDependencies } from './shared';

/**
 * Handle outline command
 */
async function handleOutline(pattern: string, options: CommandOptions): Promise<void> {
  const deps = createDependencies(options);

  const { extractOutline } = await import('../cli-tools/outline');
  const { resolveOutlineTargets } = await import('../cli-tools/outline-targets');

  const workspacePath = options.path;
  const configPath = options.config || path.join(options.path, 'autodev-config.json');
  const workspace = deps.workspace;

  try {
    const resolved = await resolveOutlineTargets({
      input: pattern,
      workspacePath,
      workspace,
      pathUtils: deps.pathUtils,
      fileSystem: deps.fileSystem,
      skipIgnoreCheckForSingleFile: true
    });

    if (resolved.files.length === 0) {
      if (resolved.isGlob) deps.logger?.warn(`No files found matching pattern: ${pattern}`);
      else deps.logger?.warn(`No file found (or ignored): ${pattern}`);
      return;
    }

    if (resolved.isGlob) {
      if (options.dryRun) {
        console.log(`Dry-run mode: Files matched by pattern "${pattern}"\n`);
        console.log(`Total: ${resolved.files.length} file(s)\n`);
        resolved.files.forEach((file, index) => {
          console.log(`${index + 1}. ${workspace.getRelativePath(file)}`);
        });
        return;
      }

      deps.logger?.info(`Found ${resolved.files.length} file(s) matching pattern: ${pattern}`);
    }

    for (const file of resolved.files) {
      try {
        const result = await extractOutline({
          filePath: file,
          workspacePath,
          json: options.json,
          summarize: options.summarize,
          title: options.title,
          clearSummarizeCache: options.clearCache,
          configPath,
          fileSystem: deps.fileSystem,
          workspace,
          pathUtils: deps.pathUtils,
          logger: deps.logger,
          skipIgnoreCheck: !resolved.isGlob
        });

        console.log(result);
        if (resolved.isGlob) console.log('\n---\n');
      } catch (error) {
        if (error instanceof Error) {
          deps.logger?.warn(`Failed to process ${file}: ${error.message}`);
        }
      }
    }

    if (options.summarize) {
      const { SummaryCacheManager } = await import('../cli-tools/summary-cache');
      const { createStorageForOutline } = await import('../cli-tools/outline');

      const storage = await createStorageForOutline(workspacePath);

      const cacheManager = new SummaryCacheManager(
        workspacePath,
        storage,
        deps.fileSystem,
        {
          info: (msg: string) => deps.logger?.info(msg),
          warn: (msg: string) => deps.logger?.warn(msg),
          error: (msg: string) => deps.logger?.error(msg)
        }
      );

      deps.logger?.info('Cleaning orphaned caches...');
      const result = await cacheManager.cleanOrphanedCaches();
      if (result.removed > 0) {
        deps.logger?.info(`Cleaned ${result.removed} orphaned cache files`);
      }
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
 * Outline command handler
 */
async function outlineHandler(pattern: string, options: any): Promise<void> {
  const workspacePath = resolveWorkspacePath(options.path, options.demo);

  const commandOptions: CommandOptions = {
    path: workspacePath,
    port: 3001,
    host: 'localhost',
    config: options.config,
    logLevel: options.logLevel || 'error',
    demo: !!options.demo,
    force: false,
    storage: options.storage,
    cache: options.cache,
    json: !!options.json,
    summarize: !!options.summarize,
    title: !!options.title,
    clearCache: !!options.clearCache,
    dryRun: !!options.dryRun,
    watch: false,
    serve: false
  };

  initGlobalLogger(commandOptions.logLevel);

  // Handle --clear-cache without pattern
  if (commandOptions.clearCache && !pattern) {
    getLogger().info('Clear summarize cache mode');
    getLogger().info(`Workspace: ${commandOptions.path}`);

    const deps = createDependencies(commandOptions);
    const { SummaryCacheManager } = await import('../cli-tools/summary-cache');

    const cacheManager = new SummaryCacheManager(
      commandOptions.path,
      deps.storage,
      deps.fileSystem,
      {
        info: (msg: string) => getLogger().info(msg),
        error: (msg: string) => getLogger().error(msg),
        warn: (msg: string) => getLogger().warn(msg)
      }
    );

    const removed = await cacheManager.clearAllCaches();

    if (removed === 0) {
      getLogger().info('No summary caches found');
    }
    return;
  }

  await handleOutline(pattern, commandOptions);
}

/**
 * Create outline command
 */
export function createOutlineCommand(): Command {
  const command = new Command('outline');

  command
    .description('Extract code outline from file(s)')
    .argument('<pattern>', 'File path or glob pattern')
    .option('-p, --path <path>', 'Working directory path', '.')
    .option('-c, --config <path>', 'Configuration file path')
    .option('--summarize', 'Generate AI summaries')
    .option('--title', 'Show only file-level summary')
    .option('--clear-cache', 'Clear summary cache')
    .option('--dry-run', 'Preview matched files')
    .option('--json', 'Output in JSON format')
    .option('--log-level <level>', 'Log level: debug|info|warn|error', 'error')
    .option('--storage <path>', 'Custom storage path')
    .option('--cache <path>', 'Custom cache path')
    .option('--demo', 'Use demo workspace')
    .action(outlineHandler);

  return command;
}
