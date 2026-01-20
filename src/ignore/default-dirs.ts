/**
 * 统一的代码库忽略配置
 * 所有模块共享此配置，确保 ignore 行为一致
 */

// === 统一的目录忽略列表 ===
// 适用于所有模块：list-files, workspace, dependency
export const IGNORE_DIRS = [
  // 版本控制
  '.git', '.svn', '.hg',

  // 依赖目录
  'node_modules', 'vendor', 'deps', 'pkg', 'Pods',

  // 构建输出
  'dist', 'build', 'out', 'bundle', 'coverage',

  // 缓存目录
  '.cache', '.nyc_output', '.autodev-cache', '.pytest_cache',

  // 运行时/临时
  '__pycache__', 'env', 'venv', 'tmp', 'temp',
] as const

// Type alias for use with string includes checks
export type IgnoreDir = typeof IGNORE_DIRS[number]

// === ripgrep 专用隐藏目录通配符 ===
// 用于 list-files.ts，忽略所有隐藏文件/目录
export const HIDDEN_DIR_PATTERN = '.*'
