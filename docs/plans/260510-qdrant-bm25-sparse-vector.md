# 260510-qdrant-bm25-sparse-vector

## 主题/需求

调研并实现 Qdrant 的 BM25 关键词检索能力，使代码搜索支持"语义搜索 + 关键词搜索"的混合检索模式。

**核心问题：** 当前 `QdrantVectorStore` 仅使用稠密向量（dense vector）进行语义搜索，缺少传统关键词匹配能力。对于一些精确的函数名、变量名搜索，纯语义搜索效果不佳。

**目标：**
- 了解 Qdrant 的 BM25 / Sparse Vector 能力
- 评估在项目中集成的可行性和改动量
- 选择最优方案并给出实施计划

## 代码背景

### 当前搜索链路

```text-chart
[搜索链路] (当前纯稠密向量搜索流程)
用户输入 "用户认证"
  ↓
CodeIndexSearchService.searchIndex:29 (search-service.CodeIndexSearchService.searchIndex:29)
  ↓
embedder.createEmbeddings([query])  → denseVector: [0.123, -0.045, ...]
  ↓
vectorStore.search(vector, filter):503 (qdrant-client.QdrantVectorStore.search:503)
  ↓
this.client.query(collection, { query: denseVector }):538
  ↓
返回语义相似度排序结果
```

**关键文件：**

| 文件 | 角色 |
|------|------|
| `src/code-index/interfaces/vector-store.ts` | `IVectorStore` 接口定义 - `search()` 仅接受 `queryVector: number[]` |
| `src/code-index/interfaces/embedder.ts` | `IEmbedder` 接口定义 - `createEmbeddings()` 仅返回稠密向量 |
| `src/code-index/vector-store/qdrant-client.ts` | `QdrantVectorStore` 实现 - 当前仅 dense search |
| `src/code-index/search-service.ts` | `CodeIndexSearchService` - 搜索编排层，调用 `embedder` 和 `vectorStore` |
| `src/code-index/service-factory.ts` | `CodeIndexServiceFactory` - 服务工厂，创建 `QdrantVectorStore` |

### Qdrant 初始化配置

```text-chart
[Collection 初始化] (initialize:232 当前 collection 创建配置由 initialize 方法完成)
QdrantVectorStore.initialize:232
  ↓
createCollection(collectionName, {
  vectors: { size, distance: "Cosine", on_disk: true },
  hnsw_config: { m: 64, ef_construct: 512, on_disk: true }
})
  ↓
_createPayloadIndexes:375  → 创建 filePath/sourceFile/fileType 字段索引
```

当前 collection 配置（qdrant-client.QdrantVectorStore.initialize:232）：

- **vectors**: 仅配置了稠密向量 `{ size, distance: "Cosine" }`
- **sparse_vectors**: 未配置
- **payload indexes**: `filePath`（keyword）、`sourceFile`（keyword）、`fileType`（keyword）

### Qdrant 版本依赖

需要确认项目的 `@qdrant/js-client-rest` 版本，以及目标 Qdrant 服务端版本是否支持 sparse vectors。

## 关键决策

### 方案对比

| 方案 | 原理 | Qdrant 版本要求 | 改动量 | 效果 |
|------|------|----------------|--------|------|
| **方案A: Sparse Vectors（推荐）** | 在 collection 配置中声明 `sparse_vectors`，Qdrant 自动对 payload 字段做 BM25 分词索引。查询时混合 dense + sparse 打分 | ≥ v1.10 | 中 | ⭐⭐⭐ 最佳，真正的 BM25 + 语义混合搜索 |
| **方案B: Full Text Index** | 仅做全文过滤（用 `full_text_match` filter），不做 BM25 检索打分 | ≥ v1.3 | 小 | ⭐⭐ 简单但只是过滤，不参与排序 |
| **方案C: 外部 BM25 编码器** | 自行维护 token 词典，手动计算 TF-IDF/BM25，生成 sparse vector 传给 Qdrant | 任意 | 大 | ⭐ 灵活但维护成本高，不推荐 |

