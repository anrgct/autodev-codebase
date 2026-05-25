# list-files API 重构设计

> **创建日期**: 2026-01-19  
> **状态**: 后续优化（待统一 Ignore 服务完成后）  
> **目标**: 改进 `listFiles` API 设计，提供结构化返回和清晰的类型定义

---

## 1. 当前 API 的问题

### 1.1 当前实现分析

```typescript
// src/glob/list-files.ts (当前实现 - 基于 ripgrep)
export async function listFiles(
  dirPath: string,
  recursive: boolean,
  limit: number,
  deps: ListFilesDependencies
): Promise<[string[], boolean]> {
  // 返回：[文件和目录混合的数组, 是否达到限制]
  const files = await listFilesWithRipgrep(...)      // 🔴 ripgrep 外部依赖
  const directories = await listFilteredDirectories(...)  // 🔴 fs.readdir
  
  return formatAndCombineResults(files, directories, limit)
}

// 注：本文档假设已完成统一 Ignore 服务重构（ripgrep → fast-glob）
// 参见：docs/plans/260119-unified-ignore-service.md
```

**关键实现细节**：

```typescript
// src/glob/list-files.ts:304-326
function formatAndCombineResults(
  files: string[], 
  directories: string[], 
  limit: number
): [string[], boolean] {
  // 合并文件和目录
  const allPaths = [...directories, ...files]
  
  // 排序：目录在前（通过 trailing slash 判断）
  uniquePaths.sort((a: string, b: string) => {
    const aIsDir = a.endsWith("/")   // 🔴 字符串 hack
    const bIsDir = b.endsWith("/")
    
    if (aIsDir && !bIsDir) return -1
    if (!aIsDir && bIsDir) return 1
    return a.localeCompare(b)
  })
  
  return [trimmedPaths, trimmedPaths.length >= limit]
}
```

### 1.2 核心问题

#### 问题 1: 类型不明确 🔴

```typescript
// 返回类型：string[]
// 问题：用户无法通过类型系统知道这是文件还是目录
const [paths, hitLimit] = await listFiles('/path', true, 100, deps)

// 必须用字符串操作判断
if (paths[0].endsWith("/")) {
  // 这是目录
} else {
  // 这是文件
}
```

**后果**：
- ❌ 不符合 TypeScript 的类型安全原则
- ❌ 容易出错（忘记检查 trailing slash）
- ❌ IDE 无法提供智能提示

#### 问题 2: 调用方需要重复过滤 🔴

```typescript
// src/code-index/processors/scanner.ts:78-79
const [allPaths, _] = await listFiles(directoryPath, true, 10000, deps)

// 🔴 scanner 只需要文件，但拿到了文件+目录
const filePaths = allPaths.filter((p) => !p.endsWith("/"))  // 浪费！
```

**后果**：
- ❌ 性能浪费（查询了不需要的目录）
- ❌ 代码重复（每个调用方都要过滤）
- ❌ 容易遗漏（忘记过滤导致 bug）

#### 问题 3: 混合返回导致限制不准确 🔴

```typescript
// 用户请求 limit = 100
const [paths, hitLimit] = await listFiles('/path', true, 100, deps)

// 实际返回：50 个目录 + 50 个文件 = 100 个条目
// 问题：如果用户只想要文件，实际只得到了 50 个文件
```

**后果**：
- ❌ `limit` 语义不清晰（限制的是总条目还是文件数？）
- ❌ 用户无法精确控制返回的文件数量

#### 问题 4: 两次查询效率低 🔴

```typescript
// 当前实现（ripgrep 时代）
const files = await listFilesWithRipgrep(...)          // 查询 1: ripgrep 子进程
const directories = await listFilteredDirectories(...) // 查询 2: fs.readdir
return formatAndCombineResults(files, directories, limit)
```

**后果**：
- ❌ 两次 I/O 操作
- ❌ 需要手动合并和去重
- ❌ 复杂度高
- ❌ ripgrep 子进程开销

**注**：统一 Ignore 服务重构后将使用 fast-glob，可一次查询完成。

---

