# codebase call 主流程文档

## 概述

`codebase call` 是用于分析代码依赖关系和函数调用链的 CLI 命令。它通过静态分析代码，构建函数调用图，支持查询特定函数的调用关系。

## 主流程图

```text-chart
[codebase call 主流程] (从 CLI 入口到结果输出的完整流程)

createCallCommand:585
  ↓
callHandler:383
├── 初始化日志 → initGlobalLogger:45
├── 解析工作区路径 → resolveWorkspacePath:65
├── 处理 --clear-cache 选项 (可选)
│   └── 清除依赖分析缓存
├── 创建 Node.js 依赖 → createNodeDependencies
├── 执行依赖分析 → index.analyze:120
│   ├── 查找 Git 根目录 → findGitRoot:85
├── 初始化缓存管理器 → cache-manager.DependencyCacheManager.initialize:79
│   ├── 解析目录/文件 → parseDirectory:341 / parseFile:293
│   │   └── 使用 Tree-sitter 解析代码
│   └── 构建调用图 → buildGraph:349
│       ├── 解析边 → resolveEdges:111
│       ├── 构建邻接表 → buildAdjacency:188
│       ├── 环检测 → detectCycles:220
│       └── 拓扑排序 → topologicalSort:278
└── 根据模式处理结果
    ├── queryMode:332 (查询模式)
    │   ├── querySingleFunction:274
    │   │   └── queryNode:269
    │   │       ├── buildCalleeTree:188 (dependency.buildCalleeTree:188-221) (构建被调用树)
    │   │       └── buildCallerTree:226 (dependency.buildCallerTree:226-259) (构建调用者树)
    │   └── queryMultipleFunctions:313
    │       └── analyzeConnections:406 (分析多函数连接)
    ├── exportViz:238 (可视化导出)
    │   └── openGraphViewer:39 (打开可视化查看器)
    └── displaySummary:72 (摘要显示)
```

## 详细流程说明

### 1. CLI 入口层

**文件**: `src/commands/call.ts`

```text-chart
[CLI 入口] (命令定义和参数解析)

createCallCommand:585
├── 定义命令 'call'
├── 配置参数选项
│   ├── --path <path>          # 工作目录路径
│   ├── --query <names>        # 查询特定函数
│   ├── --depth <number>       # 查询深度
│   ├── --viz <file>           # 导出可视化数据
│   ├── --open                 # 打开可视化查看器
│   ├── --json                 # JSON 格式输出
│   └── --clear-cache          # 清除缓存
└── 绑定处理函数 → callHandler:383
```

### 2. 主处理函数

**文件**: `src/commands/call.ts#L383-574 (commands.callHandler:383-574)`

```text-chart
[callHandler 主处理] (核心处理逻辑)

callHandler:383
├── 初始化阶段
│   ├── initGlobalLogger:45    # 初始化全局日志
│   ├── getLogger:58           # 获取日志实例
│   └── resolveWorkspacePath:65 # 解析工作区路径
├── 缓存处理 (可选)
│   └── --clear-cache 分支
│       ├── 查找 Git 根目录
│       ├── 创建 DependencyCacheManager
│       └── 清除缓存文件
├── 路径解析
│   ├── 判断目标路径类型 (文件/目录)
│   └── 创建完整依赖 → createNodeDependencies
├── 选项验证 → validateOptions:218
└── 分析执行
    └── index.analyze:120 ↪ [依赖分析详情]
```

### 3. 依赖分析核心

**文件**: `src/dependency/index.ts#L120-325 (dependency.analyze:120-325)`

