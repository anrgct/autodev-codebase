# 260618-two-hop-multi-hop-qa

## 主题/需求

探索用两跳搜索 + RRF 融合 + QRRanker 重排序来提升 LLM2Vec-Gen (Qwen3-0.6B) 在 Musique 多跳 QA 数据集上的检索召回率。

**背景**：llm2vec 在 Musique 1000 query 上的基线表现为 R@1=20.16%、R@50=70.31%，约 30% gold 文档始终不在 top-200 内。尝试通过搜索策略优化（而非换模型）来提升命中率。

**目标**：
- 实现两跳搜索（第一跳获取上下文 → 扩展 query → 第二跳检索）
- 实现 RRF 融合（融合两跳的文档排名）
- 修复 QRRanker context pool 耗尽 bug
- 在 4-hop 子集（166 query）上对比各策略

## 代码背景

### 涉及文件

| 文件 | 角色 |
|------|------|
| `scripts/hotpotqa-eval.ts` | 评测脚本，新增两跳+RRF 融合逻辑 |
| `scripts/evidence/260618-debug-two-hop-search.ts` | 单 query 调试脚本，可视化两跳过程+RRF 融合 |
| `src/code-index/rerankers/qrranker.ts` | QRRanker reranker，修复 context pool bug |
| `src/code-index/highlighters/qrranker.ts` | QRRanker highlighter，同步修复 |
| `autodev-config.json` | 配置文件，reranker/highlighter 开关 |

### 数据集

- Musique 1000 query，其中：
  - 2hop: 518 个 (51.8%)
  - 3hop: 316 个 (31.6%)
  - 4hop: 166 个 (16.6%)
  - 无 5hop

### 搜索流程

`CodeIndexSearchService.searchIndex()` 的流程：
1. `resolveQueryPrefix()` → 加 instruction prefix
2. `embedder.createEmbeddings()` → query 向量
3. `vectorStore.search()` → dense + BM25 混合搜索
4. `reranker.rerank()` → LLM 重排序（如启用）
5. `highlighter.highlight()` → 行级高亮（如启用）

### 脚本调用示例

**评测脚本**（`scripts/hotpotqa-eval.ts`）：

```bash
# 单跳基线（无 reranker）
npx tsx scripts/hotpotqa-eval.ts \
    --corpus-dir /tmp/musique-corpus \
    --queries ~/workspace/hipporag/reproduce/dataset/musique.json \
    --config autodev-config.json \
    --k-list 1,2,5,10,20,50 \
    --log-level warn

# 两跳 RRF 融合（正文拼接）
npx tsx scripts/hotpotqa-eval.ts \
    --corpus-dir /tmp/musique-corpus \
    --queries ~/workspace/hipporag/reproduce/dataset/musique.json \
    --config autodev-config.json \
    --k-list 1,2,5,10,20,50 \
    --two-hop true \
    --fusion rrf \
    --context-passages 5 \
    --max-passage-chars 500 \
    --log-level warn

# 4-hop 子集评测
python3 -c "
import json
data = json.load(open('~/workspace/hipporag/reproduce/dataset/musique.json'))
hop4 = [q for q in data if q['id'].startswith('4hop')]
json.dump(hop4, open('/tmp/musique-4hop.json', 'w'))
"
npx tsx scripts/hotpotqa-eval.ts \
    --corpus-dir /tmp/musique-corpus \
    --queries /tmp/musique-4hop.json \
    --config autodev-config.json \
    --k-list 1,2,5,10,20,50 \
    --log-level warn
```

**调试脚本**（`scripts/evidence/260618-debug-two-hop-search.ts`）：

```bash
# 单 query 可视化两跳过程
npx tsx scripts/evidence/260618-debug-two-hop-search.ts \
    --corpus-dir /tmp/musique-corpus \
    --queries ~/workspace/hipporag/reproduce/dataset/musique.json \
    --config autodev-config.json \
    --query-id "4hop2__71753_648517_70784_79935" \
    --first-hop-k 20 \
    --context-passages 5 \
    --log-level warn

# 输出包含：第一跳结果、扩展 query（标题/正文）、第二跳结果、RRF 融合排名
```

## 运行现象

### 现象 1：两跳搜索（正文拼接）在全量 10 query 上 R@K 全面下降

```
单跳:      R@1=20.16%, R@10=50.32%, R@50=70.31% (1000q 基线)
两跳(正文): R@1= 9.30%, R@10=48.09%, R@50=65.76% (10q)
```

### 现象 2：两跳搜索（标题拼接）在 10 query 上同样下降