## 2. 使用场景分析

### 2.1 当前调用方分析

| 调用方 | 位置 | 需求 | 当前问题 |
|--------|------|------|----------|
| **scanner.ts** | `src/code-index/processors/scanner.ts:75` | 只需要文件 | 拿到了目录，需要过滤 |
| **outline CLI** | `src/commands/outline.ts` | 只需要文件（用于解析） | 同上 |
| **文件浏览器（假设）** | 未来功能 | 需要文件+目录（UI 显示） | 需要区分类型 |

### 2.2 需求分类

#### 需求 A: 只要文件（最常见）
```typescript
// 用于：代码索引、依赖分析、文件解析
// 场景：scanner.ts, dependency/parse.ts
const files = await listOnlyFiles('/path', true, 1000, deps)
// 返回：['src/index.ts', 'src/utils.ts']
```

#### 需求 B: 只要目录
```typescript
// 用于：目录树显示、导航
const directories = await listOnlyDirectories('/path', false, 100, deps)
// 返回：['src/', 'tests/', 'docs/']
```

#### 需求 C: 文件和目录（都要，但分开）
```typescript
// 用于：文件浏览器、UI 组件
const result = await listFilesAndDirectories('/path', false, 100, deps)
// 返回：{ files: [...], directories: [...] }
```

---

## 3. 设计方案

### 3.1 方案 1: 结构化返回（推荐）⭐

#### 接口设计

```typescript
// src/glob/list-files.ts

/**
 * 文件列表查询结果
 */
export interface ListFilesResult {
  /** 文件路径列表（不含目录） */
  files: string[]
  
  /** 目录路径列表（不含文件） */
  directories: string[]
  
  /** 是否达到限制 */
  hitLimit: boolean
  
  /** 实际返回的总条目数 */
  totalCount: number
}

/**
 * 文件列表查询选项
 */
export interface ListFilesOptions {
  /** 是否递归遍历子目录 */
  recursive: boolean
  
  /** 最大返回条目数（0 = 无限制） */
  limit: number
  
  /** 是否包含目录（默认 true） */
  includeDirectories?: boolean
  
  /** 是否包含文件（默认 true） */
  includeFiles?: boolean
  
  /** 依赖注入 */
  deps: ListFilesDependencies
}

/**
 * 列出目录中的文件和目录
 * 
 * @param dirPath 要列出的目录路径
 * @param options 查询选项
 * @returns 结构化的查询结果
 * 
 * @example
 * // 只获取文件
 * const result = await listFiles('/path/to/dir', {
 *   recursive: true,
 *   limit: 1000,
 *   includeDirectories: false,
 *   deps
 * })
 * console.log(result.files)  // ['src/index.ts', ...]
 * 
 * @example
 * // 获取文件和目录
 * const result = await listFiles('/path/to/dir', {
 *   recursive: false,
 *   limit: 100,
 *   deps
 * })
 * console.log(result.files)        // ['file1.ts', 'file2.ts']
 * console.log(result.directories)  // ['subdir1/', 'subdir2/']
 */
export async function listFiles(
  dirPath: string,
  options: ListFilesOptions
): Promise<ListFilesResult> {
  const {
    recursive,
    limit,
    includeDirectories = true,
    includeFiles = true,
    deps
  } = options

  const ignoreService = deps.workspace.getIgnoreService()
  await ignoreService.initialize()

  const pattern = recursive ? '**/*' : '*'

  // 使用 fast-glob
  const entries = await fg(pattern, {
    cwd: dirPath,
    absolute: true,
    dot: true,
    onlyFiles: false,  // 先获取所有条目
    markDirectories: true,  // 目录以 / 结尾
    ignore: IGNORE_DIRS.map(dir => `**/${dir}/**`),
  })

  // 使用 IgnoreService 过滤
  const filtered = ignoreService.filterFiles(entries)

  // 分离文件和目录
  const files = filtered.filter(p => !p.endsWith("/"))
  const directories = filtered.filter(p => p.endsWith("/"))

  // 应用过滤选项
  let resultFiles = includeFiles ? files : []
  let resultDirs = includeDirectories ? directories : []

  // 应用限制
  const totalCount = resultFiles.length + resultDirs.length
  const hitLimit = totalCount > limit && limit > 0

  if (limit > 0) {
    // 按比例分配限制（保持文件和目录的比例）
    const totalBeforeLimit = resultFiles.length + resultDirs.length
    const fileRatio = resultFiles.length / totalBeforeLimit
    const fileLimit = Math.ceil(limit * fileRatio)
    const dirLimit = limit - fileLimit

    resultFiles = resultFiles.slice(0, fileLimit)
    resultDirs = resultDirs.slice(0, dirLimit)
  }

  return {
    files: resultFiles,
    directories: resultDirs,
    hitLimit,
    totalCount: resultFiles.length + resultDirs.length
  }
}
```

#### 向后兼容的包装器

```typescript
/**
 * 兼容旧 API 的包装器
 * @deprecated 请使用新的结构化 API
 */