### 推荐方案：方案A — Sparse Vectors

**理由：**
1. Qdrant v1.10+ 内置 BM25 sparse vector 支持，无需额外依赖
2. Qdrant 自动在 upsert 时对 payload 字段做分词和 BM25 权重计算
3. 查询时 Qdrant 也自动将文本 query 转为 BM25 sparse vector
4. 支持与 dense vector 混合检索，融合排序

**Sparse Vectors 不需要用户自己生成：** Qdrant 在配置了 `sparse_vectors.index.type = "bm25"` 后，upsert 文档时自动对指定 payload 字段进行分词并计算 BM25 权重。查询时传入 `query_sparse.text`，Qdrant 同样自动处理。

### 需要变更的接口

1. `IVectorStore.search()` 签名需要扩展，增加 `sparseQuery?: string` 参数
2. `IEmbedder` 不需要改动（不需要它输出 sparse vector，Qdrant 自己处理）
3. `ISearchFilter` 可能需要增加 `enableHybrid?: boolean` 开关
4. `QdrantVectorStore.initialize()` 需要修改 collection 创建配置

## 实施计划

- [ ] **阶段1: 调研与确认**
  - [ ] 确认项目中 `@qdrant/js-client-rest` 的版本，评估是否支持 sparse vectors API
  - [ ] 确认目标 Qdrant 服务端版本 ≥ v1.10
  - [ ] 测试 Qdrant v1.12+ 的 `query_sparse` + `query` 混合查询 API 是否正常工作
- [ ] **阶段2: 修改 collection 初始化**
  - [ ] 在 `QdrantVectorStore.initialize()` 中增加 `sparse_vectors` 配置
  - [ ] 确定对哪个 payload 字段（`codeChunk`）建立 BM25 稀疏索引
  - [ ] 处理已有 collection 的兼容（维度不匹配时重建）
- [ ] **阶段3: 修改搜索接口**
  - [ ] 扩展 `IVectorStore.search()` 支持 `sparseQuery` 参数
  - [ ] `QdrantVectorStore.search()` 中调用 `query_sparse` 实现混合搜索
  - [ ] `CodeIndexSearchService.searchIndex()` 中传递原始 query 作为 sparse query
- [ ] **阶段4: 测试与优化**
  - [ ] 添加 `QdrantVectorStore` 单元测试（混合搜索场景）
  - [ ] 对比纯 dense vs 混合搜索的效果
  - [ ] 调整混合搜索的权重/融合策略（如 RRF）

## 实施记录

### 2026-05-10
调研 Qdrant BM25 能力，确认以下关键点：

1. **Sparse Vectors 由 Qdrant 自动生成**，不需要额外的 BM25 编码库
2. Qdrant v1.10+ 支持 sparse vectors，v1.12+ 支持 `query_sparse` 传文本自动编码
3. 当前项目 collection 仅有 dense vectors，需要修改 `initialize()` 和 `search()` 两处
4. `IEmbedder` 接口不需要改动，BM25 编码由 Qdrant 服务端完成

## 修订记录

（暂无）

## 总结

**关键收获：**
- Sparse Vectors 是 Qdrant 内置的 BM25 搜索引擎，用户无需自行生成 sparse vector
- 集成改动的核心在两个方法：`initialize()`（加 sparse_vectors 配置）和 `search()`（加 query_sparse 参数）
- 不需要引入新的 npm 依赖，只需要确保 Qdrant 版本足够新

**待确认的关键问题：**
1. 当前使用的 `@qdrant/js-client-rest` 版本是否支持 `query_sparse` API
2. 用户/项目的 Qdrant 服务端版本是多少
3. 是否所有部署环境都能升级到 Qdrant v1.12+

**后续优化方向：**
- 支持 RRF（Reciprocal Rank Fusion）融合 dense 和 sparse 排序结果
- 权重可配置（语义 vs 关键词的侧重比例）
- 支持 `explain` 模式查看各子查询的贡献
