/**
 * Call command implementation
 *
 * Analyze code dependencies and generate visualization data
 */
import { Command } from 'commander';
import { CommandOptions } from './shared';
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
import { NodeFileSystem } from '../adapters/nodejs/file-system';
import { NodePathUtils } from '../adapters/nodejs/workspace';
import { promises as fs } from 'fs';
import path from 'path';
import open from 'open';

/**
 * Format and display dependency analysis summary
 */
function displaySummary(result: Awaited<ReturnType<typeof analyze>>): void {
  const { summary, nodes, relationships, cycles } = result;

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

  // Get top modules by dependencies
  const topModules = Array.from(moduleDeps.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .filter(([_, count]) => count > 0);

  // Output summary
  console.log('\nDependency Analysis Summary');
  console.log('==========================');
  console.log(`Files:         ${summary.totalFiles}`);
  console.log(`Nodes:         ${summary.totalNodes}`);
  console.log(`Relationships: ${summary.totalRelationships}`);
  console.log(`Languages:     ${summary.languages.join(', ')}`);
  console.log(`Cycles:        ${cycles.length}`);

  // Component types
  if (componentTypes.size > 0) {
    console.log('\nComponent Types:');
    for (const [type, count] of Array.from(componentTypes.entries()).sort((a, b) => b[1] - a[1])) {
      console.log(`  - ${type}: ${count}`);
    }
  }

  // Top modules by dependencies
  if (topModules.length > 0) {
    console.log('\nTop modules by dependencies:');
    for (const [module, count] of topModules) {
      console.log(`  - ${module} (${count} deps)`);
    }
  }

  console.log('');
}

/**
 * Export dependency data to JSON file
 */
async function exportData(
  result: Awaited<ReturnType<typeof analyze>>,
  outputPath: string,
  openInBrowser: boolean
): Promise<void> {
  // Generate visualization data
  const viz = generateVisualizationData(result.nodes, result.relationships, result.summary);

  // Resolve output path (support relative paths)
  const resolvedPath = path.resolve(process.cwd(), outputPath);

  // Write to file
  await fs.writeFile(resolvedPath, JSON.stringify(viz.cytoscape.elements, null, 2), 'utf-8');

  console.log(`\nDependency data exported to: ${resolvedPath}`);
  console.log(`  Nodes: ${viz.summary.total_nodes}`);
  console.log(`  Edges: ${viz.summary.total_edges}`);
  console.log(`  Languages: ${viz.summary.languages.join(', ')}`);

  // Optionally open in browser
  if (openInBrowser) {
    // Convert file path to file:// URL
    const fileUrl = `file://${resolvedPath}`;
    try {
      await open(fileUrl);
      console.log(`\nOpened in default browser`);
    } catch (error) {
      console.error(`\nWarning: Could not open browser: ${error}`);
      console.log(`  Manually open: ${resolvedPath}`);
    }
  }
}

/**
 * Query mode - single function
 */
function querySingleFunction(
  result: Awaited<ReturnType<typeof analyze>>,
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
  result: Awaited<ReturnType<typeof analyze>>,
  query: string,
  asJson: boolean
): void {
  const analysisResult = analyzeConnections(result.nodes, query);

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
  result: Awaited<ReturnType<typeof analyze>>,
  query: string,
  depthStr: string,
  asJson: boolean
): void {
  const depth = parseInt(depthStr, 10) || 10;
  const patterns = query.split(',').map(p => p.trim()).filter(p => p.length > 0);

  if (patterns.length === 0) {
    console.log('\nError: Empty query pattern');
    return;
  }

  // Single pattern or wildcard pattern -> single function query
  // Multiple patterns -> connection analysis
  if (patterns.length === 1 || patterns.some(p => p.includes('*') || p.includes('?'))) {
    querySingleFunction(result, query, depth, asJson);
  } else {
    queryMultipleFunctions(result, query, asJson);
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
async function callHandler(targetPath: string, options: CommandOptions): Promise<void> {
  // Initialize logger
  const { initGlobalLogger, getLogger, resolveWorkspacePath } = await import('./shared');
  initGlobalLogger(options.logLevel);
  const logger = getLogger();

  // Resolve target path
  const resolvedPath = resolveWorkspacePath(targetPath, options.demo);
  logger.debug(`Analyzing path: ${resolvedPath}`);

  // Create dependencies
  const fileSystem = new NodeFileSystem();
  const pathUtils = new NodePathUtils();
  const deps: DependencyAnalyzerDeps = { fileSystem, pathUtils };

  // Determine max files (can be configured later)
  const maxFiles = 100;

  // Determine if we should use special modes
  const hasOutput = !!options.output;
  const hasQuery = !!options.query;
  const hasOpen = !!options.open;

  try {
    // Perform analysis
    logger.info('Analyzing dependencies...');
    const result = await analyze(resolvedPath, deps, maxFiles, {
      enableCache: true,
      cacheBaseDir: options.cache,
    });

    // Mode selection
    if (hasOutput) {
      // Export mode - Task 3
      await exportData(result, options.output!, hasOpen);
    } else if (hasQuery) {
      // Query mode - Task 4
      queryMode(result, options.query!, options.depth || '10', options.json);
    } else if (hasOpen) {
      // Open mode - TODO: Task 5
      logger.error('Open mode (--open) not yet implemented');
      process.exit(1);
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
    .argument('<path>', 'Path to analyze (file or directory)')
    .option('-p, --path <path>', 'Working directory path', '.')
    .option('-c, --config <path>', 'Configuration file path')
    .option('--demo', 'Use demo workspace')
    .option('--output <file>', 'Export dependency data to JSON file')
    .option('--open', 'Open HTML visualization in browser')
    .option('--query <names>', 'Query dependencies for specific names (comma-separated)')
    .option('--depth <number>', 'Query depth for dependency traversal', '10')
    .option('--json', 'Output query results in JSON format')
    .option('--log-level <level>', 'Log level: debug|info|warn|error', 'error')
    .option('--storage <path>', 'Custom storage path')
    .option('--cache <path>', 'Custom cache path')
    .action(callHandler);

  return command;
}