export async function listFilesLegacy(
  dirPath: string,
  recursive: boolean,
  limit: number,
  deps: ListFilesDependencies
): Promise<[string[], boolean]> {
  const result = await listFiles(dirPath, {
    recursive,
    limit,
    includeDirectories: true,
    includeFiles: true,
    deps
  })

  // 合并并排序（目录在前）
  const allPaths = [
    ...result.directories,
    ...result.files
  ]

  return [allPaths, result.hitLimit]
}
```

#### 便捷方法

```typescript
/**
 * 只列出文件（不含目录）
 * 适用于代码索引、文件解析等场景
 */
export async function listOnlyFiles(
  dirPath: string,
  recursive: boolean,
  limit: number,
  deps: ListFilesDependencies
): Promise<[string[], boolean]> {
  const result = await listFiles(dirPath, {
    recursive,
    limit,
    includeDirectories: false,
    includeFiles: true,
    deps
  })

  return [result.files, result.hitLimit]
}

/**
 * 只列出目录（不含文件）
 * 适用于目录树导航等场景
 */
export async function listOnlyDirectories(
  dirPath: string,
  recursive: boolean,
  limit: number,
  deps: ListFilesDependencies
): Promise<[string[], boolean]> {
  const result = await listFiles(dirPath, {
    recursive,
    limit,
    includeDirectories: true,
    includeFiles: false,
    deps
  })

  return [result.directories, result.hitLimit]
}
```

#### 调用方改造示例

**Before (scanner.ts - 基于 ripgrep)**:
```typescript
const [allPaths, _] = await listFiles(directoryPath, true, 10000, {
  pathUtils: this.deps.pathUtils,
  ripgrepPath: 'rg'  // 🔴 需要 ripgrep
})

// 🔴 需要手动过滤
const filePaths = allPaths.filter((p) => !p.endsWith("/"))
```

**After (scanner.ts - 基于 fast-glob)**:
```typescript
// 方式 1: 使用便捷方法
const [files, _] = await listOnlyFiles(directoryPath, true, 10000, {
  pathUtils: this.deps.pathUtils,
  workspace: this.deps.workspace,  // ✅ 通过 workspace 获取 ignoreService
  fileSystem: this.deps.fileSystem
})

// 方式 2: 使用结构化 API
const result = await listFiles(directoryPath, {
  recursive: true,
  limit: 10000,
  includeDirectories: false,  // 🔥 明确声明只要文件
  deps: {
    pathUtils: this.deps.pathUtils,
    workspace: this.deps.workspace,
    fileSystem: this.deps.fileSystem
  }
})

const files = result.files  // ✅ 类型安全，无需过滤
```

---

### 3.2 方案 2: 参数控制（简化版）

```typescript
/**
 * 简化的选项接口
 */
export interface SimpleListFilesOptions {
  recursive: boolean
  limit: number
  onlyFiles?: boolean      // true = 只返回文件
  onlyDirectories?: boolean // true = 只返回目录
  deps: ListFilesDependencies
}

