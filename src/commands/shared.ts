/**
 * Shared utilities and types for CLI commands
 */
import * as path from 'path';
import { createNodeDependencies } from '../adapters/nodejs';
import { CodeIndexManager } from '../code-index/manager';
import { Logger, LogLevel, setGlobalLogger, getGlobalLogger } from '../utils/logger';

/**
 * CLI Options interface
 */
export interface CommandOptions {
  path: string;
  port: number;
  host: string;
  serverUrl?: string;
  timeoutMs?: number;
  config?: string;
  logLevel: LogLevel;
  demo: boolean;
  force: boolean;
  storage?: string;
  cache?: string;
  json: boolean;
  pathFilters?: string;
  limit?: string;
  minScore?: string;
  summarize?: boolean;
  title?: boolean;
  clearCache?: boolean;
  dryRun?: boolean;
  watch?: boolean;
  serve?: boolean;
  global?: boolean;
}

/**
 * Initialize global logger with CLI settings
 */
export function initGlobalLogger(level: LogLevel): void {
  const logger = new Logger({
    name: 'CLI',
    level,
    timestamps: true,
    colors: process.stdout.isTTY
  });
  setGlobalLogger(logger);
}

/**
 * Helper function to get logger
 */
export function getLogger(): Logger {
  return getGlobalLogger();
}

/**
 * Resolve workspace path
 */
export function resolveWorkspacePath(inputPath: string, demo: boolean): string {
  let resolvedPath = inputPath || '.';
  if (!path.isAbsolute(resolvedPath)) {
    resolvedPath = path.join(process.cwd(), resolvedPath);
  }

  return demo ? path.join(resolvedPath, 'demo') : resolvedPath;
}

/**
 * Create dependencies for CodeIndexManager
 */
export function createDependencies(options: CommandOptions) {
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
 */
export async function initializeManager(
  options: CommandOptions,
  initOptions?: { searchOnly?: boolean }
): Promise<CodeIndexManager | undefined> {
  const deps = createDependencies(options);

  // Create demo files if requested
  if (options.demo) {
    const { default: createSampleFiles } = await import('../examples/create-sample-files');
    const workspaceExists = await deps.fileSystem.exists(options.path);
    if (!workspaceExists) {
      const fs = await import('fs');
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
 * Wait for indexing to complete
 */
export async function waitForIndexingCompletion(manager: CodeIndexManager): Promise<void> {
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
        setTimeout(checkState, 2000);
      }
    };

    manager.startIndexing()
      .then(() => {
        setTimeout(checkState, 2000);
      })
      .catch(reject);
  });
}
