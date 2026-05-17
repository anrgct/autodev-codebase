/**
 * Cache command implementation
 * Unified management for all cache types and Qdrant vector store data
 */
import { Command } from 'commander';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { getLogger, initGlobalLogger, resolveWorkspacePath, createDependencies, registerProjectToCacheMap } from './shared';
import { QdrantClient } from '@qdrant/js-client-rest';

// ============================================================================
// Types
// ============================================================================

type CacheType = 'index' | 'summary' | 'dependency' | 'qdrant';

interface CacheEntry {
  /** 1-based display index */
  index: number;
  /** Internal cache type */
  type: CacheType;
  /** Human-readable type label */
  typeLabel: string;
  /** Project identifier (truncated hash) */
  projectHash: string;
  /** Resolved project name (directory basename), falls back to hash prefix */
  projectName: string;
  /** Number of items (files/entries/points) */
  itemCount?: number;
  /** Size in bytes */
  sizeBytes?: number;
  /** File/directory path or Qdrant collection descriptor */
  path: string;
  /** Status */
  status: 'ok' | 'unreachable' | 'empty';
  /** Additional status detail (e.g. Qdrant URL) */
  statusDetail?: string;
  /** Full absolute path (for local caches) or Qdrant URL */
  absolutePath?: string;
  /** Qdrant-specific: collection name */
  collectionName?: string;
  /** Qdrant-specific: API key */
  qdrantApiKey?: string;
}

// ============================================================================
// Local Cache Discovery
// ============================================================================

const CACHE_BASE = path.join(os.homedir(), '.autodev-cache');
const PROJECT_MAP_FILE = path.join(CACHE_BASE, 'project-map.json');

/**
 * Project map: hash → workspace absolute path
 */
interface ProjectMap {
  [hash: string]: string;
}

/**
 * Load project hash → workspace path mapping
 */
async function loadProjectMap(): Promise<ProjectMap> {
  try {
    const content = await fs.promises.readFile(PROJECT_MAP_FILE, 'utf-8');
    return JSON.parse(content) as ProjectMap;
  } catch {
    return {};
  }
}

/**
 * Resolve project name from hash using the project map
 * Falls back to truncated hash prefix if unknown
 */
function resolveProjectName(projectHash: string, map: ProjectMap): string {
  const workspacePath = map[projectHash];
  if (workspacePath) {
    return path.basename(workspacePath);
  }
  // Fallback: show truncated hash
  if (projectHash.length > 8) {
    return `未知(${projectHash.substring(0, 8)}...)`;
  }
  return `未知(${projectHash})`;
}

/**
 * Discover all local cache entries by scanning ~/.autodev-cache/
 */
