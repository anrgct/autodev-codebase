# 260618-two-hop-multi-hop-qa

## 主题/需求

探索用两跳搜索 + RRF 融合 + QRRanker 重排序来提升 LLM2Vec-Gen (Qwen3-0.6B) 在 Musique 多跳 QA 数据集上的检索召回率。

**背景**：llm2vec 在 Musique 1000 query 上的基线表现为 R@1=20.16%、R@50=70.31%，约 30% gold 文档始终不在 top-200 内。尝试通过搜索策略优化（而非换模型）来提升命中率。

**目标**：
- 实现两跳搜索（第一跳获取上下文 → 扩展 query → 第二跳检索）
- 实现 RRF 融合（融合两跳的文档排名）
- 修复 QRRanker context pool 耗尽 bug
- 在 4-hop 子集（166 query）上对比各策略
- 用 4B 模型验证瓶颈归属（embedding 质量 vs 多跳策略）

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

### 现象 5：4-hop 子集（166q）四种配置对比（Qwen3-0.6B）

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

### 现象 6：4B 模型（Qwen3-4B）单跳 vs 两跳（4-hop 166q）

| Recall@K | 0.6B 单跳 | 0.6B 两跳RRF | 4B 单跳 | 4B 两跳RRF |
|:---------|:---------:|:------------:|:-------:|:----------:|
| 1 | 8.58% | 7.98% | **9.79%** | 8.68% |
| 5 | 20.33% | 19.73% | **24.45%** | 23.39% |
| 10 | 27.16% | 26.96% | **32.08%** | 30.77% |
| 20 | 38.76% | 35.59% | **40.96%** | 41.52% |
| 50 | 52.56% | 52.86% | **55.42%** | 50.65% |

**关键发现**：
- 4B 单跳全面优于 0.6B 单跳，R@10 提升最显著（+4.92%）
- **4B 两跳 RRF 仍然不如 4B 单跳**——换大模型也没让两跳变有效
- 两跳的 R@50 在 4B 上甚至低于单跳（50.65% vs 55.42%），与 0.6B 规律相反
- R@50 从 52.56%→55.42%，+2.86%——7倍参数仅带来这点提升，说明未命中的 ~44.6% gold doc 不是 embedding 质量问题

## 归因分析

### 两跳搜索为何无效

1. **正文拼接稀释 query 语义**：把 5 段 passage 正文（~2500 字符）拼入 query，LLM2Vec 的 embedding 被正文内容淹没，原始问题语义信号被稀释
2. **标题拼接引入噪声**：第一跳结果中的噪声标题（如"That's What Love Is"）把 query 向量拉向错误方向
3. **RRF 融合的局限**：融合能捞回部分 gold doc（R@50 微升），但代价是 R@1-R@20 精度下降
4. **根本瓶颈在多跳策略本身**：4B 模型按说 embedding 质量更好，但两跳 RRF 依然不如单跳。~44.6% 的 4-hop gold doc 即使换大模型也捞不到 top-50，问题不在 embedding 质量，而是 Musique 的 4-hop query 两跳拆解本身就不可靠——第一跳的噪声标题/正文污染了第二跳 query，而 multi-vector 查询（每段上下文各搜一次再融合）是唯一可能的方向

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

**理由**：166 个 4-hop query 实测，两跳 RRF 融合在 0.6B 和 4B 模型上均不超过同模型单跳基线。4B 结果确认了瓶颈不在 embedding 质量（7 倍参数的 4B 两跳依然不如 4B 单跳），而在多跳策略本身的 query 拆解方式——正文/标题拼接 + RRF 融合这条路走不通。

### 决策 2：QRRanker context pool 修复保留

**理由**：虽然 reranker 对 4-hop 整体效果为负，但 context pool 耗尽是实打实的 bug，影响所有使用 pooled context 的场景。修复有价值。

### 决策 3：QRRanker temperature 改为 0（greedy）

**理由**：temperature 0.6 导致结果不可复现，所有带 reranker 的 eval 数据不可信。改为 0 后 3 次运行完全一致。

### 决策 4：两跳策略需要换个思路

**理由**：原先认为瓶颈是 0.6B 模型 embedding 质量不够，但 4B 结果（R@50 从 52.56%→55.42%，仅 +2.86%）否定了这个判断。两跳 RRF 在 4B 上依然不如单跳，说明问题的根因是两跳策略本身（query 扩展方式、RRF 融合方式），而非 embedding 模型大小。后续应探索 multi-vector 查询（每段上下文独立检索再融合）或基于 LLM 的 query decomposition，而非单纯换更大的 embedder。

## 实施计划

