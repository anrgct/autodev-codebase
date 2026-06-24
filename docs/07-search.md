# Codebase Search 主流程

本文档描述 `codebase search` 命令的完整执行流程，从 CLI 入口到结果返回。

## 流程概览

```text-chart
[Search 主流程] (从 CLI 入口到结果展示的完整流程)
cli.main
  ↓
search.createSearchCommand:283
  ↓
search.searchHandler:180
  ↓
shared.initializeManager:118
  ↓
manager.CodeIndexManager.initialize:124
  ↓
manager.searchIndex:369
  ↓
CodeIndexSearchService.searchIndex:30
  ├── 生成 Embedding embedder.createEmbeddings:48
  ├── 向量搜索 QdrantVectorStore.search
  └── 可选 Rerank reranker.rerank:46
  ↓
search.formatSearchResults:24 / formatSearchResultsAsJson:110
  ↓
输出结果
```

## 详细步骤说明

### 1. CLI 入口

**文件**: `src/cli.ts`

CLI 使用 commander.js 的子命令模式，`search` 是其中一个子命令。

```typescript
// cli.ts
program.addCommand(createSearchCommand());
```

### 2. 命令注册与参数解析

**文件**: `src/commands/search.ts` (L283-302) (search.createSearchCommand:283-302)

`createSearchCommand` 创建 search 子命令，定义参数和选项：

| 参数/选项 | 说明 |
|-----------|------|
| `<query>` | 搜索查询（必需） |
| `-p, --path <path>` | 工作目录路径 |
| `-f, --path-filters <filters>` | 路径过滤模式 |
| `-l, --limit <number>` | 最大结果数 |
| `-S, --min-score <number>` | 最小相似度分数 |
| `--json` | JSON 格式输出 |
| `--log-level <level>` | 日志级别 |

### 3. 搜索处理器

**文件**: `src/commands/search.ts` (L180-278) (search.searchHandler:180-278)

`searchHandler` 是核心处理函数：

```text-chart
[searchHandler 流程] (参数处理到执行搜索)
解析参数
  ├── 解析 pathFilters → utils.parsePathFilters:10
  ├── 验证 limit → validateLimit:4
  ├── 验证 minScore → validateMinScore:25
  ↓
初始化管理器 shared.initializeManager:118
  ↓
检查功能启用状态 manager.isFeatureEnabled
  ↓
执行搜索 manager.CodeIndexManager.searchIndex:369
  ├── 索引未就绪 → waitForIndexingCompletion:160
  └── 索引就绪 → 直接返回结果
  ↓
格式化输出
  ├── --json → formatSearchResultsAsJson:110
  └── 默认 → formatSearchResults:24
```

### 4. 管理器初始化

**文件**: `src/commands/shared.ts` (L118-155) (shared.initializeManager:118-155)

`initializeManager` 负责创建和初始化 `CodeIndexManager`：

1. **创建依赖**: `createNodeDependencies` - 创建 Node.js 平台适配器
2. **加载配置**: `configProvider.loadConfig` - 从配置文件加载
3. **验证配置**: `configProvider.validateConfig` - 检查配置有效性
4. **获取实例**: `CodeIndexManager.getInstance` - 单例模式获取管理器
5. **初始化**: `manager.initialize` - 初始化服务和状态

### 5. CodeIndexManager 搜索入口

**文件**: `src/code-index/manager.ts` (L369-375) (manager.CodeIndexManager.searchIndex:369-375)

```typescript
public async searchIndex(query: string, filter?: SearchFilter): Promise<VectorStoreSearchResult[]> {
    if (!this.isFeatureEnabled) {
        return []
    }
    this.assertInitialized()
    return this._searchService!.searchIndex(query, filter)
}
```

### 6. 搜索服务核心逻辑

**文件**: `src/code-index/search-service.ts` (L30-106) (CodeIndexSearchService.searchIndex:30-106)

`CodeIndexSearchService.searchIndex:30` 执行完整的语义搜索流程：

