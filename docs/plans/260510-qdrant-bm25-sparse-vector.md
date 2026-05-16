# 260510-qdrant-bm25-sparse-vector

## 主题/需求

调研并实现 Qdrant 的 BM25 关键词检索能力，使代码搜索支持"语义搜索 + 关键词搜索"的混合检索模式。

**核心问题：** 当前 `QdrantVectorStore` 仅使用稠密向量（dense vector）进行语义搜索，缺少传统关键词匹配能力。对于一些精确的函数名、变量名搜索，纯语义搜索效果不佳。

**复现用例：**

```bash
# 搜索带字面量 "Clear index mode" 的代码片段，纯 dense 搜索找不到字面匹配
codebase search -f '!*.md' '字面量"Clear index mode"' | grep -E 'results in|^< |File: |Clear index mode'

# 期望：BM25 混合搜索能把包含 "Clear index mode" 字面量的代码片段排在前面
# 现状：纯语义搜索可能漏掉或排在很后面
```

**目标：**
- 了解 Qdrant 的 BM25 / Sparse Vector 能力
- 评估在项目中集成的可行性和改动量
- 选择最优方案并给出实施计划
- 实现后，上述查询应返回字面量匹配的结果

## 代码背景

### 当前搜索链路

```text-chart
[搜索链路] (当前纯稠密向量搜索流程)
用户输入 "字面量Clear index mode"
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
| `src/code-index/config-manager.ts` | `CodeIndexConfigManager` - 配置管理 |
| `src/code-index/interfaces/config.ts` | `CodeIndexConfig` 接口 - 需新增 hybrid 配置项 |
| `src/code-index/constants/index.ts` | `DEFAULT_CONFIG` - 需新增 hybrid 默认值 |

### Qdrant 初始化配置

```text-chart
[Collection 初始化] (initialize:232)
QdrantVectorStore.initialize:232
  ↓
createCollection(collectionName, {
  vectors: { size, distance: "Cosine", on_disk: true },
  hnsw_config: { m: 64, ef_construct: 512, on_disk: true }
})
  ↓
_createPayloadIndexes:375  → 创建 type/pathSegments/filePathLower 字段索引
```

当前 collection 配置：

- **vectors**: 仅配置了稠密向量 `{ size, distance: "Cosine" }`
- **sparse_vectors**: 未配置
- **payload indexes**: `type`（keyword）、`pathSegments.{0..4}`（keyword）、`filePathLower`（keyword）

### Qdrant 版本依赖

已确认版本：

| 组件 | 最低要求 | 实际版本 | 状态 |
|------|---------|---------|------|
| `@qdrant/js-client-rest` | ≥ v1.10 | **v1.16.2** | ✅ |
| Qdrant 服务端 | ≥ v1.12 | **v1.16.3** | ✅ |

两者均远超最低要求，完全支持 sparse vectors、BM25 自动编码、prefetch + RRF 混合搜索。

## 关键决策

### 方案对比

| 方案 | 原理 | Qdrant 版本要求 | 改动量 | 效果 |
|------|------|----------------|--------|------|
| **方案A: Sparse Vectors（推荐）** | collection 中声明 `sparse_vectors`，upsert 时传 Document 类型，Qdrant 自动 BM25 编码。查询时 prefetch + RRF 混合 | ≥ v1.12 | 中 | ⭐⭐⭐ 最佳 |
| **方案B: Full Text Index** | 仅做全文过滤（用 `full_text_match` filter），不做 BM25 检索打分 | ≥ v1.3 | 小 | ⭐⭐ 过滤不参与排序 |
| **方案C: 外部 BM25 编码器** | 自行维护 token 词典，手动计算 TF-IDF/BM25 | 任意 | 大 | ⭐ 维护成本高 |

### 推荐方案：方案A — Sparse Vectors

**⚠️ 重要纠正（v2）：** 原始计划认为 Qdrant "自动对 payload 字段做分词"是错误的。实际机制是：

- Qdrant 不会从 payload 字段读取和分词
- 但 Qdrant 会将 Named Vector 中的 `Document { text, model: "qdrant/bm25" }` 自动编码为稀疏向量
- 数据流：客户端传 `{ "bm25": { text: codeChunk, model: "qdrant/bm25" } }` → Qdrant 服务端 `Bm25::doc_embed()` → 存储为稀疏向量

### Qdrant 源码证据

**写入链路（upsert 时 BM25 自动编码）：**

```text-chart
[Qdrant 写入时 BM25 自动编码流程]
客户端 upsert: { vector: { "": dense, "bm25": { text: "function clearIndex...", model: "qdrant/bm25" } } }
  ↓