- [x] 实现两跳搜索（正文拼接 + 标题拼接）
- [x] 实现 RRF 融合
- [x] 创建单 query 调试脚本
- [x] 修复 QRRanker context pool bug
- [x] 修复 QRRanker temperature 随机性
- [x] 4-hop 子集（166q）四种配置对比
- [x] 4B 模型对比验证（单跳 vs 两跳）
- [x] 归因修正（瓶颈在多跳策略而非 embedding 质量）
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
   - 4-hop 166 query 四种配置（0.6B）：单跳无 reranker 最优（R@1=8.58%, R@50=52.56%）
   - Reranker 逐 query 分析：帮 13 个、害 40 个、持平 113 个

### 2026-06-24

1. **4B 模型评测**（Qwen3-4B，4-hop 166q）：
   - 单跳无 reranker：R@1=9.79%, R@5=24.45%, R@10=32.08%, R@20=40.96%, R@50=55.42%
   - 两跳 RRF 无 reranker：R@1=8.68%, R@5=23.39%, R@10=30.77%, R@20=41.52%, R@50=50.65%
   - 4B 单跳全面优于 0.6B 单跳（R@10 +4.92%），但 R@50 仅 +2.86%（52.56%→55.42%）
   - **两跳 RRF 在 4B 上仍然不如单跳**，确认问题不在 embedding 质量而在多跳策略本身

2. **关键归因修正**：
   - 原认为 ~48% gold doc 捞不到是因为 0.6B embedding 质量差
   - 4B 实测仍有 ~44.6% gold doc 不在 top-50，说明不是 embedding 问题
   - 根本瓶颈：两跳的 query 扩展方式（正文/标题拼接）对 4-hop 无效，多跳策略的拆解方式才是瓶颈

3. **`scripts/prepare-corpus.py` 修复**：
   - 增加 `.gitignore` 排除 `.metadata.json`，避免被 codebase 索引引擎误扫

4. **`src/code-index/embedders/llamacpp-llm2vec.ts` 修复**：
   - `DIM=1024` 硬编码改为 `EMB_DIM=this._ab.length` + `HIDDEN_DIM=this._rb.length` 动态推导
   - 修复前 4B/8B 模型因 alignment_mlp shape 不匹配（2560×1024 vs 1024×1024）报 `Unexpected alignment_mlp shape`

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

### 2026-06-24（4B 模型评测 + 归因修正）

**新数据**：Qwen3-4B 在 4-hop 166q 上跑了两跳 RRF 和单跳。

**结果**：4B 单跳 R@50=55.42%（vs 0.6B 的 52.56%），但两跳 RRF 仍然不如单跳。

**归因修正**：
- 原结论：瓶颈在 0.6B 的 embedding 质量，换大模型能突破
- 新结论：瓶颈在多跳策略本身（query 扩展方式和融合策略），不是 embedding 质量
  - 证据：7 倍参数（0.6B→4B）只涨 2.86% R@50，且两跳在 4B 上依然无效
  - ~44.6% gold doc 连 4B+全量索引都捞不到 top-50

**文档修复**：
- `scripts/prepare-corpus.py` 增加 `.gitignore` 排除 `.metadata.json`
- `src/code-index/embedders/llamacpp-llm2vec.ts` 修复 `DIM=1024` 硬编码，支持 4B/8B 模型

## 总结

### 关键收获

1. **两跳搜索（正文/标题拼接+RRF融合）无效，根因在多跳策略本身**：0.6B 和 4B 模型上两跳 RRF 均不如单跳。4B 结果排除了 embedding 质量假说——7 倍参数只带来 R@50 +2.86%，且两跳在 4B 上仍然不如单跳。~44.6% 的 4-hop gold doc 换大模型也捞不到，问题出在 query 扩展方式和融合策略。
2. **RRF 融合的价值有限**：融合能捞回部分两跳独有的 gold doc（R@50 微升 +0.3% on 0.6B），但代价是 R@1-R@20 精度下降（-0.6%~-3.2%）。
3. **VLM 不适合做 reranker**：MiniCPM-V-4.6 的 attention pattern 对文本检索任务噪声大，166 个 4-hop query 中帮 13 个害 40 个。
4. **QRRanker 有两个 bug**：context pool 不释放 sequence（`dispose()` 修复）、decode temperature 随机（改为 greedy 修复）。
5. **Musique 跳数分布**：2hop 51.8%、3hop 31.6%、4hop 16.6%，无 5hop。4-hop 最难，0.6B R@50 天花板 ~52%，4B 提升至 ~55%。

### 后续优化

- [ ] **尝试 multi-vector 查询**：第一跳获取的每段上下文独立作为 query 检索（而非拼接），再 RRF 融合所有结果。避免正文/标题拼接的噪声污染问题
- [ ] **基于 LLM 的 query decomposition**：用 LLM 把 4-hop 问题拆成 4 个单跳子问题，逐个搜索再 fusion（而非两跳压缩）
- [ ] 换更大的 embedder（如 8B 或专用 embedding 模型），验证 R@50 天花板能拉到多少
- [ ] 换专业 reranker 模型（如 Qwen3-Reranker-0.6B）替代 VLM
- [ ] 试 recon-only embedding（probe 实测区分度最高 off-diag 0.077 vs 0.152）