```
两跳(标题): R@1= 7.50%, R@10=26.67%, R@50=50.00% (10q)
```

### 现象 3：QRRanker 启用后大量 batch 失败

```
[QRRanker] Batch failed after 3 attempts: No sequences left
```

所有带 reranker 的 eval 结果 R@K = 0%（gold 被 minScore 过滤）。

### 现象 4：QRRanker 结果不可复现

同一 query 跑 3 次，R@1 在 0%-33% 之间随机跳：

| 次数 | R@1 | R@5 | R@20 |
|------|:----|:----|:-----|
| 第1次 | 0% | 67% | 67% |
| 第2次 | 0% | 33% | 67% |
| 第3次 | 33% | 67% | 67% |

### 现象 5：4-hop 子集（166q）四种配置对比

| Recall@K | 单跳无reranker | 单跳+reranker | 两跳RRF无reranker | 两跳RRF+reranker |
|:---------|:-------------:|:-------------:|:-----------------:|:-----------------:|
| 1 | **8.58%** | 4.37% | 7.98% | 5.17% |
| 5 | **20.33%** | 19.13% | 19.73% | 17.67% |
| 10 | 27.16% | **27.71%** | 26.96% | 24.00% |
| 20 | 38.76% | **39.66%** | 35.59% | 33.68% |
| 50 | 52.56% | 52.56% | **52.86%** | 50.80% |

**耗时**（166 个 4-hop query）：

| 配置 | 耗时 | 每 query |
|------|:-----|:--------|
| 单跳无 reranker | 15s | ~0.1s |
| 两跳 RRF 无 reranker | 2m37s | ~0.9s |
| 单跳 + reranker | 16m34s | ~6.0s |
| 两跳 RRF + reranker | 33m12s | ~12.0s |

## 归因分析

### 两跳搜索为何无效

1. **正文拼接稀释 query 语义**：把 5 段 passage 正文（~2500 字符）拼入 query，LLM2Vec 的 embedding 被正文内容淹没，原始问题语义信号被稀释
2. **标题拼接引入噪声**：第一跳结果中的噪声标题（如"That's What Love Is"）把 query 向量拉向错误方向
3. **RRF 融合的局限**：融合能捞回部分 gold doc（R@50 微升），但代价是 R@1-R@20 精度下降
4. **根本瓶颈**：~48% 的 4-hop gold doc 的 embedding 本身就差，改变查询向量无法改善

### Reranker 为何拉低 R@1

逐 query 分析（166 个 4-hop，R@1 维度）：

```
reranker 帮了: 13 个 query（0% → 25%）
reranker 害了: 40 个 query（25% → 0%）
没变化:       113 个 query
```

Reranker 害的 query 是帮的 3 倍。原因：QRRanker (MiniCPM-V-4.6) 是 VLM，不是专业 reranker，对复杂 4-hop query 的 attention 排序噪声大。

### QRRanker context pool 耗尽原因

`LlamaContext.getSequence()` 每次调用分配**新** sequence（不是复用）。context 用 `sequences: 1` 创建，只有 1 个 slot。第一个 batch 用完后，后续 batch `getSequence()` 抛 "No sequences left"。

### QRRanker 结果不可复现原因

`sequence.evaluate(tokens, { temperature: 0.6 })` 使用随机采样。每次 decode 产生不同的 attention pattern → 不同的 reranker 分数 → 不同的排序。

## 关键决策

### 决策 1：两跳搜索方向放弃

**理由**：166 个 4-hop query 实测，两跳 RRF 融合在所有 R@K 上均不超过单跳基线。单 query debug 中看到的改善（如 3/4 → 2/4）是个案，整体互相抵消。

### 决策 2：QRRanker context pool 修复保留

**理由**：虽然 reranker 对 4-hop 整体效果为负，但 context pool 耗尽是实打实的 bug，影响所有使用 pooled context 的场景。修复有价值。

### 决策 3：QRRanker temperature 改为 0（greedy）

**理由**：temperature 0.6 导致结果不可复现，所有带 reranker 的 eval 数据不可信。改为 0 后 3 次运行完全一致。

### 决策 4：后续方向转向换更大的 embedder 模型

**理由**：所有搜索策略（两跳、RRF、reranker）都无法突破 ~52% 的 R@50 天花板。瓶颈是 0.6B 模型的 embedding 质量，不是搜索策略。

## 实施计划

