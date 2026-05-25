# 250511-gguf-mlx-embed-quality-gap

## 主题/需求

同一个 Jina embedding 模型 (`jina-embeddings-v5-text-nano-retrieval`, 均为 FP16)，通过两种路径嵌入：

| 路径 | 实现 | 结果 |
|------|------|------|
| **MLX** (jina-grep 服务器, port 8089) | `JinaEmbedder` → HTTP → MLX 推理 | Recall@1=100%, MRR=1.0 |
| **GGUF** (node-llama-cpp) | `LlamaCppEmbedder` → 本地推理 | Recall@1=**58.3%**, MRR=0.69 |

目标：找出 GGUF 路径质量差的根因并修复至 MLX 同等水平。

## 代码背景

### 嵌入调用链路

```
查询时:
  search-service.CodeIndexSearchService.searchIndex:54-65
    → configManager.currentModelId              # 断点①: LlamaCPP 返回 undefined
    → getDefaultModelId(provider)               # 断点②: 无 llamacpp case
    → getModelQueryPrefix(provider, modelId)    # 断点③: modelId 不含 jina-embeddings-v5
    → embedder.createEmbeddings([prefillQuery])

索引时:
  resolve-document-prefix.resolveDocumentPrefix  # ✅ 直接从 embedder.modelPath 取值
    → LlamaCppEmbedder.modelPath                 # 含 jina-embeddings-v5 → 返回 "Document: "
    → scanner.DirectoryScanner.itemToText       # 生成 "Document: File: model.py\n..."
```

### MLX 服务器路径

```
JinaEmbedder.createEmbeddings → POST /v1/embeddings {model, input}
  → jina-grep server.py → multi_model.switch_task("retrieval")
  → multi_model.encode(texts, task_type="retrieval.query")
  → 内部自动包装 "Query: {text}" prompt template
```

### 关键差异

```
MLX:  query → retrieval.query → 内部 prompt template → L2 归一化向量
      doc  → retrieval.query → 内部 prompt template → L2 归一化向量  ← 对称!

GGUF: query → getEmbeddingFor(raw_text)              → 原始向量  ← 无前缀!
      doc   → getEmbeddingFor("Document: " + text)    → 原始向量  ← 不对称!
```

### 相关文件

| 文件 | 用途 |
|------|------|
| `src/code-index/search-service.ts` (search-service.CodeIndexSearchService.searchIndex:48-65) | 查询嵌入流程，调用 `getModelQueryPrefix` |
| `src/code-index/config-manager.ts` (config-manager.CodeIndexConfigManager.currentModelId:415-421) | `currentModelId` getter，LlamaCPP 返回 undefined |
| `src/shared/embeddingModels.ts` (embeddingModels.getModelQueryPrefix:154-161) | `"Query: "` 前缀判断 |
| `src/shared/embeddingModels.ts` (embeddingModels.getModelDocumentPrefix:170-186) | `"Document: "` → 改为 `"Query: "` |
| `src/shared/embeddingModels.ts` (embeddingModels.getDefaultModelId:103-149) | fallback 无 llamacpp case |
| `src/code-index/shared/resolve-document-prefix.ts` (resolve-document-prefix.resolveDocumentPrefix) | 索引前缀解析 |
| `src/code-index/embedders/llamacpp.ts` (llamacpp.LlamaCppEmbedder.createEmbeddings:47-62) | GGUF 嵌入实现，添加 L2 归一化 |
| `src/code-index/embedders/jina-embedder.ts` (jina-embedder.JinaEmbedder._embedBatchWithRetries:129-157) | MLX HTTP 调用，仅传 `{model, input}` |
| `jina-grep-cli/jina_grep/server.py` (server.create_embeddings:61-110) | 服务器端默认 `prompt_name="query"` |
| `jina-grep-cli/jina_grep/embedder.py` (embedder.LocalEmbedder.embed:138-172) | MLX 本地调用 `multi_model.encode(task_type)` |

### 诊断脚本

| 文件 | 用途 |
|------|------|
| `src/examples/embed-compare.ts` | v1: 原始 MLX vs GGUF 对比，发现 query 嵌入正交 |
| `src/examples/embed-compare-v2.ts` | v2: 验证 `"Query: "` 前缀 → MLX 完全一致 (cos=1.0) |
| `src/examples/embed-compare-v3.ts` | v3: 对称 vs 不对称 prompt 策略对比 |

## 关键决策

### 1. Prompt Template 等价性验证

实验证实 MLX 的 `retrieval.query` 内部模板等价于文本前缀 `"Query: "`：

```
                     cos w/ MLX Q1  cos w/ MLX Q2  cos w/ MLX Q3
raw (无prefix)            0.0398         0.1199         0.8946
"Query: " prefix          1.0000         1.0000         0.9999   ← 完美匹配!
```

**决策**: 用 `"Query: "` 文本前缀模拟 MLX prompt template，无需深入到 node-llama-cpp 内部。

### 2. 对称 vs 不对称 Prompt

| 策略 | Query | Document | Recall@1 (简化) | Recall@1 (真实) |
|------|-------|----------|-----------------|-----------------|
| MLX 对称 | retrieval.query | retrieval.query | 91.7% | 100% |
| GGUF 不对称 | "Query: " | "Document: " | 100% | 83.3% |
| GGUF 对称 | "Query: " | "Query: " | 91.7% | **100%** ✅ |

简化测试中不对称策略 Recall@1=100%（12 个 doc 小搜索空间），但真实索引中不对称仅 83.3%，对称 100%。

**翻车分析**：不对称策略下两个用例降到 #3，都是边缘浮动（与 Top-1 差距 <0.015）：

