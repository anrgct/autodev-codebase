# Codebase Outline 主流程

## 概述

`codebase outline` 是一个基于 Tree-sitter 的代码结构提取工具，支持从源代码文件中提取函数、类、方法等定义信息，并可选择生成 AI 摘要。

## 主流程图

```text-chart
[Outline 主流程] (从 CLI 入口到代码结构提取的完整流程)
cli.main:16
↓
commands/outline.createOutlineCommand:174
↓
commands/outline.outlineHandler:111
↓
commands/outline.handleOutline:11
├── 解析目标 → cli-tools/resolveOutlineTargets:45
│   ├── 单文件模式
│   └── Glob 模式 → fast-glob 匹配
↓
cli-tools/extractOutline:94
↓
buildOutlineDefinitions:290
├── Markdown 文件 → parseMarkdown
└── 代码文件
    ├── loadRequiredLanguageParsers → 加载 Tree-sitter 解析器
    ├── parser.parse → 生成 AST
    └── query.captures → 提取定义节点
↓
extractDefinitionsFromCaptures:345
↓
输出渲染
├── Text 格式 → renderDefinitionsAsText:469
└── JSON 格式 → renderDefinitionsAsJson:516
```

## 详细流程说明

### 1. CLI 入口 (cli.ts:16-34) (cli.main:16-34)

```typescript
async function main(): Promise<void> {
  const program = new Command();
  program
    .name('codebase')
    .description('@autodev/codebase - Vector-based code search and indexing tool')
    .version('1.0.0');

  // 注册子命令
  program.addCommand(createSearchCommand());
  program.addCommand(createIndexCommand());
  program.addCommand(createOutlineCommand());  // ← Outline 命令
  // ...
}
```

**职责**：初始化 Commander.js，注册 outline 子命令。

### 2. 命令定义 (commands/outline.ts:174-194) (outline.createOutlineCommand:174-194)

```typescript
export function createOutlineCommand(): Command {
  const command = new Command('outline');
  command
    .description('Extract code outline from file(s)')
    .argument('<pattern>', 'File path or glob pattern')
    .option('--summarize', 'Generate AI summaries')
    .option('--title', 'Show only file-level summary')
    .option('--json', 'Output in JSON format')
    .option('--dry-run', 'Preview matched files')
    .action(outlineHandler);
  return command;
}
```

**支持的选项**：
| 选项 | 说明 |
|------|------|
| `--summarize` | 生成 AI 函数摘要 |
| `--title` | 仅显示文件级摘要 |
| `--json` | JSON 格式输出 |
| `--dry-run` | 预览匹配的文件 |
| `--clear-cache` | 清除摘要缓存 |

### 3. 目标解析 (cli-tools/outline-targets.ts:45-118) (cli-tools.resolveOutlineTargets:45-118)

```text-chart
[目标解析流程] (将用户输入解析为文件列表)
resolveOutlineTargets
├── 非 Glob 模式（单文件/目录）
│   ├── 目录 → 转换为 "dir/*" Glob
│   └── 单文件 → 直接返回
└── Glob 模式
    ├── 解析包含/排除模式（逗号分隔）
    ├── fast-glob 匹配文件
    └── workspace.shouldIgnore 过滤
```

**关键逻辑**：
- 检测 Glob 模式：`[*?{}[]]` 字符
- 支持逗号分隔的多模式：`"src/**/*.ts,!**/*.test.ts"`
- 双层过滤：fast-glob ignore + workspace ignore 规则

### 4. 大纲提取核心 (cli-tools/outline.ts:94-135) (cli-tools.extractOutline:94-135)

```typescript
export async function extractOutline(options: OutlineOptions): Promise<string> {
  // 1. 解析目标路径
  // 2. 检查文件存在性
  // 3. 检查 ignore 规则
  // 4. 根据格式选择输出方式
  if (json) {
    return await getOutlineAsJson(...);
  } else {
    return await getOutlineAsText(...);
  }
}
```

### 5. 构建定义数据 (cli-tools/outline.ts:290-340) (cli-tools.buildOutlineDefinitions:290-340)

**单一真相源（Single Source of Truth）**：`buildOutlineDefinitions` 为 Text 和 JSON 两种输出格式提供统一的数据源。

```text-chart
[构建定义数据]
outline.buildOutlineDefinitions:290
├── 读取文件内容
├── 判断文件类型
│   ├── Markdown → parseMarkdown
│   └── 代码文件
│       ├── loadRequiredLanguageParsers:加载语言解析器
│       ├── parser.parse(fileContent):生成 AST
│       ├── query.captures(tree.rootNode):查询定义节点
│       └── extractDefinitionsFromCaptures:提取结构化定义
└── 返回 OutlineData
```

