/**
 * Shared utilities and types for CLI commands
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { createHash } from 'crypto';
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
  // Call command options
  viz?: string;
  query?: string;
  open?: boolean;
  depth?: string;
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
 * Create demo files if requested
 * 
 * This helper ensures demo files are created when --demo flag is used.
 * Should be called by all commands that support --demo option.
 */
export async function ensureDemoFiles(workspacePath: string, fileSystem: any): Promise<void> {
  const { default: createSampleFiles } = await import('../examples/create-sample-files');
  const workspaceExists = await fileSystem.exists(workspacePath);
  if (!workspaceExists) {
    const fs = await import('fs');
    fs.mkdirSync(workspacePath, { recursive: true });
    await createSampleFiles(fileSystem, workspacePath);
    getLogger().info(`Demo files created in: ${workspacePath}`);
  }
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
    await ensureDemoFiles(options.path, deps.fileSystem);
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

// ============================================================================
// Project Map Registration (for codebase cache subcommand)
// ============================================================================

const PROJECT_MAP_FILE = path.join(os.homedir(), '.autodev-cache', 'project-map.json');

/**
 * Register the workspace path in the project map so that
 * `codebase cache --list` can resolve project names from hashes.
 * Call this once at the beginning of any command that uses a workspace.
 */
export async function registerProjectToCacheMap(workspacePath: string): Promise<void> {
  try {
    // Ensure cache directory exists
    const cacheDir = path.dirname(PROJECT_MAP_FILE);
    await fs.promises.mkdir(cacheDir, { recursive: true });

    // Load existing map
    let map: Record<string, string> = {};
    try {
      const content = await fs.promises.readFile(PROJECT_MAP_FILE, 'utf-8');
      map = JSON.parse(content);
    } catch {
      // File doesn't exist or is corrupted — start fresh
    }

    // Compute hash
    const fullHash = createHash('sha256').update(workspacePath).digest('hex');
    const shortHash = fullHash.substring(0, 16);

    // Only write if not already registered
    if (map[fullHash] === workspacePath && map[shortHash] === workspacePath) {
      return;
    }

    map[fullHash] = workspacePath;
    map[shortHash] = workspacePath;

    await fs.promises.writeFile(PROJECT_MAP_FILE, JSON.stringify(map, null, 2), 'utf-8');
  } catch {
    // Non-critical — silently ignore write failures
  }
}