- [x] 实现两跳搜索（正文拼接 + 标题拼接）
- [x] 实现 RRF 融合
- [x] 创建单 query 调试脚本
- [x] 修复 QRRanker context pool bug
- [x] 修复 QRRanker temperature 随机性
- [x] 4-hop 子集（166q）四种配置对比
- [x] 记录探索结论

## 实施记录

### 2026-06-18

1. **两跳搜索实现**（`scripts/hotpotqa-eval.ts`）：
   - 新增 `TwoHopOptions` 接口：`firstHopK`, `contextPassages`, `maxPassageChars`, `fusion`
   - `evaluateQueryTwoHop()`：第一跳检索 → 取 top-N passage 正文 → 拼接扩展 query → 第二跳检索
   - RRF 融合：`buildDocRanks()` 构建文档级排名 → `1/(60+rank)` 融合
   - CLI 参数：`--two-hop`, `--fusion rrf`, `--context-passages`, `--max-passage-chars`

2. **调试脚本**（`scripts/debug-two-hop.ts`）：
   - 可视化第一跳/第二跳结果
   - 方案 A（标题拼接）vs 方案 B（正文拼接）对比
   - RRF 融合（标题）vs RRF 融合（正文）对比

3. **QRRanker context pool 修复**（`src/code-index/rerankers/qrranker.ts`）：
   - `_runQrPass()` 末尾加 `sequence.clearHistory()` + `sequence.dispose()`
   - `_collectDecodeStageAttention()` 末尾加 `gen.return(undefined)` 关闭 async generator
   - 同步修复 `src/code-index/highlighters/qrranker.ts`

4. **QRRanker temperature 修复**：
   - `sequence.evaluate(tokens, { temperature: 0.6 })` → `{ temperature: 0 }`

5. **评测结果**：
   - 全量 10 query 两跳(正文)：R@1=9.30%，全面差于单跳基线
   - 4-hop 166 query 四种配置：单跳无 reranker 最优（R@1=8.58%, R@50=52.56%）
   - Reranker 逐 query 分析：帮 13 个、害 40 个、持平 113 个

## 修订记录

### 2026-06-18（两跳正文拼接方案修订）

**问题**：首轮两跳用 passage 正文拼接，全量 10 query R@1 从 20.16% 降到 9.30%。

**尝试**：改为标题拼接（`query + "\nRelated: title1, title2, ..."`），但 4-hop 166q 实测 RRF 融合仍不超过单跳基线。

**结论**：两跳方向放弃，瓶颈在 embedding 模型而非搜索策略。

### 2026-06-18（QRRanker context pool bug）

**问题**：reranker 启用后所有 batch 报 "No sequences left"，R@K 全 0。

**根因**：`getSequence()` 每次分配新 sequence，`sequences: 1` 的 context 只有 1 个 slot，用完不释放。

**修复**：`_runQrPass()` 末尾加 `sequence.dispose()` 释放 slot 回 pool。

### 2026-06-18（QRRanker 随机性）

**问题**：同一 query 跑 3 次 R@1 在 0%-33% 之间跳，eval 结果不可复现。

**根因**：`temperature: 0.6` 随机采样。

**修复**：改为 `temperature: 0`（greedy），3 次运行完全一致。

## 总结

### 关键收获

1. **两跳搜索对弱 embedding 模型无效**：LLM2Vec-Gen (0.6B) 的 embedding 质量是瓶颈，不是搜索策略。改变查询向量（正文拼接/标题拼接/RRF 融合）无法救回 embedding 本身就差的 gold 文档。
2. **RRF 融合的价值有限**：融合能捞回部分两跳独有的 gold doc（R@50 微升 +0.3%），但代价是 R@1-R@20 精度下降（-0.6%~-3.2%）。
3. **VLM 不适合做 reranker**：MiniCPM-V-4.6 的 attention pattern 对文本检索任务噪声大，166 个 4-hop query 中帮 13 个害 40 个。
4. **QRRanker 有两个 bug**：context pool 不释放 sequence（`dispose()` 修复）、decode temperature 随机（改为 greedy 修复）。
5. **Musique 跳数分布**：2hop 51.8%、3hop 31.6%、4hop 16.6%，无 5hop。4-hop 最难，R@50 天花板 ~52%。

### 后续优化

- [ ] 换更大的 embedder（1.5B/7B LLM2Vec 或专用 embedding 模型）突破 ~52% R@50 天花板
- [ ] 换专业 reranker 模型（如 Qwen3-Reranker-0.6B）替代 VLM
- [ ] 试 recon-only embedding（probe 实测区分度最高 off-diag 0.077 vs 0.152）
- [ ] QRRanker temperature 改回可配置（当前硬编码 0）
