/**
 * Call command implementation
 *
 * Analyze code dependencies and generate visualization data
 */
import { Command } from 'commander';
import * as path from 'path';
import {
  CommandOptions,
  resolveWorkspacePath,
  initGlobalLogger,
  getLogger,
  ensureDemoFiles
} from './shared';
import {
  analyze,
  DependencyAnalyzerDeps,
  generateVisualizationData,
  findMatchingNodes,
  queryNode,
  analyzeConnections,
  formatNodeQueryResult,
  formatConnectionAnalysisResult,
  type NodeQueryResult,
  type ConnectionAnalysisResult,
  type QueryOptions
} from '../dependency';
import { promises as fs } from 'fs';
import open from 'open';

/**
 * Type alias for analysis result to avoid repetition
 */
type AnalysisResult = Awaited<ReturnType<typeof analyze>>;

/**
 * Find and open the graph viewer HTML file
 */
async function openGraphViewer(fileSystem: any): Promise<void> {
  const logger = getLogger();
  const { fileURLToPath } = await import('url');
  const currentFileUrl = import.meta.url;
  const currentFilePath = fileURLToPath(currentFileUrl);
  const currentDir = path.dirname(currentFilePath);
  
  // Detect if running in development mode (tsx/ts-node) vs production (built)
  const isDevelopment = currentFilePath.endsWith('.ts');
  
  // Precise path based on environment
  const viewerPath = isDevelopment
    ? path.join(currentDir, '../../static/graph_viewer.html')  // src/commands -> static
    : path.join(currentDir, 'static/graph_viewer.html');       // dist -> dist/static
  
  logger.debug(`Running in ${isDevelopment ? 'development' : 'production'} mode`);
  logger.debug(`currentDir: ${currentDir}`);
  logger.debug(`viewerPath: ${viewerPath}`);
  
  // Verify file exists
  const stat = await fileSystem.stat(viewerPath);
  if (!stat?.isFile) {
    throw new Error(`Graph viewer not found at: ${viewerPath}`);
  }
  
  await open(viewerPath);
  console.log(`\nOpened graph viewer in browser`);
  console.log(`  Drag and drop the JSON file into the browser to visualize`);
}

/**
 * Format and display dependency analysis summary
 */
function displaySummary(result: AnalysisResult): void {
  const { summary, nodes, relationships, cycles } = result;

  // Maximum number of examples to display for each category
  const MAX_EXAMPLES = 20;

  // Count component types
  const componentTypes = new Map<string, number>();
  for (const node of nodes.values()) {
    const count = componentTypes.get(node.componentType) || 0;
    componentTypes.set(node.componentType, count + 1);
  }

  // Count dependencies per module (file)
  // Use the file path (prefer relativePath for display)
  const moduleDeps = new Map<string, number>();
  for (const [nodeId, node] of nodes.entries()) {
    // Use relativePath if available and meaningful, otherwise basename of filePath
    let displayPath: string;
    if (node.relativePath && node.relativePath.length > 0 && node.relativePath !== node.filePath) {
      displayPath = node.relativePath;
    } else {
      // Extract just the filename for cleaner display
      const parts = node.filePath.split('/');
      displayPath = parts.length > 3 ? `.../${parts.slice(-2).join('/')}` : parts.slice(-1)[0];
    }

    const count = moduleDeps.get(displayPath) || 0;
    moduleDeps.set(displayPath, count + node.dependsOn.size);
  }

  // Classify edges by resolution status
  const resolvedEdges = relationships.filter(edge => edge.isResolved);
  const unresolvedEdges = relationships.filter(edge => !edge.isResolved);

  // Get top modules by dependencies
  const topModules = Array.from(moduleDeps.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_EXAMPLES)
    .filter(([_, count]) => count > 0);

  // Output summary
  console.log('\nDependency Analysis Summary');
  console.log('==========================');
  console.log(`Files:         ${summary.totalFiles}`);
  console.log(`Nodes:         ${summary.totalNodes}`);
  console.log(`Relationships: ${summary.totalRelationships}`);
  console.log(`Languages:     ${summary.languages.join(', ')}`);
  console.log(`Cycles:        ${cycles.length}`);

  // Component types with examples
  if (componentTypes.size > 0) {
    console.log('\nComponent Types:');
    for (const [type, count] of Array.from(componentTypes.entries()).sort((a, b) => b[1] - a[1])) {
      console.log(`  - ${type}: ${count} nodes`);

      // Get up to 5 examples of this component type
      const examples = Array.from(nodes.entries())
        .filter(([_, node]) => node.componentType === type)
        .slice(0, MAX_EXAMPLES);

      if (examples.length > 0) {
        for (const [id, _] of examples) {
          console.log(`      • ${id}`);
        }
      }
    }
  }

  // Top modules by dependencies
  if (topModules.length > 0) {
    console.log('\nTop modules by dependencies:');
    for (const [module, count] of topModules) {
      console.log(`  - ${module} (${count} deps)`);
    }
  }

  // Edge/Relationship statistics
  console.log('\nRelationship Types:');
  console.log(`  - Resolved edges: ${resolvedEdges.length} edges`);
  if (resolvedEdges.length > 0) {
    for (const edge of resolvedEdges.slice(0, MAX_EXAMPLES)) {
      const lineInfo = edge.callLine ? `:${edge.callLine}` : '';
      console.log(`      • ${edge.caller} → ${edge.callee}${lineInfo}`);
    }
  }

  console.log(`  - Unresolved edges: ${unresolvedEdges.length} edges`);
  if (unresolvedEdges.length > 0) {
    for (const edge of unresolvedEdges.slice(0, MAX_EXAMPLES)) {
      const lineInfo = edge.callLine ? `:${edge.callLine}` : '';
      console.log(`      • ${edge.caller} → ${edge.callee}${lineInfo}`);
    }
  }

  console.log('');
}

