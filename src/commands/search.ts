/**
 * Search command implementation
 */
import { Command } from 'commander';
import { CommandOptions, initializeManager, waitForIndexingCompletion, getLogger, initGlobalLogger, resolveWorkspacePath } from './shared';
import { VectorStoreSearchResult, SearchFilter } from '../code-index/interfaces';
import { parsePathFilters } from '../utils/path-filters';
import { validateLimit, validateMinScore } from '../code-index/validate-search-params';

interface SearchResult {
  payload?: {
    filePath?: string;
    codeChunk?: string;
    startLine?: number;
    endLine?: number;
    hierarchyDisplay?: string;
    highlightedText?: string;
  } | null;
  score?: number;
}

/**
 * Format search results for display
 */
function formatSearchResults(results: SearchResult[], query: string): string {
  if (!results || results.length === 0) {
    return `No results found for query: "${query}"`;
  }

  const resultsByFile = new Map<string, SearchResult[]>();
  results.forEach((result: SearchResult) => {
    const filePath = result.payload?.filePath || 'Unknown file';
    if (!resultsByFile.has(filePath)) {
      resultsByFile.set(filePath, []);
    }
    resultsByFile.get(filePath)!.push(result);
  });

  const formattedResults = Array.from(resultsByFile.entries()).map(([filePath, fileResults]) => {
    fileResults.sort((a, b) => (b.score || 0) - (a.score || 0));

    const deduplicatedResults = [];
    for (let i = 0; i < fileResults.length; i++) {
      const current = fileResults[i];
      const currentStart = current.payload?.startLine || 0;
      const currentEnd = current.payload?.endLine || 0;

      let isContained = false;
      for (let j = 0; j < fileResults.length; j++) {
        if (i === j) continue;

        const other = fileResults[j];
        const otherStart = other.payload?.startLine || 0;
        const otherEnd = other.payload?.endLine || 0;

        if (otherStart <= currentStart && otherEnd >= currentEnd &&
            !(otherStart === currentStart && otherEnd === currentEnd)) {
          isContained = true;
          break;
        }
      }

      if (!isContained) {
        deduplicatedResults.push(current);
      }
    }

    // 过滤掉高亮器判定为"not related"的结果（highlightedText 存在但为空）
    const dedupRemoved = fileResults.length - deduplicatedResults.length
    const meaningfulResults = deduplicatedResults.filter((result: SearchResult) => {
      // 如果 highlightedText 为 undefined，说明高亮器未运行，保留
      if (result.payload?.["highlightedText"] === undefined) return true
      // 高亮器运行了但返回空结果，说明与 query 无关，过滤掉
      return result.payload["highlightedText"] !== ""
    })
    const highlightRemoved = deduplicatedResults.length - meaningfulResults.length

    // 如果全部被过滤，跳过该文件
    if (meaningfulResults.length === 0) return null

    const avgScore = meaningfulResults.length > 0
      ? meaningfulResults.reduce((sum, r) => sum + (r.score || 0), 0) / meaningfulResults.length
      : 0;

    const codeChunks = meaningfulResults.map((result: SearchResult) => {
      // 优先使用高亮文本，回退到原始代码块
      const highlightedText = result.payload?.["highlightedText"];
      const codeChunk = highlightedText || result.payload?.codeChunk || 'No content available';
      const startLine = result.payload?.startLine;
      const endLine = result.payload?.endLine;
      const lineInfo = (startLine !== undefined && endLine !== undefined)
          ? `(L${startLine}-${endLine})`
          : '';
      const hierarchyInfo = result.payload?.hierarchyDisplay ? `< ${result.payload?.hierarchyDisplay} > `
          : '';
      return `${hierarchyInfo}${lineInfo}
${codeChunk}`;
    }).join('\n' + '─'.repeat(5) + '\n');

    const snippetInfo = meaningfulResults.length > 1 ? ` | ${meaningfulResults.length} snippets` : '';
    const parts: string[] = []
    if (dedupRemoved > 0) parts.push(`${dedupRemoved} duplicates removed`)
    if (highlightRemoved > 0) parts.push(`${highlightRemoved} not related`)
    const removedInfo = parts.length > 0 ? ` (${parts.join(', ')})` : '';

    return {
      filePath,
      topScore: meaningfulResults[0]?.score || 0,
      avgScore,
      formattedText: `${'='.repeat(50)}\nFile: "${filePath}"${snippetInfo}${removedInfo}\n\n${codeChunks}`
    };
  });

  const filtered = formattedResults.filter((r): r is NonNullable<typeof r> => r !== null)
  filtered.sort((a, b) => b.topScore - a.topScore);

  const fileCount = filtered.length;
  const totalSnippets = filtered.reduce((sum, r) => {
    // extract snippet count from formattedText
    const match = r.formattedText.match(/\| (\d+) snippets/)
    return sum + (match ? parseInt(match[1], 10) : 1)
  }, 0)
  const summary = `Found ${totalSnippets} result${totalSnippets > 1 ? 's' : ''} in ${fileCount} file${fileCount > 1 ? 's' : ''} for: "${query}"

`;

  const formattedTexts = filtered.map(r => r.formattedText);
  return summary + formattedTexts.join('\n\n');
}