update_requests.convert_point_struct:27 (update_requests.rs:27)
  ↓ VectorStruct::Named(named) → Vector::Document(doc)
  ↓
batch_accum.add(InferenceData::Document(doc))
  ↓
BatchAccumInferred::from_batch_accum → infer_local:29 (local_model.rs:29)
  ↓ InferenceType::Update
  ↓
Bm25::doc_embed(input_str):58 (bm25.rs:58)
  ↓ tokenize → term_frequency (BM25 TF 含 k/b/avg_len 超参，均用默认值)
  ↓
→ VectorPersisted::Sparse(indices, values)  # 稀疏向量
```

**限制：必须是 Named Vector 内的 Document：**

```rust
// qdrant/src/common/inference/update_requests.rs:87-90
VectorPersisted::Sparse(_) => {
    return Err(StorageError::bad_request(
        "Sparse vector from document inference should be named",
    ));
}
```

**查询链路（search 时 BM25 自动编码）：**

```text-chart
[Qdrant 查询时 BM25 混合检索流程]
客户端 query: { prefetch: [
  { query: denseVector },
  { query: { text: "Clear index mode", model: "qdrant/bm25" }, using: "bm25" }
] }
  ↓
InferenceType::Search → Bm25::search_embed:40 (bm25.rs:40)
  ↓ tokenize → unique tokens → values = [1.0; n]
  ↓
→ 稀疏查询向量
  ↓