export async function listFiles(
  dirPath: string,
  options: SimpleListFilesOptions
): Promise<[string[], boolean]> {
  // ... 实现
}
```

**优点**：
- ✅ API 变化最小
- ✅ 向后兼容容易

**缺点**：
- ❌ 仍然是扁平的字符串数组
- ❌ 类型不够明确

---

## 4. 实施计划

### 4.1 阶段划分

#### Phase 1: 统一 Ignore 服务（当前重构）

**范围**：
- 创建 `IgnoreService`
- 替换 ripgrep → fast-glob
- **保持当前 API 不变**（`listFilesLegacy`）

**原因**：
- 一次只做一件事
- 降低风险
- 方便回滚

**参考文档**：`docs/plans/260119-unified-ignore-service.md`

#### Phase 2: API 重构（本文档）

**前置条件**：
- ✅ 统一 Ignore 服务已完成
- ✅ 所有测试通过
- ✅ 性能验证通过

**实施步骤**：

1. **新增结构化 API**（不破坏旧 API）
   ```typescript
   // 新增
   export async function listFiles(
     dirPath: string,
     options: ListFilesOptions
   ): Promise<ListFilesResult>
   
   // 旧 API 重命名
   export async function listFilesLegacy(...): Promise<[string[], boolean]>
   ```

2. **添加便捷方法**
   ```typescript
   export async function listOnlyFiles(...)
   export async function listOnlyDirectories(...)
   ```

3. **迁移调用方**
   - `scanner.ts` → 使用 `listOnlyFiles`
   - 其他调用方逐步迁移

4. **标记旧 API 为 deprecated**
   ```typescript
   /**
    * @deprecated Use listFiles with options instead
    */
   export async function listFilesLegacy(...)
   ```

5. **移除旧 API**（下一个大版本）

### 4.2 迁移策略

#### 兼容期（保留两个 API）

```typescript
// 旧 API（兼容）
export async function listFilesLegacy(
  dirPath: string,
  recursive: boolean,
  limit: number,
  deps: ListFilesDependencies
): Promise<[string[], boolean]>

// 新 API
export async function listFiles(
  dirPath: string,
  options: ListFilesOptions
): Promise<ListFilesResult>

// 便捷方法
export async function listOnlyFiles(...)
export async function listOnlyDirectories(...)
```

#### 迁移检查清单

- [ ] 所有调用方识别完成
- [ ] 新 API 单元测试覆盖 100%
- [ ] 性能对比测试通过
- [ ] 文档更新完成
- [ ] 示例代码更新

---

## 5. 优势对比

### 5.1 类型安全

**Before**:
```typescript
const [paths, _] = await listFiles(...)
// ❌ 类型：string[]
// ❌ 运行时才知道是文件还是目录
if (paths[0].endsWith("/")) { ... }
```

**After**:
```typescript
const result = await listFiles(...)
// ✅ 类型：ListFilesResult
result.files        // ✅ string[] - 明确是文件
result.directories  // ✅ string[] - 明确是目录
```

### 5.2 性能优化

**Before (基于 ripgrep)**:
```typescript
// scanner.ts 只需要文件
const [allPaths, _] = await listFiles(...)  // ripgrep 查询了文件+目录
const files = allPaths.filter(p => !p.endsWith("/"))  // 浪费
```

**After (基于 fast-glob)**:
```typescript
const [files, _] = await listOnlyFiles(...)  // fast-glob 只查询文件
// ✅ 不查询目录（使用 onlyFiles: true）
// ✅ 不需要过滤
// ✅ 更快
```

### 5.3 代码简洁性

**Before (基于 ripgrep)**:
```typescript
const [allPaths, _] = await listFiles(directoryPath, true, 10000, {
  pathUtils: this.deps.pathUtils,
  ripgrepPath: 'rg'  // 🔴 需要提供 ripgrep 路径
})
const filePaths = allPaths.filter((p) => !p.endsWith("/"))  // 🔴 重复代码
```

**After (基于 fast-glob)**:
```typescript
const [files, _] = await listOnlyFiles(directoryPath, true, 10000, deps)
// ✅ 一行搞定，无需 ripgrep
```

### 5.4 可维护性

**Before**:
```typescript
// 多个地方都有这样的代码
const files = allPaths.filter(p => !p.endsWith("/"))
// ❌ 容易忘记
// ❌ 难以重构
```

**After**:
```typescript
// 逻辑集中在 listFiles 内部
// ✅ 统一修改
// ✅ 类型保证
```

---

## 6. 测试计划

### 6.1 单元测试

```typescript
// src/glob/__tests__/list-files.test.ts
describe('listFiles (new API)', () => {
  describe('结构化返回', () => {
    it('should return separated files and directories', async () => {
      const result = await listFiles('/path', {
        recursive: false,
        limit: 100,
        deps
      })

      expect(result.files).toEqual(['file1.ts', 'file2.ts'])
      expect(result.directories).toEqual(['subdir1/', 'subdir2/'])
      expect(result.totalCount).toBe(4)
    })
  })

  describe('只返回文件', () => {
    it('should only return files when includeDirectories = false', async () => {
      const result = await listFiles('/path', {
        recursive: true,
        limit: 100,
        includeDirectories: false,
        deps
      })

      expect(result.files.length).toBeGreaterThan(0)
      expect(result.directories).toEqual([])
    })
  })

  describe('只返回目录', () => {
    it('should only return directories when includeFiles = false', async () => {
      const result = await listFiles('/path', {
        recursive: true,
        limit: 100,
        includeFiles: false,
        deps
      })

      expect(result.files).toEqual([])
      expect(result.directories.length).toBeGreaterThan(0)
    })
  })

  describe('限制逻辑', () => {
    it('should respect limit correctly', async () => {
      const result = await listFiles('/path', {
        recursive: true,
        limit: 10,
        deps
      })

      expect(result.totalCount).toBeLessThanOrEqual(10)
      expect(result.hitLimit).toBe(true)
    })
  })
})

