# 系统架构文档

## 概述

AutoDev Codebase 是一个基于向量嵌入的代码语义搜索工具，支持 MCP (Model Context Protocol) 服务器集成。本文档描述系统的整体架构、核心组件及其交互关系。

## 架构概览

```text-chart
[系统架构总览] (AutoDev Codebase 三层架构设计)

表示层 (Presentation)
├── CLI入口(cli.ts)
│   ├── 索引命令(index.ts)
│   ├── 搜索命令(search.ts)
│   ├── 大纲命令(outline.ts)
│   ├── 调用分析(call.ts)
│   ├── 配置命令(config/)
│   └── stdio适配(stdio.ts)

服务层 (Service Layer)
├── MCP服务器(http-server.ts)
│   ├── 搜索工具
│   ├── 大纲工具
│   └── 配置工具
├── 代码索引核心
│   ├── CodeIndexManager(manager.ts) ── 管理器入口
│   ├── CodeIndexOrchestrator(orchestrator.ts) ── 编排器
│   ├── CodeIndexServiceFactory(service-factory.ts) ── 工厂
│   └── SearchService(search-service.ts) ── 搜索服务
└── 依赖分析
    ├── DependencyAnalysisService(index.ts)
    ├── GraphBuilder(graph.ts)
    └── QueryEngine(query.ts)

数据层 (Data Layer)
├── 嵌入层(Embedders)
│   ├── Ollama
│   ├── OpenAI
│   ├── Jina
│   ├── Gemini
│   ├── Mistral
│   ├── OpenRouter
│   └── OpenAI-Compatible
├── 向量存储 ── QdrantVectorStore(qdrant-client.ts)
├── 代码解析 ── TreeSitterParser(tree-sitter/index.ts)
└── 处理器(Processors)
    ├── Scanner(scanner.ts)
    ├── Parser(parser.ts)
    ├── BatchProcessor(batch-processor.ts)
    └── FileWatcher(file-watcher.ts)
```

## 核心模块详解

### 1. CLI 层 (src/commands/)

CLI 层提供用户交互接口，采用子命令模式（类似 git/npm）。

```text-chart
[CLI命令结构] (命令模块组织)
commands/
├── index.ts ───────┬── indexHandler ─── 索引/服务启动
│                   └── performIndexDryRun ─── 预览模式
├── search.ts ──────┬── searchHandler ─── 语义搜索
│                   ├── formatSearchResults ─── 格式化输出
│                   └── formatSearchResultsAsJson ─── JSON输出
├── outline.ts ─────┬── outlineHandler ─── 代码大纲提取
│                   └── handleClearCache ─── 缓存清理
├── call.ts ────────┬── callHandler ─── 调用图分析
│                   ├── showSummary ─── 统计概览
│                   ├── exportData ─── 数据导出
│                   └── openVisualization ─── 可视化
├── config/ ────────┬── get.ts ─── 配置查看
│                   ├── set.ts ─── 配置设置
│                   └── parser.ts ─── 配置解析
└── stdio.ts ─────── stdioHandler ─── stdio适配器
```