async function discoverLocalCaches(map: ProjectMap): Promise<CacheEntry[]> {
  const entries: CacheEntry[] = [];

  try {
    await fs.promises.access(CACHE_BASE);
  } catch {
    return entries; // Cache directory doesn't exist
  }

  const dirents = await fs.promises.readdir(CACHE_BASE, { withFileTypes: true });

  // 1. Index caches: roo-index-cache-{sha256}.json
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const match = dirent.name.match(/^roo-index-cache-(.+)\.json$/);
    if (!match) continue;

    const fullHash = match[1];
    const projectHash = fullHash.substring(0, 16);
    const fullPath = path.join(CACHE_BASE, dirent.name);

    let itemCount: number | undefined;
    let sizeBytes: number | undefined;
    try {
      const stat = await fs.promises.stat(fullPath);
      sizeBytes = stat.size;
      const content = await fs.promises.readFile(fullPath, 'utf-8');
      const data = JSON.parse(content);
      itemCount = Object.keys(data).length;
    } catch {
      // File unreadable, skip stats
    }

    entries.push({
      index: 0, // assigned later
      type: 'index',
      typeLabel: '代码索引缓存',
      projectHash,
      projectName: resolveProjectName(projectHash, map),
      itemCount,
      sizeBytes,
      path: dirent.name,
      absolutePath: fullPath,
      status: 'ok',
    });
  }

  // 2. Summary caches: summary-cache/{projectHash}/files/...
  const summaryDir = path.join(CACHE_BASE, 'summary-cache');
  try {
    const summaryProjects = await fs.promises.readdir(summaryDir, { withFileTypes: true });
    for (const dirent of summaryProjects) {
      if (!dirent.isDirectory()) continue;
      const projectHash = dirent.name;
      const projectDir = path.join(summaryDir, projectHash);
      const filesDir = path.join(projectDir, 'files');

      let itemCount: number | undefined;
      let sizeBytes: number | undefined;
      let status: CacheEntry['status'] = 'ok';

      try {
        await fs.promises.access(filesDir);
        const stats = await countDirStats(filesDir);
        itemCount = stats.fileCount;
        sizeBytes = stats.totalSize;
        if (itemCount === 0) status = 'empty';
      } catch {
        status = 'empty';
        itemCount = 0;
        sizeBytes = 0;
      }

      entries.push({
        index: 0,
        type: 'summary',
        typeLabel: 'AI摘要缓存',
        projectHash,
        projectName: resolveProjectName(projectHash, map),
        itemCount,
        sizeBytes,
        path: `summary-cache/${projectHash}/`,
        absolutePath: projectDir,
        status,
      });
    }
  } catch {
    // No summary cache directory
  }

  // 3. Dependency caches: dependency-cache/{projectHash}/analysis-cache.json
  const depDir = path.join(CACHE_BASE, 'dependency-cache');
  try {
    const depProjects = await fs.promises.readdir(depDir, { withFileTypes: true });
    for (const dirent of depProjects) {
      if (!dirent.isDirectory()) continue;
      const projectHash = dirent.name;
      const analysisFile = path.join(depDir, projectHash, 'analysis-cache.json');

      let itemCount: number | undefined;
      let sizeBytes: number | undefined;
      let status: CacheEntry['status'] = 'ok';

      try {
        const stat = await fs.promises.stat(analysisFile);
        sizeBytes = stat.size;
        const content = await fs.promises.readFile(analysisFile, 'utf-8');
        const data = JSON.parse(content);
        itemCount = data.files ? Object.keys(data.files).length : 0;
        if (itemCount === 0) status = 'empty';
      } catch {
        status = 'empty';
        itemCount = 0;
        sizeBytes = 0;
      }

      entries.push({
        index: 0,
        type: 'dependency',
        typeLabel: '依赖分析缓存',
        projectHash,
        projectName: resolveProjectName(projectHash, map),
        itemCount,
        sizeBytes,
        path: `dependency-cache/${projectHash}/`,
        absolutePath: path.join(depDir, projectHash),
        status,
      });
    }
  } catch {
    // No dependency cache directory
  }

  return entries;
}

/**
 * Recursively count files and total size in a directory
 */
async function countDirStats(dirPath: string): Promise<{ fileCount: number; totalSize: number }> {
  let fileCount = 0;
  let totalSize = 0;

  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        fileCount++;
        try {
          const stat = await fs.promises.stat(fullPath);
          totalSize += stat.size;
        } catch {
          // skip
        }
      }
    }
  }

  return { fileCount, totalSize };
}

// ============================================================================
// Qdrant Discovery
// ============================================================================

/**
 * Discover Qdrant collections from the configured Qdrant server
 */