describe('listOnlyFiles', () => {
  it('should only return files', async () => {
    const [files, _] = await listOnlyFiles('/path', true, 100, deps)
    
    files.forEach(file => {
      expect(file.endsWith("/")).toBe(false)
    })
  })
})

describe('listOnlyDirectories', () => {
  it('should only return directories', async () => {
    const [dirs, _] = await listOnlyDirectories('/path', false, 100, deps)
    
    dirs.forEach(dir => {
      expect(dir.endsWith("/")).toBe(true)
    })
  })
})
```

### 6.2 迁移测试

```typescript
describe('API 兼容性', () => {
  it('listFilesLegacy should behave identically to old implementation', async () => {
    const [paths1, hit1] = await listFilesLegacy('/path', true, 100, deps)
    const [paths2, hit2] = await listFilesOld('/path', true, 100, deps)

    expect(paths1).toEqual(paths2)
    expect(hit1).toBe(hit2)
  })
})
```

---

## 7. 性能考虑

### 7.1 查询优化

**Before (两次查询 - ripgrep 时代)**:
```typescript
const files = await listFilesWithRipgrep(...)       // I/O 1: ripgrep
const directories = await listFilteredDirectories(...)  // I/O 2: fs.readdir
```

**After (一次查询 - fast-glob)**:
```typescript
const entries = await fg('**/*', {
  onlyFiles: false,  // 一次性获取所有
  markDirectories: true
})

