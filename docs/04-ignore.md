# Ignore 流程 Wiki

## 概述

本文档描述 `autodev-codebase` 项目中文件忽略（ignore）机制的完整流程。该机制用于在代码索引、搜索和分析过程中过滤掉不需要处理的文件和目录。

## 核心组件

### 1. IgnoreService - 统一忽略服务

**文件**: `src/ignore/IgnoreService.ts:21-190`

`IgnoreService` 是整个 ignore 系统的核心，提供基于标准 gitignore 语义的文件过滤功能。

**主要功能**:
- 加载 `.gitignore`、`.rooignore`、`.codebaseignore` 文件
- 支持默认目录忽略列表
- 提供目录级别和文件级别的过滤

**核心方法**:

| 方法 | 行号 | 功能 |
|------|------|------|
| `IgnoreService.initialize()` | L39-60 | 初始化服务，加载所有 ignore 规则 (IgnoreService.initialize:39-60) |
| `shouldSkipDirectory()` | L87-109 | 检查目录是否应该被完全跳过（剪枝） (IgnoreService.shouldSkipDirectory:87-109) |
| `shouldIgnore()` | L118-130 | 检查文件是否应该被忽略 (IgnoreService.shouldIgnore:118-130) |
| `filterFiles()` | L136-138 | 批量过滤文件列表 (IgnoreService.filterFiles:136-138) |
| `loadIgnoreFile()` | L62-73 | 加载并解析单个 ignore 文件 (IgnoreService.loadIgnoreFile:62-73) |

### 2. 默认忽略目录配置

**文件**: `src/ignore/default-dirs.ts`

```typescript
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
```

### 3. 文件列表服务

**文件**: `src/glob/list-files.ts:53-99` (listFiles:53-99)

`listFiles` 函数使用 `fast-glob` 进行高效的文件枚举，并结合 `IgnoreService` 进行精确过滤。

## 两层过滤策略

系统采用**两层过滤策略**来平衡性能和正确性：

```text-chart
[两层过滤策略] (性能与正确性平衡的设计)
第一层：快速剪枝 (fast-glob)
├── 规则来源: IGNORE_DIRS
├── 实现: fast-glob 的 ignore 参数
├── 作用: 跳过大目录（不进入）
└── 特点: 快速，但只支持 glob 语义
    ↓
第二层：精确过滤 (IgnoreService)
├── 规则来源: .gitignore / .rooignore / .codebaseignore
├── 实现: ignore 库
├── 作用: 精确过滤文件
└── 特点: 完整 gitignore 语义，但在枚举后执行
```

**为什么需要两层？**
- ❌ **只用第一层**：无法处理 `.gitignore` 的复杂规则（否定模式、路径模式等）
- ❌ **只用第二层**：会先枚举所有文件再过滤，对大目录（如 node_modules）性能差
- ✅ **两层结合**：先剪枝跳过大目录，再精确过滤处理复杂规则

## 初始化流程

```text-chart
[IgnoreService 初始化流程] (加载所有 ignore 规则的过程)
IgnoreService.initialize:40
  ↓
检查 loaded 标志（避免重复初始化）
  ↓
添加默认目录规则:45
├── 将 IGNORE_DIRS 转换为目录模式（添加 trailing slash）
└── 例如: 'node_modules' → 'node_modules/'
  ↓
加载 ignore 文件:49
├── 默认: ['.gitignore', '.rooignore', '.codebaseignore']
├── 遍历每个文件
└── 调用 loadIgnoreFile:62
    ├── 拼接完整路径
    ├── 检查文件是否存在
    ├── 读取文件内容
    ├── 解析规则（去除注释和空行）
    └── 添加到 ignore 库
  ↓
添加额外规则:56
└── 添加 options.additionalRules 中的自定义规则
  ↓
设置 loaded = true
```

## 使用场景流程

### 场景 1: 代码索引扫描

```text-chart
[代码索引扫描流程] (DirectoryScanner 中的 ignore 应用)
DirectoryScanner.scanDirectory:119
  ↓
调用 filterSupportedFiles:73
  ↓
listFiles:53（第一层过滤）
├── 使用 fast-glob 枚举文件
├── 应用 DIRS_TO_IGNORE 快速剪枝
│   └── 跳过 node_modules、.git 等大目录
└── 返回文件列表
  ↓
ignoreService.filterFiles（第二层过滤）
├── 应用 .gitignore 规则
├── 应用 .rooignore 规则
└── 应用 .codebaseignore 规则
  ↓
workspace.shouldIgnore:75-78
└── 最终文件级别过滤
  ↓
按扩展名过滤:98-105 (DirectoryScanner.filterSupportedFiles:73-109)
└── 只保留支持的语言文件
```

### 场景 2: 依赖分析遍历

```text-chart
[依赖分析遍历流程] (dependency/parse.ts 中的 ignore 应用)
parse.walkFiles:225
  ↓
确保 ignoreService 已初始化
  ↓
递归遍历目录
  ↓
遇到目录时
└── shouldSkipDirectory:87（目录剪枝）
    ├── 快速路径: 检查 basename 是否在 IGNORE_DIRS
    └── 完整检查: 应用 gitignore 规则
  ↓
遇到文件时
└── shouldIgnore:118（文件过滤）
    ├── 转换为相对路径
    ├── 标准化路径分隔符
    └── 应用 ignore 规则
  ↓
额外过滤
├── 文件大小检查
├── 测试文件检查（.test. / .spec.）
└── 扩展名支持检查
```