/**
 * Export dependency data to JSON file
 */
async function exportData(
  result: AnalysisResult,
  outputPath: string,
  openInBrowser: boolean,
  fileSystem: any
): Promise<void> {
  // Generate visualization data
  const viz = generateVisualizationData(result.nodes, result.relationships, result.summary);

  // Resolve output path (support relative paths)
  const resolvedPath = outputPath.startsWith('/') ? outputPath : `${process.cwd()}/${outputPath}`;

  // Write to file
  await fs.writeFile(resolvedPath, JSON.stringify(viz.cytoscape.elements, null, 2), 'utf-8');

  console.log(`\nDependency data exported to: ${resolvedPath}`);
  console.log(`  Nodes: ${viz.summary.total_nodes}`);
  console.log(`  Edges: ${viz.summary.total_edges}`);
  console.log(`  Languages: ${viz.summary.languages.join(', ')}`);

  // Optionally open in browser
  if (openInBrowser) {
    try {
      await openGraphViewer(fileSystem);
    } catch (error) {
      console.error(`\nWarning: Could not open browser: ${error}`);
      if (error instanceof Error) {
        console.error(error.message);
      }
    }
  }
}

/**
 * Query mode - single function
 */
function querySingleFunction(
  result: AnalysisResult,
  query: string,
  depth: number,
  asJson: boolean
): void {
  const matchedNodes = findMatchingNodes(result.nodes, query);

  if (matchedNodes.length === 0) {
    console.log(`\nNo nodes found matching: ${query}`);
    return;
  }

  // Query each matched node
  const queryOptions: QueryOptions = { depth };
  const queryResults: NodeQueryResult[] = [];

  for (const node of matchedNodes) {
    const queryResult = queryNode(result.nodes, node, queryOptions);
    queryResults.push(queryResult);
  }

  // Output results
  if (asJson) {
    console.log(JSON.stringify(queryResults, null, 2));
  } else {
    for (let i = 0; i < queryResults.length; i++) {
      if (i > 0) {
        console.log('\n' + '─'.repeat(60) + '\n');
      }
      const lines = formatNodeQueryResult(queryResults[i]);
      console.log(lines.join('\n'));
    }
  }
}

/**
 * Query mode - multiple functions (connection analysis)
 */
function queryMultipleFunctions(
  result: AnalysisResult,
  query: string,
  depth: number,
  asJson: boolean
): void {
  const analysisResult = analyzeConnections(result.nodes, query, depth);

  if (asJson) {
    console.log(JSON.stringify(analysisResult, null, 2));
  } else {
    const lines = formatConnectionAnalysisResult(analysisResult);
    console.log(lines.join('\n'));
  }
}

/**
 * Query mode handler
 */