```text-chart
[searchIndex 核心流程] (语义搜索完整步骤)
检查功能状态 isFeatureEnabled / isFeatureConfigured
  ↓
检查索引状态 stateManager.getCurrentStatus
  ↓
应用 Query Prefill applyQueryPrefill:18
  ├── 仅对 ollama + qwen3-embedding 模型
  └── 添加模板前缀提升嵌入质量
  ↓
生成查询向量 embedder.createEmbeddings:48
  ↓
执行向量搜索 QdrantVectorStore.search:503
  ├── 验证参数 validateLimit / validateMinScore
  └── Qdrant 向量检索
  ↓
结果排序（按分数降序）
  ↓
可选 LLM Rerank（如启用）↪ [Rerank 详细流程]
  ↓
返回结果
```

### 7. 向量存储搜索

**文件**: `src/code-index/vector-store/qdrant-client.ts` (L503-550) (QdrantVectorStore.search:503-550)

`QdrantVectorStore.search:503` 执行实际的向量数据库查询：

1. **构建过滤器**: 使用 `PatternCompiler` 编译 pathFilters
2. **排除元数据**: 自动排除 `type: metadata` 的文档
3. **执行查询**: 调用 Qdrant client 的 query 方法
4. **验证 payload**: 过滤掉无效 payload 的结果
5. **返回结果**: 映射为 `VectorStoreSearchResult` 格式

### 8. LLM Rerank 机制

**文件**: 
- `src/code-index/search-service.ts` (L60-89) (reranker.rerank:84)
- `src/code-index/rerankers/ollama.ts`
- `src/code-index/rerankers/openai-compatible.ts`
- `src/code-index/interfaces/reranker.ts`

LLM Rerank 是对向量搜索结果的二次排序，使用 LLM 评估候选结果与查询的相关性。

#### Rerank 流程

```text-chart
[Rerank 详细流程] (LLM 重排序完整步骤) § [searchIndex 核心流程]
检查 reranker 是否启用 configManager.rerankerConfig
  ↓
构建候选列表 candidates
  ├── id: 结果唯一标识
  ├── content: 代码片段内容
  ├── score: 原始向量搜索分数
  └── payload: 附加元数据
  ↓
批量处理 reranker.rerank:84
  ├── 分批处理 (默认 batchSize=10)
  ├── 并发控制 (默认 concurrency=3)
  └── 重试机制 (默认 maxRetries=3)
  ↓
生成评分 Prompt ollama.OllamaLLMReranker.buildScoringPrompt:167-196
  ├── 查询内容
  ├── 候选代码片段
  └── 评分指令 (0-10 分)
  ↓
LLM 评分 ollama.OllamaLLMReranker.generateScores:230-316
  ├── 调用 Ollama/OpenAI-Compatible API
  ├── 解析响应提取分数
  └── 异常处理和重试
  ↓
结果合并与排序
  ├── 按 LLM 评分降序排列
  └── 保留原始分数用于参考
  ↓
过滤低分结果
  └── 应用 rerankerMinScore 阈值
```

#### Reranker 配置

**配置项** (`RerankerConfig`):

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `enabled` | 是否启用 Rerank | `false` |
| `provider` | 提供商类型 | `'ollama'` |
| `ollamaBaseUrl` | Ollama 服务地址 | `'http://localhost:11434'` |
| `ollamaModelId` | Ollama 模型 ID | `'qwen2.5:7b'` |
| `openAiCompatibleBaseUrl` | OpenAI-Compatible 地址 | - |
| `openAiCompatibleModelId` | OpenAI-Compatible 模型 | - |
| `openAiCompatibleApiKey` | API 密钥 | - |
| `minScore` | 最低接受分数 | - |
| `batchSize` | 每批处理数量 | `10` |
| `concurrency` | 最大并发批次数 | `3` |
| `maxRetries` | 最大重试次数 | `3` |
| `retryDelayMs` | 重试延迟(毫秒) | `1000` |

#### 两种 Reranker 实现

1. **OllamaLLMReranker** (`src/code-index/rerankers/ollama.ts`)
   - 使用 Ollama 本地模型
   - 支持流式响应解析
   - 自动重试和错误处理

2. **OpenAICompatibleReranker** (`src/code-index/rerankers/openai-compatible.ts`) (L49-147) (rerank:46-134)
   - 兼容 OpenAI API 格式
   - 支持 messages 格式的对话
   - 同样支持重试机制

#### 评分 Prompt 示例