### 场景 3: 大纲提取

```text-chart
[大纲提取流程] (outline 命令中的 ignore 应用)
outline-targets.resolveOutlineTargets:45
  ↓
解析用户输入的 glob 模式
  ↓
对每个匹配的文件
└── shouldIgnore 检查
    └── 跳过被忽略的文件
  ↓
outline.extractOutline:94
  ↓
解析文件生成大纲
```

## 调用关系图

```text-chart
[Ignore 系统调用关系] (核心组件间的调用关系)
IgnoreService
├── IgnoreService.initialize:40
│   ├── loadIgnoreFile:62
│   └── ignore.add()
├── shouldSkipDirectory:87
│   ├── IGNORE_DIRS.includes()（快速路径）
│   └── ig.ignores()（完整检查）
├── shouldIgnore:118
│   └── ig.ignores()
├── filterFiles:136
│   └── shouldIgnore
└── filterDirectories:143
    └── shouldSkipDirectory

调用方（使用者）
├── list-files.listFiles:53
│   ├── fast-glob（第一层过滤）
│   └── ignoreService.filterFiles（第二层）
├── scanner.DirectoryScanner:41
│   └── workspace.shouldIgnore
├── workspace.NodeWorkspace:16
│   ├── getIgnoreService()
│   ├── shouldIgnore() (NodeWorkspace.shouldIgnore:75-78)
│   └── getGlobIgnorePatterns() (NodeWorkspace.getGlobIgnorePatterns:54)
├── parse.walkFiles:225
│   ├── shouldSkipDirectory (IgnoreService.shouldSkipDirectory:87-109)
│   └── shouldIgnore (IgnoreService.shouldIgnore:118-130)
├── tree-sitter/index.parseSourceCodeDefinitionsForFile:104 (parseSourceCodeDefinitionsForFile:104)
│   └── shouldIgnore
└── cli-tools/outline-targets.resolveOutlineTargets:45 (outline-targets.resolveOutlineTargets:45-118)
    └── shouldIgnore
```

## 配置与扩展

### 默认配置

```typescript
// NodeWorkspace 构造函数中的默认配置
this.ignoreService = new IgnoreService(fileSystem, this.pathUtils, {
  rootPath: options.rootPath,
  ignoreFiles: options.ignoreFiles || ['.gitignore', '.rooignore', '.codebaseignore'],
})
```

### 自定义规则

可以通过 `additionalRules` 选项添加额外的 ignore 规则：

```typescript
const ignoreService = new IgnoreService(fileSystem, pathUtils, {
  rootPath: '/project',
  ignoreFiles: ['.gitignore'],
  additionalRules: ['*.log', 'temp/', 'custom-ignore-pattern']
})
```

## 性能优化

### 1. 目录剪枝优化

`shouldSkipDirectory` 方法实现了快速路径：

```typescript
shouldSkipDirectory(dirPath: string): boolean {
  const basename = this.pathUtils.basename(dirPath)
  
  // 快速路径：检查常见大目录
  if (IGNORE_DIRS.includes(basename as any)) {
    return true  // 直接跳过，避免调用 ignore 库
  }
  
  // 完整检查：gitignore 规则
  // ...
}
```

### 2. 批量过滤

提供批量过滤方法减少重复计算：

```typescript
filterFiles(files: string[]): string[] {
  return files.filter(f => !this.shouldIgnore(f))
}
```

### 3. 初始化缓存保护

`loaded` 标志确保初始化只执行一次：

```typescript
async initialize(): Promise<void> { (IgnoreService.initialize:40-60) {
  if (this.loaded) return  // ⚡ 避免重复初始化
  // ...
  this.loaded = true
}
```

## 相关文件

| 文件路径 | 行数 | 功能描述 |
|----------|------|----------|
| `src/ignore/IgnoreService.ts` | 191 | 统一忽略服务核心实现 |
| `src/ignore/default-dirs.ts` | 31 | 默认忽略目录配置 |
| `src/glob/list-files.ts` | 123 | 文件列表服务（两层过滤） |
| `src/adapters/nodejs/workspace.ts` | 193 | NodeWorkspace 适配器 |
| `src/code-index/processors/scanner.ts` | 458 | 目录扫描器 |
| `src/dependency/parse.ts` | 399 | 依赖分析解析器 |
| `src/utils/git-global-ignore.ts` | 221 | Git 全局忽略文件管理 |

## 注意事项

1. **路径标准化**: `ignore` 库要求使用 forward slash，所有路径在检查前都会进行标准化处理
2. **相对路径**: `shouldIgnore` 和 `shouldSkipDirectory` 支持绝对路径和相对路径两种输入
3. **根目录保护**: 根目录（`.` 或空路径）不会被跳过
4. **初始化顺序**: 使用 `IgnoreService` 前必须先调用 `initialize()`