```text-chart
[依赖分析详情] (analyze 函数完整流程) § [callHandler 主处理]

index.analyze:120
├── 路径处理
│   ├── 判断目标类型 (文件/目录)
│   └── 确定仓库根目录 (Git → Workspace → 目标路径)
├── 缓存初始化
│   └── DependencyCacheManager:40
│       ├── 加载缓存文件
│       └── 验证指纹有效性
├── 代码解析层 (Layer 1: PARSE)
│   ├── 单文件模式 → parseFile:293
│   │   ├── 读取文件内容
│   │   ├── 检测语言类型
│   │   └── Tree-sitter 解析
│   └── 目录模式 → parseDirectory:341
│       ├── walkFiles:225 (遍历文件)
│       ├── 应用 ignore 规则
│       └── 批量解析文件
├── 分析器处理
│   ├── 获取语言分析器 → getAnalyzer:97
│   ├── 加载语言解析器 → loadLanguageParser:197
│   ├── 创建分析器实例
│   │   └── TypeScriptAnalyzer / PythonAnalyzer 等
│   └── 提取节点和边 → analyzer.analyze()
├── 缓存管理
│   ├── 检查缓存命中 → getCacheEntry:107
│   ├── 存储新结果 → setCacheEntry:139
│   └── 刷新缓存到磁盘 → flush:233
└── 图构建层 (Layer 2+3: BUILD + ANALYZE)
    └── buildGraph:349 ↪ [图构建详情]
```

### 4. 图构建详情

**文件**: `src/dependency/graph.ts#L349-393 (dependency.buildGraph:349-393)`

```text-chart
[图构建详情] (buildGraph 函数流程) § [依赖分析详情]

buildGraph:349
├── 解析边 → resolveEdges:111
│   ├── 提取简单名称 → extractSimpleName:20
│   ├── 提取模块路径 → extractModulePath:35
│   ├── 智能匹配调用关系
│   └── 计算模块距离 → moduleDistance:76
├── 边去重
│   └── 使用 Set 去重重复边
├── 构建邻接表 → buildAdjacency:188
├── 环检测 → detectCycles:220
│   └── Tarjan 算法 → strongconnect:228
├── 拓扑排序 → topologicalSort:278
└── 更新节点依赖关系
    └── 将邻接表写入 node.dependsOn
```

### 5. 查询模式处理

**文件**: `src/commands/call.ts#L332-362 (commands.queryMode:332-362)`

```text-chart
[查询模式处理] (queryMode 分支逻辑)

queryMode:332
├── 判断查询类型
│   ├── 单函数查询 (无逗号分隔)
│   │   └── querySingleFunction:274
│   └── 多函数查询 (逗号分隔)
│       └── queryMultipleFunctions:313
└── 输出格式化
    ├── JSON 格式 → JSON.stringify
    └── 文本格式 → format 函数
```

### 6. 单函数查询详情

**文件**: `src/dependency/query.ts#L269-287 (dependency.queryNode:269-287)`

```text-chart
[单函数查询详情] (queryNode 双向树构建) § [查询模式处理]

queryNode:269
├── 构建被调用树 (Callee Tree)
│   └── buildCalleeTree:188 (dependency.buildCalleeTree:188-221)
│       ├── 递归遍历 node.dependsOn
│       ├── 防止循环依赖 (visited Set)
│       └── 构建层级树结构
└── 构建调用者树 (Caller Tree)
    └── buildCallerTree:226 (dependency.buildCallerTree:226-259)
        ├── 遍历所有节点查找调用者
        ├── 防止循环依赖 (visited Set)
        └── 构建层级树结构
```

### 7. 多函数连接分析

**文件**: `src/dependency/query.ts#L406-456 (dependency.analyzeConnections:406-456)`

```text-chart
[多函数连接分析] (analyzeConnections 流程) § [查询模式处理]

analyzeConnections:406
├── 查找匹配节点 → findMatchingNodes:143
│   ├── 分割逗号分隔的查询模式
│   ├── globToRegex:102 (通配符转正则)
│   └── 匹配节点 ID 或名称
├── 查找直接连接 → findDirectConnections:309
│   └── 检查节点间的直接调用关系
├── 查找最短路径 → findShortestPath:334
│   └── BFS 算法查找函数间路径
├── 构建调用链 → findChains:373
└── 收集所有涉及的节点
```

## 数据流图