```
请评估以下代码片段与用户查询的相关性。

查询: {用户查询}

候选代码片段:
1. {代码内容1}
2. {代码内容2}
...

请为每个候选片段打分(0-10分)，10分表示完全相关。
以 JSON 数组格式返回分数: [8, 5, 9, ...]
```

### 10. Query Prefill 机制

**文件**: `src/code-index/search/query-prefill.ts` (L18-37) (query-prefill.applyQueryPrefill:18-37)

针对 Qwen3 嵌入模型的优化：

```typescript
const QWEN_PREFILL_TEMPLATE = "Instruct: Given a codebase search query, retrieve relevant code snippets or document that answer the query.\nQuery: "
```

仅当使用 `ollama` 提供商且模型 ID 匹配 `qwen3-embedding` 模式时应用。

### 11. 结果格式化

**文件**: `src/commands/search.ts`

两种输出格式：

#### 默认格式 (formatSearchResults:24) `formatSearchResults:24-105`

- 按文件分组
- 去重（移除被包含的代码片段）
- 显示文件路径、行号、层级信息、代码内容
- 按平均分数排序

#### JSON 格式 (formatSearchResultsAsJson:110) `formatSearchResultsAsJson:110-175`

```json
{
  "query": "搜索查询",
  "totalResults": 10,
  "totalSnippets": 8,
  "duplicatesRemoved": 2,
  "snippets": [
    {
      "filePath": "src/example.ts",
      "code": "代码内容",
      "startLine": 10,
      "endLine": 20,
      "lineRange": "L10-20",
      "hierarchy": "ClassName.methodName",
      "score": 0.85
    }
  ]
}
```

## 关键组件关系

```text-chart
[组件关系图] (Search 功能涉及的模块依赖)
CLI Layer
  └── commands/search.ts
        ├── commands/shared.ts (初始化工具)
        ├── utils/path-filters.ts (路径过滤)
        └── code-index/manager.ts (管理器入口)

Core Layer
  └── code-index/manager.ts
        └── code-index/search-service.ts (搜索服务)
              ├── code-index/config-manager.ts (配置)
              ├── code-index/state-manager.ts (状态)
              ├── code-index/interfaces/embedder.ts (嵌入器)
              ├── code-index/interfaces/vector-store.ts (向量库)
              ├── code-index/interfaces/reranker.ts (重排序器接口)
              ├── code-index/rerankers/ollama.ts (Ollama Reranker)
              ├── code-index/rerankers/openai-compatible.ts (OpenAI Reranker)
              └── code-index/search/query-prefill.ts (查询预处理)

Storage Layer
  └── code-index/vector-store/qdrant-client.ts
        └── Qdrant Vector Database
```

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| 索引未就绪 | 自动触发索引，完成后重试搜索 |
| 功能未启用 | 返回空数组或报错退出 |
| 配置无效 | 记录警告，继续执行 |
| 嵌入生成失败 | 抛出错误，设置系统状态为 Error |
| 向量搜索失败 | 抛出错误，记录详细错误信息 |
| Rerank 失败 | 记录错误，返回原始向量搜索结果 |

## 相关文件索引

| 文件 | 职责 |
|------|------|
| `src/cli.ts` | CLI 入口，子命令注册 |
| `src/commands/search.ts` | Search 命令实现，结果格式化 |
| `src/commands/shared.ts` | 共享的初始化逻辑 |
| `src/code-index/manager.ts` | 代码索引管理器 |
| `src/code-index/search-service.ts` | 搜索服务核心 |
| `src/code-index/vector-store/qdrant-client.ts` | Qdrant 向量存储实现 |
| `src/code-index/search/query-prefill.ts` | 查询预处理 |
| `src/code-index/interfaces/reranker.ts` | Reranker 接口定义 |
| `src/code-index/rerankers/ollama.ts` | Ollama Reranker 实现 |
| `src/code-index/rerankers/openai-compatible.ts` | OpenAI-Compatible Reranker 实现 |
| `src/code-index/service-factory.ts` | 服务工厂，创建 Reranker 实例 |
| `src/utils/path-filters.ts` | 路径过滤解析 |
| `src/code-index/validate-search-params.ts` | 参数验证 |