两个 prefetch 各自打分 → RRF 自动融合 → 排序结果
```

### 配置设计

采用与现有 `vectorSearch*` / `reranker*` 风格一致的**平级 camelCase** 命名：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `hybridSearchEnabled` | `boolean` | `true` | 开关。关闭即回退纯 dense 搜索 |
| `hybridSearchDenseWeight` | `number` | `1.0` | 语义权重，越大越偏语义 |
| `hybridSearchSparseWeight` | `number` | `0.3` | 关键词权重，越大越偏字面量匹配 |

配置文件中形式：

```json
"vectorSearchMinScore": 0.1,
"vectorSearchMaxResults": 50,
"hybridSearchEnabled": true,
"hybridSearchDenseWeight": 1.0,
"hybridSearchSparseWeight": 0.3
```

### 需要变更的接口/文件

| 文件 | 改动 |
|------|------|
| `src/code-index/interfaces/vector-store.ts` | `search()` 签名扩展 `HybridSearchOptions` |
| `src/code-index/interfaces/config.ts` | `CodeIndexConfig` 新增 3 个 hybrid 配置项 |
| `src/code-index/constants/index.ts` | `DEFAULT_CONFIG` 新增 hybrid 默认值 |
| `src/code-index/vector-store/qdrant-client.ts` | `initialize()` 加 `sparse_vectors`；`upsertPoints()` 传 Document；`search()` 用 prefetch |
| `src/code-index/search-service.ts` | `searchIndex()` 传递原始 query 给 vectorStore |
| `src/code-index/config-manager.ts` | 暴露 `hybridSearch*` getter |
| `IEmbedder` | **不需要改动** — dense 嵌入不变，BM25 由 Qdrant 处理 |

## 实施计划

- [x] **阶段1: 调研与确认**
  - [x] 确认 `@qdrant/js-client-rest` 版本 → **v1.16.2** ✅
  - [x] 确认 Qdrant 服务端版本 → **v1.16.3** ✅
  - [x] 阅读 Qdrant 源码验证 BM25 自动编码机制（`update_requests.rs` + `bm25.rs` + `local_model.rs`）
  - [x] 确认写入时必须用 Named Vector 内的 Document，裸 Document 不可行
- [x] **阶段2: 修改 collection 初始化**
  - [x] `initialize()` 的 `createCollection` 中增加 `sparse_vectors: { "bm25": { index: { on_disk: true }, modifier: "idf" } }`
  - [x] 处理已有 collection 兼容（检测缺少 sparse_vectors → 重建）
- [x] **阶段3: 修改 upsert — Document 命名向量**
  - [x] `upsertPoints()` 中将 `codeChunk` 作为 `{ text, model: "qdrant/bm25" }` 传入 named vector `"bm25"`
  - [x] 无需客户端分词器
- [x] **阶段4: 修改搜索接口**
  - [x] 扩展 `IVectorStore.search()` 支持 `HybridSearchOptions`
  - [x] `QdrantVectorStore.search()` 通过 `prefetch` + RRF 实现 dense + sparse 混合
  - [x] `CodeIndexSearchService.searchIndex()` 传递原始 query
- [x] **阶段5: 配置集成**
  - [x] `CodeIndexConfig` / `DEFAULT_CONFIG` 新增 3 个 hybrid 配置项
  - [x] `CodeIndexConfigManager` 暴露 `hybridSearch*` getter
  - [x] `PreviousConfigSnapshot` 同步新增
- [x] **阶段6: 测试与验证**
  - [x] `QdrantVectorStore` 单元测试（32 测试全部通过）
  - [x] `config-manager.spec.ts` 测试通过
  - [x] TypeScript 类型检查通过
  - [x] Rollup 构建成功
  - [x] 用复现用例验证：`codebase search -f '!*.md' '字面量"Clear index mode"'`（需 Qdrant 服务运行）
  - [x] 对比纯 dense vs 混合搜索效果（需 Qdrant 服务运行）

## 实施记录

### 2026-05-10
调研 Qdrant BM25 能力，确认以下关键点：

1. **Sparse Vectors 由 Qdrant 自动生成**，不需要额外的 BM25 编码库
2. Qdrant v1.10+ 支持 sparse vectors，v1.12+ 支持 `query` + `Document` 传文本自动编码
3. 当前项目 collection 仅有 dense vectors，需要修改 `initialize()` 和 `search()` 两处
4. `IEmbedder` 接口不需要改动，BM25 编码由 Qdrant 服务端完成

### 2026-05-10（补充调研）
深入阅读 Qdrant 源码后，纠正关键认知：

1. **写入链路**：Qdrant 不会从 payload 字段自动分词。必须把 `codeChunk` 作为 `Document { text, model: "qdrant/bm25" }` 传入 Named Vector `"bm25"`：
   - `qdrant/src/common/inference/update_requests.rs:27-40` — 检测 Named Vector 中的 Document 类型
   - `qdrant/src/common/inference/local_model.rs:60-68` — `InferenceType::Update` 调用 `bm25.doc_embed()`
   - `qdrant/src/common/inference/bm25.rs:58-67` — BM25 TF 计算，返回 `VectorPersisted::Sparse`

2. **查询链路**：`InferenceType::Search` 调用 `bm25.search_embed()`，对查询文本分词后生成稀疏查询向量

3. **必须用 Named Vector**：裸 `VectorStruct::Document` 返回 `"should be named"` 错误

4. **配置命名风格确认**：3 个平级 key — `hybridSearchEnabled` / `hybridSearchDenseWeight` / `hybridSearchSparseWeight`

5. **索引字段确认**：BM25 只索引 `codeChunk`，不索引 `filePath`

## 修订记录

### 2026-05-10
**问题：** 原始计划假定 Qdrant "自动对 payload 字段做分词"，实际机制不同。
**修复：** 阅读 Qdrant 源码确认正确方式 — Named Vector 内传 Document 类型。

## 总结

**关键收获：**
- Sparse Vectors 是 Qdrant 内置的 BM25 搜索引擎，无需客户端分词或新增 npm 依赖
- **upsert 时**：传 `{ "bm25": { text: codeChunk, model: "qdrant/bm25" } }` 作为 named vector → Qdrant 自动 BM25 编码
- **search 时**：`prefetch` + `{ query: { text: query, model: "qdrant/bm25" }, using: "bm25" }` → 自动 RRF 融合
- 改动范围 6 个文件，核心在两处：`initialize()` 和 `search()`

**复现验证用例：**
```bash
# 开启 hybrid 搜索后，验证字面量匹配效果
codebase search -f '!*.md' '字面量"Clear index mode"' | grep -E 'results in|^< |File: |Clear index mode'
```

**后续优化方向：**
- 支持 RRF 的 `rank_constant` 参数可配置
- 支持 `explain` 模式查看各子查询贡献
- 支持 linear fusion 作为 RRF 的替代融合策略