async function discoverQdrantCollections(
  qdrantUrl: string,
  map: ProjectMap,
  qdrantApiKey?: string
): Promise<CacheEntry[]> {
  const entries: CacheEntry[] = [];

  let client: QdrantClient;
  try {
    client = new QdrantClient({
      url: qdrantUrl,
      apiKey: qdrantApiKey,
      headers: { 'User-Agent': 'AutoDev' },
    });
  } catch {
    // Invalid URL
    return entries;
  }

  let collections: any[];
  try {
    const result = await client.getCollections();
    collections = result.collections || [];
  } catch {
    // Qdrant unreachable — return a single entry indicating the status
    entries.push({
      index: 0,
      type: 'qdrant',
      typeLabel: 'Qdrant向量库',
      projectHash: '-',
      projectName: '-',
      path: qdrantUrl,
      absolutePath: qdrantUrl,
      status: 'unreachable',
      statusDetail: qdrantUrl,
    });
    return entries;
  }

  // Filter collections matching ws-{hash} pattern
  const wsCollections = collections.filter((c: any) =>
    c.name && /^ws-[a-f0-9]{16}$/.test(c.name)
  );

  if (wsCollections.length === 0) {
    entries.push({
      index: 0,
      type: 'qdrant',
      typeLabel: 'Qdrant向量库',
      projectHash: '-',
      projectName: '-',
      path: qdrantUrl,
      absolutePath: qdrantUrl,
      status: 'empty',
      statusDetail: `${qdrantUrl} (无向量集合)`,
    });
    return entries;
  }

  for (const col of wsCollections) {
    const projectHash = col.name.replace(/^ws-/, '');
    let itemCount: number | undefined;
    let status: CacheEntry['status'] = 'ok';

    try {
      const info = await client.getCollection(col.name);
      itemCount = info.points_count ?? info.indexed_vectors_count ?? undefined;
      if (itemCount === 0) status = 'empty';
    } catch {
      status = 'unreachable';
    }

    entries.push({
      index: 0,
      type: 'qdrant',
      typeLabel: 'Qdrant向量库',
      projectHash,
      projectName: resolveProjectName(projectHash, map),
      itemCount,
      sizeBytes: undefined, // Qdrant doesn't expose size easily
      path: `${qdrantUrl} / ${col.name}`,
      absolutePath: qdrantUrl,
      collectionName: col.name,
      qdrantApiKey,
      status,
      statusDetail: qdrantUrl,
    });
  }

  return entries;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0);
  return `${size} ${units[i]}`;
}

/**
 * Format item count to human-readable string
 */
function formatCount(type: CacheType, count?: number): string {
  if (count === undefined || count === null) return '-';
  const suffix =
    type === 'qdrant' ? ' pts' :
    type === 'dependency' ? ' 条目' :
    ' 文件';
  return `${count.toLocaleString()}${suffix}`;
}

/**
 * Status icon
 */
function statusIcon(status: string, detail?: string): string {
  if (status === 'ok') return '✓';
  if (status === 'unreachable') return '✗ 不可达' + (detail ? ` (${detail})` : '');
  if (status === 'empty') return '○ 空';
  return status;
}

/**
 * Parse --clear argument into a set of 1-based indices
 * Supports: "1", "1,3", "2-4", "1,3-5", "all"
 */
function parseClearIndices(input: string, maxIndex: number): Set<number> {
  if (input === 'all') {
    return new Set(Array.from({ length: maxIndex }, (_, i) => i + 1));
  }

  const indices = new Set<number>();
  const parts = input.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end) || start < 1 || end > maxIndex || start > end) {
        throw new Error(`无效的范围: ${trimmed}（有效范围：1-${maxIndex}）`);
      }
      for (let i = start; i <= end; i++) {
        indices.add(i);
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (isNaN(num) || num < 1 || num > maxIndex) {
        throw new Error(`无效的序号: ${trimmed}（有效范围：1-${maxIndex}）`);
      }
      indices.add(num);
    }
  }

  return indices;
}

// ============================================================================
// Listing
// ============================================================================

/**
 * Print cache list in table format
 */
function printTable(entries: CacheEntry[]): void {
  if (entries.length === 0) {
    console.log('未发现任何缓存或向量数据。');
    return;
  }

  console.log('');
  console.log('=== Cache & Data Store List ===');
  console.log('');

  // Column widths
  const idxW = 6;
  const typeW = 14;
  const projW = 18;
  const countW = 12;
  const sizeW = 10;
  const statusW = 30;

  // Header
  const header =
    '序号'.padEnd(idxW) +
    '类型'.padEnd(typeW) +
    '项目'.padEnd(projW) +
    '条目数'.padEnd(countW) +
    '大小'.padEnd(sizeW) +
    '状态';
  console.log(header);
  console.log('─'.repeat(idxW + typeW + projW + countW + sizeW + statusW));

  // Rows
  for (const entry of entries) {
    const idx = String(entry.index).padEnd(idxW);
    const type = entry.typeLabel.padEnd(typeW);
    const proj = entry.projectName.padEnd(projW);
    const count = formatCount(entry.type, entry.itemCount).padEnd(countW);
    const size = formatBytes(entry.sizeBytes).padEnd(sizeW);
    const status = statusIcon(entry.status, entry.statusDetail);
    console.log(`${idx}${type}${proj}${count}${size}${status}`);
  }

  console.log('');
}