function queryMode(
  result: AnalysisResult,
  query: string,
  depthStr: string,
  asJson: boolean
): void {
  const patterns = query.split(',').map(p => p.trim()).filter(p => p.length > 0);

  if (patterns.length === 0) {
    console.log('\nError: Empty query pattern');
    return;
  }

  // Determine depth based on query type
  let depth: number;
  if (depthStr) {
    // User explicitly provided depth
    depth = parseInt(depthStr, 10);
  } else {
    // Use different defaults based on query type
    depth = patterns.length > 1 ? 10 : 3;
  }

  // Multiple patterns (comma-separated) -> connection analysis
  // Single pattern -> single function query with depth
  if (patterns.length > 1) {
    queryMultipleFunctions(result, query, depth, asJson);
  } else {
    querySingleFunction(result, query, depth, asJson);
  }
}

/**
 * Call command handler
 *
 * Provides dependency analysis with multiple output modes:
 * - Summary mode (default): Display statistics overview
 * - Export mode (--output): Export data to JSON file
 * - Query mode (--query): Query specific dependencies
 * - Open mode (--open): Open HTML visualization
 */
async function callHandler(targetPath: string | undefined, options: CommandOptions): Promise<void> {
  // Initialize logger
  initGlobalLogger(options.logLevel);
  const logger = getLogger();

  // Resolve workspace path (working directory)
  const workspacePath = resolveWorkspacePath(options.path, options.demo);

  // Handle --clear-cache
  if (options.clearCache) {
    logger.info('Clearing dependency analysis cache...');
    
    // Determine repository root (same logic as analyze function)
    const { createNodeDependencies } = await import('../adapters/nodejs');
    const fullDeps = createNodeDependencies({
      workspacePath: workspacePath,
      storageOptions: {
        globalStoragePath: options.storage || process.cwd(),
      },
      loggerOptions: {
        name: 'Call-CLI',
        level: options.logLevel,
        timestamps: true,
      },
    });
    
    // Determine path to check (same logic as analyze)
    const pathToCheck = targetPath 
      ? (path.isAbsolute(targetPath) ? targetPath : path.join(workspacePath, targetPath))
      : workspacePath;
    
    const stat = await fullDeps.fileSystem.stat(pathToCheck);
    const isFile = stat?.isFile ?? false;
    const startPath = isFile ? fullDeps.pathUtils.dirname(pathToCheck) : pathToCheck;
    
    // Priority 1: Use Git repository root
    const { findGitRoot } = await import('../dependency/index');
    const gitRoot = await findGitRoot(startPath, fullDeps.fileSystem);
    
    let repoPath: string;
    if (gitRoot) {
      repoPath = gitRoot;
    } else {
      // Priority 2: Use workspace root if available
      const workspaceRoot = fullDeps.workspace?.getRootPath();
      if (workspaceRoot) {
        repoPath = workspaceRoot;
      } else {
        // Priority 3: Fall back to start path
        repoPath = startPath;
      }
    }
    
    // Create cache manager and clear
    const { DependencyCacheManager } = await import('../dependency/cache-manager');
    const cacheManager = new DependencyCacheManager(
      repoPath, 
      fullDeps.fileSystem, 
      options.cache
    );
    await cacheManager.initialize();
    
    // Get cache stats before clearing
    const statsBefore = cacheManager.getStats();
    
    await cacheManager.clearCache();
    
    // Always show success message (not just in info mode)
    console.log('\n✓ Dependency cache cleared successfully');
    console.log(`  Repository: ${repoPath}`);
    if (statsBefore.totalFiles > 0) {
      console.log(`  Cached files cleared: ${statsBefore.cachedFiles}/${statsBefore.totalFiles}`);
    } else {
      console.log('  (Cache was empty)');
    }
    console.log('');
    
    return;
  }

  // Determine the path to analyze (relative to workspace or absolute)
  let pathToAnalyze: string;
  if (targetPath) {
    // If targetPath is provided, it's relative to workspace (or absolute)
    if (path.isAbsolute(targetPath)) {
      pathToAnalyze = targetPath;
    } else {
      pathToAnalyze = path.join(workspacePath, targetPath);
    }
  } else {
    // No targetPath means analyze the entire workspace
    pathToAnalyze = workspacePath;
  }

  logger.debug(`Workspace: ${workspacePath}`);
  logger.debug(`Analyzing path: ${pathToAnalyze}`);

  // Create dependencies with workspace (like index/outline commands)
  // This ensures IgnoreService uses the correct rootPath
  const { createNodeDependencies } = await import('../adapters/nodejs');
  const fullDeps = createNodeDependencies({
    workspacePath: workspacePath,
    storageOptions: {
      globalStoragePath: options.storage || process.cwd(),
    },
    loggerOptions: {
      name: 'Call-CLI',
      level: options.logLevel,
      timestamps: true,
      colors: true,
    },
    configOptions: options.config ? { configPath: options.config } : {},
  });

  // Create demo files if requested
  if (options.demo) {
    await ensureDemoFiles(workspacePath, fullDeps.fileSystem);
  }

  const deps: DependencyAnalyzerDeps = {
    fileSystem: fullDeps.fileSystem,
    pathUtils: fullDeps.pathUtils,
    workspace: fullDeps.workspace,
  };

  // Determine output mode
  const hasOutput = !!options.output;
  const hasQuery = !!options.query;
  const hasOpen = !!options.open;

  try {
    // Perform analysis
    logger.info('Analyzing dependencies...');
    const result = await analyze(pathToAnalyze, deps, {
      enableCache: true,
      cacheBaseDir: options.cache,
    });

    // Mode selection
    if (hasOutput) {
      // Export mode - Task 3
      await exportData(result, options.output!, hasOpen, fullDeps.fileSystem);
    } else if (hasQuery) {
      // Query mode - Task 4
      queryMode(result, options.query!, options.depth || '10', options.json);
    } else if (hasOpen) {
      // Open mode - directly open viewer without exporting
      try {
        await openGraphViewer(fullDeps.fileSystem);
        logger.info('Opened graph viewer in browser');
        console.log('\n✓ Graph viewer opened');
        console.log('  Drag and drop a dependency JSON file to visualize');
      } catch (error) {
        logger.error(`Could not open graph viewer: ${error}`);
        if (error instanceof Error) {
          console.error(`\n${error.message}`);
        }
        process.exit(1);
      }
    } else {
      // Summary mode (default) - Task 2
      displaySummary(result);
    }

    // Display errors if any
    if (result.errors && result.errors.length > 0) {
      logger.warn(`Encountered ${result.errors.length} error(s) during analysis`);
      if (options.logLevel === 'debug') {
        for (const error of result.errors.slice(0, 10)) {
          logger.debug(`  - ${error}`);
        }
        if (result.errors.length > 10) {
          logger.debug(`  ... and ${result.errors.length - 10} more`);
        }
      }
    }

  } catch (error) {
    logger.error('Analysis failed');
    if (error instanceof Error) {
      logger.error(error.message);
      if (options.logLevel === 'debug') {
        logger.error(error.stack || '');
      }
    }
    process.exit(1);
  }
}