/**
 * Format search results as JSON
 */
function formatSearchResultsAsJson(results: SearchResult[], query: string): string {
  if (!results) {
    return JSON.stringify({
      query,
      totalResults: 0,
      snippets: []
    }, null, 2);
  }

  results.sort((a, b) => (b.score || 0) - (a.score || 0));

  const deduplicatedResults = [];
  for (let i = 0; i < results.length; i++) {
    const current = results[i];
    const currentFilePath = current.payload?.filePath;
    const currentStart = current.payload?.startLine || 0;
    const currentEnd = current.payload?.endLine || 0;

    let isContained = false;
    for (let j = 0; j < results.length; j++) {
      if (i === j) continue;

      const other = results[j];
      const otherFilePath = other.payload?.filePath;

      if (otherFilePath !== currentFilePath) continue;

      const otherStart = other.payload?.startLine || 0;
      const otherEnd = other.payload?.endLine || 0;

      if (otherStart <= currentStart && otherEnd >= currentEnd &&
          !(otherStart === currentStart && otherEnd === currentEnd)) {
        isContained = true;
        break;
      }
    }

    if (!isContained) {
      deduplicatedResults.push(current);
    }
  }

  const snippets = deduplicatedResults.map((result: SearchResult) => {
    const startLine = result.payload?.startLine;
    const endLine = result.payload?.endLine;
    const snippet: any = {
      filePath: result.payload?.filePath || 'Unknown file',
      code: result.payload?.codeChunk || '',
      startLine: startLine,
      endLine: endLine,
      lineRange: startLine !== undefined && endLine !== undefined ? `L${startLine}-${endLine}` : '',
      hierarchy: result.payload?.hierarchyDisplay || '',
      score: parseFloat((result.score || 0).toFixed(3))
    };
    // Include highlighted text if available
    if (result.payload?.["highlightedText"]) {
      snippet.highlightedText = result.payload["highlightedText"];
    }
    return snippet;
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

/**
 * Search command handler
 */
async function searchHandler(query: string, options: any): Promise<void> {
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
    json: !!options.json,
    pathFilters: options.pathFilters,
    limit: options.limit,
    minScore: options.minScore,
    summarize: false,
    title: false,
    clearCache: false,
    dryRun: false
  };

  initGlobalLogger(commandOptions.logLevel);

  getLogger().info('Search mode');
  getLogger().info(`Query: "${query}"`);
  getLogger().info(`Workspace: ${commandOptions.path}`);

  const filter: SearchFilter = {};
  if (options.pathFilters) {
    const filters = parsePathFilters(options.pathFilters)
      .map((f: string) => f.startsWith('=') ? f.slice(1) : f)
      .filter((f: string) => f.length > 0);
    filter.pathFilters = filters;
    getLogger().info(`Path filters: ${filters.join(', ')}`);
  }

  if (options.limit !== undefined) {
    filter.limit = validateLimit(options.limit);
    getLogger().info(`Limit: ${filter.limit}`);
  }

  if (options.minScore !== undefined) {
    filter.minScore = validateMinScore(options.minScore);
    getLogger().info(`Min score: ${filter.minScore}`);
  }

  const manager = await initializeManager(commandOptions, { searchOnly: true });
  if (!manager) {
    process.exit(1);
  }

  if (!manager.isFeatureEnabled) {
    getLogger().error('Code indexing feature is not enabled');
    process.exit(1);
  }

  try {
    getLogger().info('Searching index...');
    let results: VectorStoreSearchResult[];

    try {
      results = await manager.searchIndex(query, filter);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Code index is not ready for search')) {
        getLogger().info('Index is not ready. Running indexing before search...');
        await waitForIndexingCompletion(manager);
        getLogger().info('Retrying search after indexing...');
        results = await manager.searchIndex(query, filter);
      } else {
        throw error;
      }
    }

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
    manager.dispose();
    getLogger().info('Search completed. Exiting...');
  }
}

/**
 * Create search command
 */
export function createSearchCommand(): Command {
  const command = new Command('search');

  command
    .description('Search the codebase using semantic search')
    .argument('<query>', 'Search query')
    .option('-p, --path <path>', 'Working directory path', '.')
    .option('-c, --config <path>', 'Configuration file path')
    .option('-f, --path-filters <filters>', 'Filter results by path patterns (comma-separated)')
    .option('-l, --limit <number>', 'Maximum number of results')
    .option('-S, --min-score <number>', 'Minimum similarity score (0-1)')
    .option('--json', 'Output results in JSON format')
    .option('--log-level <level>', 'Log level: debug|info|warn|error', 'error')
    .option('--storage <path>', 'Custom storage path')
    .option('--cache <path>', 'Custom cache path')
    .option('--demo', 'Use demo workspace')
    .action(searchHandler);

  return command;
}