**关键流程 - 索引命令** (commands/index.ts#indexHandler:232-385) (index.indexHandler:232-385):

```text-chart
[索引流程] (从CLI到索引完成的完整流程)
CLI入口 indexHandler
  ↓
解析命令选项 ──→ demo模式? ──→ 创建示例文件
  ↓
clear-cache? ──→ 是 ──→ 清除索引数据 ──→ 退出
  ↓ 否
serve? ──→ 是 ──→ 启动MCP服务器 ──→ 开始索引 ──→ 保持运行
  ↓ 否
dry-run? ──→ 是 ──→ 执行预览分析 ──→ 退出
  ↓ 否
正常索引模式 ──→ 初始化管理器 ──→ 等待索引完成 ──→ 退出
```

### 2. MCP 服务器 (src/mcp/)

MCP (Model Context Protocol) 服务器提供 HTTP 接口，支持 SSE 和 stdio 适配。

```text-chart
[MCP服务器架构] (HTTP MCP服务器组件)
CodebaseHTTPMCPServer(http-server.ts)
├── setupTools ─── 注册MCP工具
│   ├── search_codebase ─── 语义搜索
│   ├── get_codebase_stats ─── 统计信息
│   ├── configure_codebase ─── 配置管理
│   └── outline_codebase ─── 代码大纲
├── setupHTTPServer ─── Express服务器配置
│   ├── /mcp ─── MCP端点
│   └── /health ─── 健康检查
└── start/stop ─── 生命周期管理

stdio适配器(stdio-adapter.ts)
└── StdioAdapter ─── 桥接stdio与HTTP
```

### 3. 代码索引核心 (src/code-index/)

这是系统的核心模块，负责代码索引的全生命周期管理。

#### 3.1 管理器 (manager.ts)

`CodeIndexManager` 是库的主入口，采用单例模式。

```text-chart
[CodeIndexManager结构] (管理器核心方法)
CodeIndexManager
├── 生命周期管理
│   ├── getInstance ─── 获取单例
│   ├── initialize ─── 初始化 (CodeIndexManager.initialize:124-180)
│   └── dispose ─── 资源清理
├── 索引控制
│   ├── startIndexing ─── 开始索引 (CodeIndexOrchestrator.startIndexing:142-375)
│   ├── stopWatcher ─── 停止监听
│   └── clearIndexData ─── 清除数据
├── 搜索功能
│   └── searchIndex ─── 语义搜索 (manager.ts#searchIndex:369-375) (manager.CodeIndexManager.searchIndex:369-375)
└── 服务创建
    └── _recreateServices ─── 创建服务 (manager.ts#_recreateServices:381-466) (manager.CodeIndexManager._recreateServices:381-466)
```

#### 3.2 编排器 (orchestrator.ts)

`CodeIndexOrchestrator` 管理索引工作流，协调各组件。

```text-chart
[索引工作流] (CodeIndexOrchestrator.startIndexing:142-375)
startIndexing
  ↓
检查工作区和配置
  ↓
初始化向量存储 ──→ 创建新集合? ──→ 清除缓存
  ↓
force模式? ──→ 是 ──→ 清空集合和缓存
  ↓
已有索引数据? ──→ 是 ──→ 增量扫描 ──→ 启动监听 ──→ 完成
  ↓ 否
全量扫描 ──→ 批量处理文件 ──→ 启动监听 ──→ 标记完成
```

#### 3.3 服务工厂 (service-factory.ts)

负责创建和配置各种服务组件。

```text-chart
[服务工厂] (service-factory.ts 创建方法)
CodeIndexServiceFactory
├── createEmbedder ─── 创建嵌入器 (service-factory.ts#createEmbedder:59-117) (service-factory.CodeIndexServiceFactory.createEmbedder:59-117)
├── createVectorStore ─── 创建向量存储 (service-factory.ts#createVectorStore:139-173) (service-factory.CodeIndexServiceFactory.createVectorStore:139-173)
├── createDirectoryScanner ─── 创建目录扫描器
├── createFileWatcher ─── 创建文件监听器
├── createReranker ─── 创建重排序器 (service-factory.ts#createReranker:253-284) (service-factory.CodeIndexServiceFactory.createReranker:253-284)
└── createSummarizer ─── 创建摘要器 (service-factory.ts#createSummarizer:307-335) (service-factory.CodeIndexServiceFactory.createSummarizer:307-335)
```

### 4. 嵌入层 (src/code-index/embedders/)

支持多种嵌入提供商：

```text-chart
[嵌入器架构] (多提供商支持)
嵌入器接口(IEmbedder)
├── OllamaEmbedder ─── 本地嵌入，隐私保护
├── OpenAIEmbedder ─── OpenAI API
├── JinaEmbedder ─── Jina AI服务
├── GeminiEmbedder ─── Google Gemini
├── MistralEmbedder ─── Mistral AI
├── OpenRouterEmbedder ─── 统一API网关
└── OpenAICompatibleEmbedder ─── 兼容OpenAI的自定义服务
```

每个嵌入器实现统一的 `IEmbedder` 接口：

```typescript
// src/code-index/interfaces/embedder.ts
interface IEmbedder {
  embedChunks(chunks: string[]): Promise<number[][]>
  getModelInfo(): { id: string; dimensions: number; provider: string }
  validateConfig(): Promise<boolean>
}
```

### 5. 处理器层 (src/code-index/processors/)

负责文件扫描、解析和批量处理。

```text-chart
[处理器流水线] (文件处理流程)
DirectoryScanner(scanner.ts)
  ↓ 扫描文件列表
FileWatcher(file-watcher.ts)
  ↓ 监听变化
CodeParser(parser.ts)
  ↓ 解析代码结构
  ├── Tree-sitter解析
  ├── 代码块提取
  └── 元数据生成
BatchProcessor(batch-processor.ts)
  ↓ 批量处理
  ├── 并发控制
  ├── 错误处理
  └── 进度报告
```

### 6. 向量存储 (src/code-index/vector-store/)

```text-chart
[Qdrant向量存储] (qdrant-client.ts)
QdrantVectorStore
├── initialize ─── 初始化集合
├── upsertPoints ─── 插入/更新向量
├── search ─── 相似度搜索
├── deletePointsByFilePath ─── 按路径删除
├── clearCollection ─── 清空集合
└── markIndexingComplete ─── 标记索引完成
```

### 7. 依赖分析 (src/dependency/)

提供函数调用图分析功能。

```text-chart
[依赖分析架构] (调用图分析系统)
DependencyAnalysisService
├── analyze ─── 分析仓库 (dependency/index.analyze:120-325)
├── analyzeFile ─── 分析单个文件
└── generateVisualizationData ─── 生成可视化数据

核心组件
├── GraphBuilder(graph.ts) ─── 构建依赖图
├── QueryEngine(query.ts) ─── 查询分析
├── CacheManager(cache-manager.ts) ─── 缓存管理
└── 语言分析器(analyzers/)
    ├── TypeScript/JavaScript
    ├── Python
    ├── Java
    ├── Go
    ├── Rust
    ├── C/C++
    └── C#
```

### 8. Tree-sitter 解析 (src/tree-sitter/)

支持 40+ 编程语言的代码解析。

```text-chart
[Tree-sitter解析] (多语言代码解析)
TreeSitterParser
├── parseSourceCodeDefinitionsForFile ─── 解析文件定义
├── parseSourceCodeForDefinitionsTopLevel ─── 顶层定义
└── processCaptures ─── 处理语法捕获

语言查询(queries/)
├── typescript.ts ─── TypeScript
├── tsx.ts ─── TSX
├── javascript.ts ─── JavaScript
├── python.ts ─── Python
├── java.ts ─── Java
├── go.ts ─── Go
├── rust.ts ─── Rust
├── c.ts, cpp.ts ─── C/C++
├── csharp.ts ─── C#
└── ... 更多语言
```

### 9. 抽象层 (src/abstractions/)

提供平台无关的核心接口。

```text-chart
[抽象层接口] (平台无关抽象)
abstractions/
├── core.ts ─── IFileSystem, IStorage, IEventBus, ILogger
├── workspace.ts ─── IWorkspace, IPathUtils
└── config.ts ─── IConfigProvider

适配器实现(adapters/nodejs/)
├── file-system.ts ─── Node.js文件系统
├── storage.ts ─── Node.js存储
├── event-bus.ts ─── Node.js事件总线
├── logger.ts ─── Node.js日志
├── workspace.ts ─── Node.js工作区
└── config.ts ─── Node.js配置
```

## 数据流

### 索引流程

```text-chart
[索引数据流] (从文件到向量的完整流程)
文件系统
  ↓
DirectoryScanner ──→ 扫描文件列表
  ↓
IgnoreService ──→ 应用忽略规则
  ↓
FileWatcher ──→ 监听文件变化
  ↓
CodeParser ──→ 解析代码结构
  ↓
代码块提取 ──→ 函数、类、方法
  ↓
Embedder ──→ 生成向量嵌入
  ↓
QdrantVectorStore ──→ 存储向量
```

### 搜索流程

```text-chart
[搜索数据流] (语义搜索处理流程)
用户查询
  ↓
Embedder.embedChunks ──→ 查询向量化
  ↓
QdrantVectorStore.search ──→ 向量相似度搜索
  ↓
Reranker(可选) ──→ LLM重排序
  ↓
结果格式化 ──→ 返回给用户
```

## 配置体系

系统采用四层配置优先级：

```text-chart
[配置优先级] (从高到低)
1. CLI参数 ─── 运行时覆盖
   └── --path, --log-level, --force等
   
2. 项目配置 ─── ./autodev-config.json
   └── 项目级持久化设置
   
3. 全局配置 ─── ~/.autodev-cache/autodev-config.json
   └── 用户级默认设置
   
4. 内置默认值 ─── 代码中的默认配置
```

## 扩展点

### 添加新的嵌入提供商

1. 在 `src/code-index/embedders/` 创建新的嵌入器类
2. 实现 `IEmbedder` 接口
3. 在 `service-factory.ts` 的 `createEmbedder` 方法中添加分支

### 添加新的语言支持

1. 在 `src/tree-sitter/queries/` 创建语言查询文件
2. 在 `src/dependency/analyzers/` 创建语言分析器
3. 更新语言映射表

### 添加新的MCP工具

1. 在 `http-server.ts` 的 `setupTools` 方法中注册新工具
2. 实现工具处理函数

## 关键技术决策

1. **向量数据库选择 Qdrant**: 高性能、开源、支持过滤和混合搜索
2. **Tree-sitter 解析**: 快速、准确、支持40+语言
3. **依赖注入模式**: 便于测试和平台适配
4. **单例管理器模式**: 确保全局状态一致性
5. **事件驱动架构**: 解耦组件，支持实时更新

## 相关文档

- 配置说明: [CONFIG.md](../CONFIG.md)
- 项目大纲: [project-outline-title.md](./project-outline-title.md)
- API文档: 见各模块接口定义文件