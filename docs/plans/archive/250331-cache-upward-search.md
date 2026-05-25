# 250331-cache-upward-search

## 主题/需求

分析项目中是否存在向上级目录搜索父目录（项目根目录）的逻辑，并评估是否需要在代码索引系统中的其他地方也加上类似机制。

### 触发场景

用户在子目录（如 `/project/src/subdir`）执行 `codebase index` 时，缓存系统无法自动找到真实的项目根目录：
- 索引缓存以子目录路径作为哈希标识 → 缓存 miss，重复索引
- 项目配置文件（`autodev-config.json`）在根目录时，子目录下运行的命令不会自动向上搜索找到它（全局配置 `~/.autodev-cache/autodev-config.json` 仍会生效，但项目级配置丢失）
- 行为与依赖分析模块不一致（依赖分析已用 `findGitRoot` 自动向上搜索）

## 代码背景

### 相关文件

| 文件 | 角色 |
|------|------|
| `src/dependency/index.ts#L85-98` | `findGitRoot()` 函数 — 唯一定义的向上级目录搜索逻辑 |
| `src/dependency/index.ts#L130-152` | `analyze()` 函数 — 使用 `findGitRoot` 确定 repoPath |
| `src/commands/shared.ts#L65-72` | `resolveWorkspacePath()` — 只做路径规范化，不向上搜索 |
| `src/adapters/nodejs/config.ts#L29-42` | `NodeConfigProvider` 构造 — `configPath` 默认 `./autodev-config.json` |
| `src/adapters/nodejs/config.ts#L143-184` | `loadConfig()` — 只读固定路径，不存在就跳过 |
| `src/commands/shared.ts#L77-96` | `createDependencies()` — 将 `options.path` 直接作为 workspacePath |
| `src/code-index/manager.ts#L42-56` | `CodeIndexManager.getInstance()` — workspacePath 来自外部传入 |
| `src/code-index/cache-manager.ts` | `CacheManager` — 用 workspacePath 哈希做缓存标识 |
| `src/cli-tools/summary-cache.ts#L194-223` | `getCachePathForSourceFile()` — 有 `..` 路径穿越防护 |
| `src/commands/call.ts#L419-438` | `callHandler()` — 唯一在代码索引命令之外使用 `findGitRoot` 的地方 |

### `findGitRoot` 当前实现

```typescript
export async function findGitRoot(startPath: string, fileSystem: IFileSystem): Promise<string | null> {
  let currentPath = startPath
  const root = path.parse(currentPath).root
  while (currentPath !== root) {
    const gitPath = path.join(currentPath, '.git')
    if (await fileSystem.exists(gitPath)) {
      return currentPath
    }
    currentPath = path.dirname(currentPath)
  }
  return null
}
```

从起始路径开始，逐级向上检查 `.git` 目录，直到根目录 `/`。

### 当前使用情况

| 模块 | 是否使用 `findGitRoot` | 效果 |
|------|:---------------------:|------|
| `dependency/analyze()` | ✅ | Git 根目录共享缓存 |
| `commands/call.ts` (clear-cache) | ✅ | 同上 |
| `NodeConfigProvider.loadConfig()` | ❌ | 只读固定路径，不向上找 |
| `resolveWorkspacePath()` | ❌ | 只做路径转换 |
| `CodeIndexManager` | ❌ | workspacePath 直接做哈希 |
| `SummaryCacheManager` | ❌ | 有 `..` 防护，不向上搜索 |

## 关键决策



## 实施计划



## 实施记录

### 2025-03-31

**分析阶段：**
- 审查了所有缓存系统（代码索引缓存、摘要缓存、依赖分析缓存）
- 发现 `findGitRoot` 是唯一向上搜索的实现，位于 `src/dependency/index.ts#L85-98`
- 发现 `NodeConfigProvider.loadConfig()` 在项目配置文件不存在时直接跳过，不会向上搜索
- 发现 `commands/call.ts` 是唯一在代码索引命令之外使用 `findGitRoot` 的地方（用于 `--clear-cache`）
- 创建了本 task doc

## 修订记录

### 2025-03-31
**问题：** 初始分析——向上级目录搜索逻辑在项目中是否存在
**发现：** `findGitRoot` 函数存在于 `src/dependency/index.ts#L85-98`，但仅用于依赖分析和 `call` 命令，代码索引系统未使用

## 总结

### 关键收获

1. **项目中只有一个向上搜索实现** — `findGitRoot`，逐级向上找 `.git` 目录
2. **代码索引系统未使用** — 在子目录运行时，缓存不会自动对齐到项目根目录
3. **配置加载最值得加** — 改动小、收益明显、符合用户直觉
4. **建议抽取公共函数** — 避免依赖分析模块暴露不属于它职责范围的工具函数

### 后续优化

- 完成阶段 1-2 的实施后，可考虑在 `createDependencies()` 中做类似优化
- 未来如果 monorepo 场景需求增加，可支持通过 `lerna.json`、`pnpm-workspace.yaml` 等标记文件定位根目录