// 内存中分离（无额外 I/O）
const files = entries.filter(p => !p.endsWith("/"))
const directories = entries.filter(p => p.endsWith("/"))
```

**性能提升**：
- ✅ 减少 I/O 次数（2 → 1）
- ✅ 利用 fast-glob 的缓存

### 7.2 按需查询

```typescript
// 只需要文件时，直接用 onlyFiles: true
const entries = await fg('**/*', {
  onlyFiles: options.includeFiles && !options.includeDirectories,
  // ✅ 不查询目录，更快
})
```

---

## 8. 文档更新

### 8.1 API 文档

```typescript
/**
 * 列出目录中的文件和/或目录
 * 
 * @param dirPath 要列出的目录路径（绝对路径）
 * @param options 查询选项
 * @returns 结构化的查询结果，包含分离的文件和目录列表
 * 
 * @example
 * // 获取所有文件和目录
 * const result = await listFiles('/path/to/dir', {
 *   recursive: true,
 *   limit: 1000,
 *   deps
 * })
 * console.log(`Found ${result.files.length} files`)
 * console.log(`Found ${result.directories.length} directories`)
 * 
 * @example
 * // 只获取文件（用于代码索引）
 * const result = await listFiles('/path/to/dir', {
 *   recursive: true,
 *   limit: 1000,
 *   includeDirectories: false,
 *   deps
 * })
 * console.log(result.files)  // 不含目录
 * 
 * @example
 * // 使用便捷方法
 * const [files, hitLimit] = await listOnlyFiles('/path', true, 1000, deps)
 */
```

### 8.2 迁移指南

```markdown
# 迁移指南：listFiles API

## 旧 API → 新 API

### 场景 1: 只需要文件

**Before**:
```typescript
const [allPaths, _] = await listFiles(dir, true, 1000, deps)
const files = allPaths.filter(p => !p.endsWith("/"))
```

**After**:
```typescript
const [files, _] = await listOnlyFiles(dir, true, 1000, deps)
```

### 场景 2: 需要文件和目录（分开）

**Before**:
```typescript
const [allPaths, _] = await listFiles(dir, false, 100, deps)
const files = allPaths.filter(p => !p.endsWith("/"))
const dirs = allPaths.filter(p => p.endsWith("/"))
```

**After**:
```typescript
const result = await listFiles(dir, {
  recursive: false,
  limit: 100,
  deps
})
const files = result.files
const dirs = result.directories
```
```

---

## 9. 风险评估

### 9.1 潜在风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 破坏现有功能 | 低 | 高 | 保留旧 API，充分测试 |
| 调用方迁移成本 | 中 | 中 | 提供便捷方法和自动化工具 |
| 性能回归 | 低 | 中 | 性能基准测试 |

### 9.2 回滚计划

1. **保留旧 API** - 不删除 `listFilesLegacy`
2. **Feature flag** - 可选择使用新/旧实现
3. **逐步迁移** - 一个调用方一个调用方地迁移

---

## 10. 验收标准

### 10.1 功能验收

- [ ] 新 API 通过所有单元测试
- [ ] 旧 API 兼容性测试通过
- [ ] 所有调用方成功迁移
- [ ] 文档更新完成

### 10.2 性能验收

- [ ] 查询速度不低于旧实现
- [ ] `listOnlyFiles` 比旧方案快（减少了目录查询）
- [ ] 内存使用无明显增加

### 10.3 代码质量验收

- [ ] 类型检查通过
- [ ] ESLint 无警告
- [ ] 代码覆盖率 > 90%

---

## 11. 总结

### 11.1 核心改进

1. **类型安全** - 明确区分文件和目录
2. **性能优化** - 按需查询，减少不必要的 I/O
3. **代码简洁** - 消除重复的过滤逻辑
4. **可维护性** - 统一的接口，便于扩展

### 11.2 实施建议

1. **优先级**: 在统一 Ignore 服务完成后实施（先完成 ripgrep → fast-glob 迁移）
2. **渐进迁移**: 保留旧 API，逐步迁移调用方
3. **充分测试**: 确保兼容性和性能
4. **文档优先**: 提供清晰的迁移指南

### 11.3 前置依赖

**必须先完成**：
- ✅ 统一 Ignore 服务（`docs/plans/260119-unified-ignore-service.md`）
- ✅ ripgrep → fast-glob 迁移
- ✅ 所有现有测试通过

**原因**：本文档假设 `listFiles` 已基于 fast-glob 实现。

### 11.4 长期价值

- ✅ 更好的开发体验（类型安全 + IDE 支持）
- ✅ 更高的性能（按需查询）
- ✅ 更易维护（统一接口）
- ✅ 更少的 bug（消除字符串 hack）

---

**文档修订历史**：
- 2026-01-19: 初始版本，基于当前 API 分析和使用场景调研