### 6. Tree-sitter 解析 (tree-sitter/index.ts) (tree-sitter.parseSourceCodeDefinitionsForFile:104-157)

```text-chart
[Tree-sitter 解析流程]
languageParser.loadRequiredLanguageParsers:99
↓
parser.parse(fileContent) → 生成 AST
↓
query.captures(rootNode) → 捕获定义节点
↓
extractDefinitionsFromCaptures:345
├── 排序捕获节点（按行号）
├── 过滤 definition.* 捕获
├── 映射 name.* 捕获到定义
├── 过滤小组件（< MIN_COMPONENT_LINES）
└── 构建 OutlineDefinition 数组
```

**支持的捕获名称**：
- `definition.function` - 函数定义
- `definition.class` - 类定义
- `definition.method` - 方法定义
- `definition.interface` - 接口定义
- `name.definition.*` - 定义名称

### 7. AI 摘要生成（可选）

```text-chart
[摘要生成流程] (--summarize 启用时)
cli-tools.createSummarizerForOutline:569-613
↓
cli-tools.applySummaryCache:811-951
├── 检查缓存（按文件内容哈希）
├── 缓存命中 → 使用缓存摘要
└── 缓存未命中
    └── cli-tools.generateSummariesWithRetry:656-809
        ├── 批量请求 LLM
        ├── 重试机制（最多 3 次）
        └── 保存到缓存
```

### 8. 输出渲染

**Text 格式** (cli-tools.renderDefinitionsAsText:469-511)：
```
# src/example.ts (150 lines)
└─ 文件功能摘要

   10--25 | function helper
   30--50 | class MyClass
   └─ 类功能摘要
   52--70 | method doSomething
   └─ 方法功能摘要
```

**JSON 格式** (cli-tools.renderDefinitionsAsJson:516-539)：
```json
{
  "filePath": "/path/to/file.ts",
  "relativePath": "src/example.ts",
  "language": "ts",
  "fileSummary": "文件功能描述",
  "definitions": [
    {
      "name": "helper",
      "type": "function",
      "startLine": 10,
      "endLine": 25,
      "summary": "函数功能描述"
    }
  ]
}
```

## 文件关系图

```text-chart
[Outline 模块文件关系]
src/
├── cli.ts
│   └── 注册 cli.main:16-34
├── commands/
│   └── outline.ts
│       ├── outline.createOutlineCommand:174-194 → 命令定义
│       ├── outline.outlineHandler:111-169 → 参数处理
│       └── outline.handleOutline:11-106 → 主处理逻辑
├── cli-tools/
│   ├── outline-targets.ts
│   │   └── cli-tools.resolveOutlineTargets:45-118 → 目标解析
│   ├── outline.ts
│   │   ├── cli-tools.extractOutline:94-135 → 提取入口
│   │   ├── cli-tools.buildOutlineDefinitions:290-340 → 构建定义
│   │   ├── cli-tools.extractDefinitionsFromCaptures:345 → 解析捕获
│   │   ├── cli-tools.getOutlineAsText:164 → 文本输出
│   │   ├── cli-tools.getOutlineAsJson:233 → JSON 输出
│   │   ├── cli-tools.applySummaryCache:811-951 → 缓存管理
│   │   └── cli-tools.generateSummariesWithRetry:656-809 → 摘要生成
│   └── summary-cache.ts
│       └── cli-tools.SummaryCacheManager → 缓存管理器
└── tree-sitter/
    ├── index.ts
    │   ├── tree-sitter.parseSourceCodeDefinitionsForFile:104-157
    │   └── tree-sitter.parseSourceCodeForDefinitionsTopLevel:160-242
    ├── tree-sitter.languageParser.ts → 语言解析器加载 (tree-sitter.loadRequiredLanguageParsers:99-246)
    ├── tree-sitter.markdownParser.ts → Markdown 解析 (tree-sitter.parseMarkdown:35-173)
    └── tree-sitter.queries/ → 各语言的 Tree-sitter 查询
        ├── tree-sitter.queries.typescript.ts
        ├── tree-sitter.queries.python.ts
        └── ...
```

## 关键设计决策

1. **单一真相源**：`buildOutlineDefinitions` 统一为两种输出格式提供数据
2. **延迟加载**：Tree-sitter 解析器按需加载，减少启动时间
3. **智能缓存**：摘要按文件内容哈希缓存，避免重复生成
4. **双层过滤**：Glob 模式过滤 + Workspace ignore 规则
5. **流式处理**：支持单文件和批量文件处理

## 参考

- [Tree-sitter 文档](https://tree-sitter.github.io/tree-sitter/)
- [智能代码引用规范](./smart-code-reference.md)
- [文本图规则](./text-chart-rule.md)