/**
 * Create call command
 *
 * Provides dependency analysis capabilities including:
 * - Analyzing code dependencies in files/directories
 * - Exporting dependency data to JSON
 * - Generating HTML visualizations
 * - Querying dependency relationships
 */
export function createCallCommand(): Command {
  const command = new Command('call');

  command
    .description('Analyze code dependencies')
    .argument('[path]', 'Path to analyze (file or directory)', '.')
    .option('-p, --path <path>', 'Working directory path', '.')
    .option('-c, --config <path>', 'Configuration file path')
    .option('--demo', 'Use demo workspace')
    .option('--output <file>', 'Export dependency data to JSON file')
    .option('--open', 'Open HTML visualization in browser')
    .option('--query <names>', [
      'Query dependencies for specific names',
      '',
      'Pattern Matching:',
      '  - Exact match: "functionName" or "ClassName.methodName"',
      '  - Wildcards: "*" (any chars), "?" (single char)',
      '    Examples: "get*", "*User*", "*.*.get*"',
      '',
      'Query Modes:',
      '  - Single pattern: --query="main"',
      '    → Shows dependency tree: what "main" calls and who calls "main"',
      '  - Multiple patterns (comma-separated): --query="main,helper"',
      '    → Analyzes connections: how "main" connects to "helper"'
    ].join('\n                       '))
    .option('--depth <number>', 'Query depth for dependency traversal (default: 3 for single query, 10 for multi-query)')
    .option('--json', 'Output query results in JSON format')
    .option('--clear-cache', 'Clear dependency analysis cache')
    .option('--log-level <level>', 'Log level: debug|info|warn|error', 'error')
    .option('--storage <path>', 'Custom storage path')
    .option('--cache <path>', 'Custom cache path')
    .action(callHandler);

  return command;
}