/**
 * Print cache list in JSON format
 */
function printJson(entries: CacheEntry[]): void {
  const output = entries.map((entry) => ({
    index: entry.index,
    type: entry.type,
    typeLabel: entry.typeLabel,
    projectHash: entry.projectHash,
    projectName: entry.projectName,
    itemCount: entry.itemCount,
    sizeBytes: entry.sizeBytes,
    sizeHuman: formatBytes(entry.sizeBytes),
    path: entry.path,
    status: entry.status,
    statusDetail: entry.statusDetail,
  }));
  console.log(JSON.stringify(output, null, 2));
}

// ============================================================================
// Clearing
// ============================================================================

/**
 * Remove a directory recursively
 */
async function removeDir(dirPath: string): Promise<void> {
  try {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`无法删除 ${dirPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Remove a file
 */
async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    throw new Error(`无法删除 ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Execute cache clearing based on parsed indices
 */
async function executeClear(
  entries: CacheEntry[],
  clearIndices: Set<number>,
  skipConfirm: boolean
): Promise<void> {
  const targets = entries.filter((e) => clearIndices.has(e.index));

  if (targets.length === 0) {
    console.log('没有匹配的缓存需要清除。');
    return;
  }

  // Print what will be cleared
  console.log('\n将要清除以下缓存：\n');
  for (const t of targets) {
    console.log(`  [${t.index}] ${t.typeLabel} — ${t.path}`);
  }
  console.log('');

  if (!skipConfirm) {
    // Prompt for confirmation
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question('确认清除？(y/N) ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log('已取消。');
      return;
    }
  }

  // Execute deletion
  let clearedCount = 0;
  let failedCount = 0;

  for (const t of targets) {
    try {
      if (t.type === 'qdrant') {
        // Qdrant: delete collection via API
        if (t.status === 'unreachable') {
          console.log(`[${t.index}] ✗ ${t.typeLabel} — Qdrant 不可达，跳过 (${t.statusDetail})`);
          failedCount++;
          continue;
        }
        if (!t.collectionName || !t.absolutePath) {
          console.log(`[${t.index}] ✗ ${t.typeLabel} — 缺少集合信息，跳过`);
          failedCount++;
          continue;
        }

        const client = new QdrantClient({
          url: t.absolutePath,
          apiKey: t.qdrantApiKey,
          headers: { 'User-Agent': 'AutoDev' },
        });
        await client.deleteCollection(t.collectionName);
        console.log(`[${t.index}] ✓ ${t.typeLabel} — 已删除集合 ${t.collectionName}`);
        clearedCount++;
      } else {
        // Local caches: delete files/directories
        if (!t.absolutePath) {
          console.log(`[${t.index}] ✗ ${t.typeLabel} — 缺少路径信息，跳过`);
          failedCount++;
          continue;
        }

        if (t.type === 'summary' || t.type === 'dependency') {
          await removeDir(t.absolutePath);
        } else {
          await removeFile(t.absolutePath);
        }
        console.log(`[${t.index}] ✓ ${t.typeLabel} — 已删除 ${t.path}`);
        clearedCount++;
      }
    } catch (error) {
      console.log(`[${t.index}] ✗ ${t.typeLabel} — ${error instanceof Error ? error.message : String(error)}`);
      failedCount++;
    }
  }

  console.log(`\n清除完成: ${clearedCount} 成功, ${failedCount} 失败`);
}

// ============================================================================
// Command Handler
// ============================================================================

/**
 * Cache command handler
 */
async function cacheHandler(options: any): Promise<void> {
  const logLevel = options.logLevel || 'error';
  initGlobalLogger(logLevel);

  const filterType = options.type as string | undefined;
  const workspacePath = resolveWorkspacePath(options.path || '.', !!options.demo);
  const clearArg = options.clear as string | undefined;
  const listMode = !!options.list;
  const jsonMode = !!options.json;
  const skipConfirm = !!options.yes;

  // Determine operation mode
  const isClearMode = clearArg !== undefined;
  const isListMode = listMode || !isClearMode; // Default to list if no clear arg

  // Auto-register current workspace path (also done by index/outline/call commands)
  await registerProjectToCacheMap(workspacePath);

  // Load project map (hash → workspace path)
  const projectMap = await loadProjectMap();

  // Collect all cache entries
  const localEntries = await discoverLocalCaches(projectMap);
  const allEntries: CacheEntry[] = [...localEntries];

  // Discover Qdrant collections
  try {
    // Load config to get Qdrant URL
    const deps = createDependencies({
      path: workspacePath,
      port: 3001,
      host: 'localhost',
      logLevel,
      demo: false,
      force: false,
      json: false,
      serve: false,
      watch: false,
      dryRun: false,
      clearCache: false,
      summarize: false,
      title: false,
    });

    await deps.configProvider.loadConfig();
    const vectorStoreConfig = await deps.configProvider.getVectorStoreConfig();
    const qdrantUrl = vectorStoreConfig.qdrantUrl || 'http://localhost:6333';
    const qdrantApiKey = vectorStoreConfig.qdrantApiKey;

    const qdrantEntries = await discoverQdrantCollections(qdrantUrl, projectMap, qdrantApiKey);
    allEntries.push(...qdrantEntries);
  } catch (error) {
    getLogger().warn(`无法加载 Qdrant 配置: ${error instanceof Error ? error.message : String(error)}`);
    // Continue without Qdrant data
  }

  // Apply type filter
  let filteredEntries = allEntries;
  if (filterType && filterType !== 'all') {
    const typeMap: Record<string, CacheType> = {
      index: 'index',
      summary: 'summary',
      dependency: 'dependency',
      qdrant: 'qdrant',
    };
    const targetType = typeMap[filterType];
    if (!targetType) {
      console.error(`无效的 --type 值: ${filterType}。有效值: index, summary, dependency, qdrant, all`);
      process.exit(1);
    }
    filteredEntries = allEntries.filter((e) => e.type === targetType);
  }

  // Assign 1-based indices
  filteredEntries.forEach((entry, i) => {
    entry.index = i + 1;
  });

  // Handle --list (or default mode)
  if (isListMode) {
    if (jsonMode) {
      printJson(filteredEntries);
    } else {
      printTable(filteredEntries);
    }
    return;
  }

  // Handle --clear
  if (isClearMode) {
    if (filteredEntries.length === 0) {
      console.log('没有可清除的缓存。');
      return;
    }

    let indices: Set<number>;
    try {
      indices = parseClearIndices(clearArg, filteredEntries.length);
    } catch (error) {
      console.error(`解析 --clear 参数失败: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }

    await executeClear(filteredEntries, indices, skipConfirm);
    return;
  }
}

// ============================================================================
// Command Definition
// ============================================================================

/**
 * Create cache command
 */
export function createCacheCommand(): Command {
  const command = new Command('cache');

  command
    .description('管理缓存和向量数据（列出 / 清除）')
    .option('-l, --list', '列出所有缓存')
    .option('--clear <indices>', '按序号清除缓存（支持: 1, 1-3, 1,3-5, all）')
    .option('--type <type>', '过滤类型: index, summary, dependency, qdrant, all（默认: all）')
    .option('-p, --path <path>', '项目路径（用于加载 Qdrant 配置）', '.')
    .option('--json', 'JSON 格式输出')
    .option('-y, --yes', '跳过确认提示')
    .option('--demo', '使用 demo 工作空间')
    .option('--log-level <level>', '日志级别: debug|info|warn|error', 'error')
    .action(cacheHandler);

  return command;
}