```text-chart
[数据流] (从源代码到查询结果的完整数据流)

源代码文件
  ↓
Tree-sitter 解析
  ↓
AST (抽象语法树)
  ↓
语言分析器 (TypeScript/Python/Go...)
  ↓
DependencyNode[] + DependencyEdge[]
  ↓
buildGraph
  ↓
Map<string, DependencyNode> (节点映射)
  ↓
查询处理
  ├── 单函数 → NodeQueryResult (callee tree + caller tree)
  └── 多函数 → ConnectionAnalysisResult (chains + connections)
  ↓
格式化输出
  ├── 文本格式 (console.table/tree)
  └── JSON 格式
```

## 关键数据结构

### DependencyNode (依赖节点)

```typescript
interface DependencyNode {
  id: string;              // 唯一标识: "relativePath.className.methodName"
  name: string;            // 显示名称
  componentType: 'function' | 'class' | 'method' | 'module';
  filePath: string;        // 绝对路径
  relativePath: string;    // 相对路径
  startLine: number;       // 起始行号
  endLine: number;         // 结束行号
  dependsOn: Set<string>;  // 依赖的节点 ID 集合
  language: string;        // 编程语言
}
```

### DependencyEdge (依赖边)

```typescript
interface DependencyEdge {
  caller: string;    // 调用者节点 ID
  callee: string;    // 被调用者节点 ID
  type: 'call' | 'import' | 'inheritance';
  line?: number;     // 调用发生行号
}
```

## 缓存机制

```text-chart
[缓存机制] (DependencyCacheManager 工作流程)

DependencyCacheManager:40
├── cache-manager.DependencyCacheManager.initialize:79
│   ├── 加载缓存文件 (.dependency-cache.json)
│   └── 验证仓库指纹
├── getCacheEntry:107
│   ├── 计算内容哈希
│   ├── 比对指纹
│   └── 返回缓存的节点和边
├── setCacheEntry:139
│   ├── 序列化节点
│   ├── 创建指纹
│   └── 写入内存缓存
├── flush:233
│   └── 持久化到磁盘
└── clearCache:192
    └── 删除缓存文件
```

## 支持的编程语言

| 语言 | 分析器文件 |
|------|-----------|
| TypeScript/JavaScript | `analyzers/typescript.ts` |
| Python | `analyzers/python.ts` |
| Go | `analyzers/go.ts` |
| Rust | `analyzers/rust.ts` |
| Java | `analyzers/java.ts` |
| C/C++ | `analyzers/c.ts` / `analyzers/cpp.ts` |
| C# | `analyzers/csharp.ts` |

## 使用示例

### 单函数查询 (调用树)

```bash
# 查询 main 函数的调用关系 (默认深度 3)
codebase call --query="main"

# 查询特定文件中的函数
codebase call --query="*cli.callHandler"

# 自定义深度
codebase call --query="main" --depth=5
```

### 多函数连接分析

```bash
# 分析两个函数间的调用路径 (默认深度 10)
codebase call --query="main,handleRequest"

# 使用通配符
codebase call --query="*auth*,*login*"
```

### 可视化导出

```bash
# 导出完整依赖图
codebase call --viz graph.json

# 导出并打开可视化查看器
codebase call --viz graph.json --open
```

## 性能优化

1. **缓存机制**: 基于文件内容的增量缓存，避免重复解析
2. **Git 指纹**: 使用 Git 提交哈希验证缓存有效性
3. **Tree-sitter 解析器缓存**: 复用已初始化的解析器实例
4. **忽略规则**: 自动排除 node_modules、测试文件等

## 相关文件

| 文件路径 | 功能说明 |
|---------|---------|
| `src/commands/call.ts` | CLI 命令实现 |
| `src/dependency/index.ts` | 依赖分析主入口 |
| `src/dependency/query.ts` | 查询逻辑实现 |
| `src/dependency/graph.ts` | 图构建算法 |
| `src/dependency/parse.ts` | 代码解析逻辑 |
| `src/dependency/cache-manager.ts` | 缓存管理 |
| `src/dependency/analyzers/*.ts` | 各语言分析器 |