| 用例 | 预期目标 | 不对称排名 | 被谁超过 | 原因 |
|:----:|---------|:---------:|---------|------|
| #4 train | `train: attempt_load_one_weight` | #3 | `_load`、`load`（均含 `weights` 关键词） | 不对称把 keyword 权重拉高，swap 了语义排位 |
| #10 embed | `embed: second-to-last layer` | #3 | `transforms`、配置等无关片段 | 分差仅 0.005，纯噪声级浮动 |

**本质原因**：不对称策略（query=`"Query: "`, doc=`"Document: "`）让 query 和 doc 分布在不同的语义空间中。在小搜索空间（12 个 doc）中对角线信号足够强，但在大搜索空间（完整代码库）中，所有 doc 都在 `"Document: "` 空间里，query 与 doc 的相似度排序受前缀差异影响产生微小扰动，边缘案例因此翻车。对称策略则将 query 和 doc 放在同一参考系中，排序稳定性更高。

**决策**: 采用对称策略，索引和查询都用 `"Query: "` 前缀，与 MLX 行为完全对齐。Jina v5 虽然设计为不对称，但对称策略在真实搜索中表现更好。

### 3. L2 归一化

GGUF 输出范数 ~88-113，MLX 输出范数 ~1.0。Qdrant 使用 Cosine 距离时内部归一化，因此显式 L2 归一化对结果无影响（保留无害）。

## 实施计划

- [x] 步骤 1: 编写诊断脚本，确认 MLX 和 GGUF 嵌入差异的具体表现
- [x] 步骤 2: 验证 prompt template → `"Query: "` 前缀的等价性
- [x] 步骤 3: 修复 `currentModelId` 对 llamacpp 的支持
- [x] 步骤 4: 添加 `getDefaultModelId` 的 llamacpp case
- [x] 步骤 5: 统一索引用 `"Query: "` 替代 `"Document: "`
- [x] 步骤 6: 添加 L2 归一化（无害保留）
- [x] 步骤 7: 更新测试
- [x] 步骤 8: 重建索引并验证 Recall@1=100%

## 实施记录

### 2026-05-11

**诊断阶段 (embed-compare.ts → embed-compare-v2.ts)**

编写 3 版诊断脚本，逐步定位问题：

1. **v1**: 直接对比 MLX vs GGUF 查询嵌入，发现 cross-sim 仅 0.04（正交），文档嵌入 cross-sim 0.98（一致）
2. **v2**: 测试多种 GGUF prefix，发现 `"Query: "` 前缀使 MLX-GGUF cross-sim 达到 1.0000
3. **v3**: 对比 4 种 prompt 策略（MLX 对称/不对称, GGUF 对称/不对称），用 12 个测试用例的简化文本评估

**修复阶段**

追踪 `search-service.ts` 前缀添加链路：

```
modelId = currentModelId ?? getDefaultModelId("llamacpp")
       = undefined        ?? "text-embedding-3-small"    ← 两处都错!
```

- **断点①** (`config-manager.ts:415`): `currentModelId` 只读 `embedderModelId`，LlamaCPP 用 `embedderLlamaCppModelPath`
- **断点②** (`embeddingModels.ts:103`): `getDefaultModelId` switch 无 `"llamacpp"` case，fallback 到 `"text-embedding-3-small"`
- **断点③** (`embeddingModels.ts:157`): `getModelQueryPrefix` 判断 `modelId.includes("jina-embeddings-v5")` → 对 `"text-embedding-3-small"` 为 false

**索引 prompt 不对称问题**

`resolveDocumentPrefix` 返回 `"Document: "`（与查询的 `"Query: "` 不对称），但 MLX 路径下两者都是 `retrieval.query`（对称）。
改为对称 `"Query: "` 后 Recall@1 从 83.3% → 100%。

## 修订记录

### 2026-05-11

**问题**: `eval_search.py` 中 GGUF 路径 Recall@1 仅 58.3%，#2 (is_triton_model) 和 #8 (_reset_ckpt_args) 完全未命中。

**修复**: 
1. `config-manager.ts` (config-manager.CodeIndexConfigManager.currentModelId:415-421) — llamacpp 时返回 `embedderLlamaCppModelPath`
2. `embeddingModels.ts` (embeddingModels.getDefaultModelId:137-145) — 添加 `case "llamacpp"`
3. `embeddingModels.ts` (embeddingModels.getModelDocumentPrefix:175-180) — 返回 `"Query: "` 而非 `"Document: "`
4. `embedders/llamacpp.ts` (llamacpp.LlamaCppEmbedder.createEmbeddings:49-58) — 添加 L2 归一化
5. `embeddingModels.prefix.test.ts` — 更新测试断言

**结果**: Recall@1 从 58.3% → 100%，MRR 从 0.6944 → 1.0000，与 MLX 完全一致。

## 总结

### 核心教训

**Jina v5 模型的 prompt template 不是可选的。** MLX 服务器内部自动包装，GGUF 路径需要手动实现。遗漏任何一个方向的 prompt 都会导致嵌入空间错位。

```
node-llama-cpp 的 getEmbeddingFor() 做 3 件事: tokenize → forward → pool
                                不做: prompt wrapping, L2 normalize
                                         ↑ 这两个必须由调用方处理
```

### 排查方法论

1. **向量级别对比**优于搜索评估：直接算 cross-similarity 比跑 e2e eval 更快定位根因
2. **文档和查询分开对比**：文档 cross-sim=0.98 说明模型权重正确，查询 cross-sim=0.04 说明调用方式错误
3. **交叉相似度矩阵**：一眼看出哪些用例区分度不足

### 后续

- `resolveDocumentPrefix` 当前对 llama+jina 返回 `"Query: "`，如果将来需要支持真正的不对称 prompt（query/passage），需要引入 `prompt_name` 参数区分索引和搜索场景
