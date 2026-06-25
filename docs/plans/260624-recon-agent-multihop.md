# 260624-recon-agent-multihop

## 主题/需求

用 **recon 向量链递归多跳检索**提升 Musique 多跳 QA 的召回率，替代之前失败的正文/标题拼接 + RRF 方案。

**核心思路**：把每跳产生的 reconstruction 向量（recon）拼接成"推理记忆链"，配合 query、本跳新检索到的线索，通过 embd 注入 forward 生成下一跳的 recon——让 transformer 的 attention 主动融合历史推理 + query + 新线索，而非被动拼接正文。

```
[recon×10@1] + ... + [recon×10@n-1] + [query] + [新出现的answer] + [prompt] + [question×10]
  → embd 注入 forward → question token 位置 hidden state → recon_mlp → [recon×10@n]
```

每跳的 `[recon×10@n]` 同时是：① 下一跳的历史链前缀；② 经 align_mlp 后的检索向量。检索结果去重后只把"新出现的文档"回传下一跳（避免重复信息稀释）。

**背景**：
- `260618-two-hop-multi-hop-qa.md` 的正文/标题拼接 + RRF 在 0.6B/4B 上均不如单跳（噪声污染）。
- `260624-node-llama-cpp-embd-injection.md` 给 node-llama-cpp 打了 embd 注入补丁（`initBatchEmbd`/`addToBatchEmbd`/`getTokenEmbeddings`），并实现 `generateWithPrompt`（recon + prompt 混合注入 → decoder 续写）。本任务在此基础上展开。

**目标**：
- 实现 `reconForward`（recon 向量链 embd 注入 forward → 新 recon + 检索向量）
- 实现递归多跳 loop（recon 历史累积 + 新线索去重回传）
- 在 4-hop 最差 20 题上验证召回提升
- 对比融合策略（RRF / BestRank / 最后一跳）

## 代码背景

### 涉及文件

| 文件 | 角色 |
|------|------|
| `src/code-index/embedders/llamacpp-llm2vec.ts` | 核心：新增 `reconForward`（向量链 forward）；修复 `generateWithPrompt`（注入 query + context） |
| `scripts/evidence/260624-recon-multihop-eval.ts` | recon 向量链递归多跳评测（单跳/RRF/BestRank 对比 + 每跳趋势） |
| `scripts/evidence/260624-recon-multihop-debug.ts` | 单题精细分析（每跳检索结果标注 GOLD/NEW + 新文档内容） |
| `data/musique-4hop-worst20.json` | 最差 20 题（4-hop, R@50≤0.25），验证用 |
| `docs/plans/260624-node-llama-cpp-embd-injection.md` | embd 注入补丁 + generateWithPrompt 的前置任务 |

### 关键技术细节

**`reconForward`**（`llamacpp-llm2vec.ts`，核心方法）：

```typescript
async reconForward(
  reconHistory: number[][][],  // 历史 recon 链，每个 [10, dim]（首跳传 []）
  queryText: string,
  newAnswerText: string,       // 本跳新出现的检索结果文本（去重后；首跳传 ""）
  prompt: string,              // 推理引导（首跳传 ""）
): Promise<{ newRecon: number[][]; embedding: number[] }>
```

流程：
1. query / answer / prompt / question tokens → `getTokenEmbeddings` 查表成 embd
2. 拼成 `[recon历史链] + [query] + [answer] + [prompt] + [question×10]`（causal attention 下 question tokens 能 attend 全部前缀）
3. embedding context 的 addon context 上：`clearAccumulatedEmbeddings` + `disposeSequence(0)` + `initBatchEmbd` + `addToBatchEmbd` + `decodeBatch`
4. `getEmbedding(questionStart+1..total)` 取 question token 位置的 hidden state
5. 逐 token `recon_mlp` → `newRecon[10, dim]`（加入历史链）
6. mean pool → `recon_mlp` → `align_mlp` → L2 normalize → 检索 `embedding`

**机制可行性验证**（`260624-recon-forward-smoke.ts`，已删）：embd 注入 forward 后 `getEmbedding` 取的 hidden state 与 token 路径 `getEmbeddingsForTokens` 完全一致，`max|Δ| = 0.000e+0`（15360 个值）。这证明了"embd 注入 forward + getEmbedding 取 hidden state"可行。

**embedding context 的 addon context**：`LlamaEmbeddingContext` 内部用 `this._llamaContext._ctx.getEmbedding(i)` 取每个 token 的 hidden state（`vendor/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js:49/98`）。这个 addon context 就是打了 embd 注入补丁的同一个 AddonContext，因此同时支持 `initBatchEmbd`/`addToBatchEmbd`（注入）和 `getEmbedding`（取 hidden state）。

**`generateWithPrompt` 的修复**：原 embd-injection 任务实现的版本只注入 `[recon×10 + prompt_embd]`，**没有注入 query 文本**（见下方归因分析）。本任务修复为 `[recon×10 + query_embd + prompt_embd]`，并加 `context` 参数让 recon 从 `query + context` 计算。布局：`[recon(query+context)×10] + [query_embd] + [prompt_embd]` → decoder 续写。

### 数据

- 最差 20 题（4-hop，单跳 R@50≤0.25），3 类 pattern：
  - 佐治亚州/南卡州地理链（11/20）：county→city→state→border
  - 缅甸地理链（3/20）：Myanmar→That Dam→Mekong
  - 宗教改革（3/20）：Reformation→Wittenberg→Mary
- 模型：Qwen3-4B-LLM2Vec-unified Q8_0（`autodev-config.json` 的 `embedderGgufLlm2vecPath`）
- 索引：`/tmp/musique-corpus`（Musique 9838 文档，4B 索引，⚠️ 索引耗时 30 分钟，不可删）

> **数据文件说明**：仓库只提交 id 列表（`data/musique-4hop-worst20.ids.txt` 20 条 / `data/musique-4hop.ids.txt` 166 条）。完整 json（含原文段落、体积大、衍生自 Musique）不入库（`.gitignore` 忽略 `/data/*.json`）。复现时用 id 列表从原始 `musique.json` 重建子集（见「使用命令」步骤 0）。worst20 的 id 值与原始数据的 `id` 字段一致，直接按 `id` 过滤即可。

## 运行现象

### 现象 1：`generateWithPrompt` 原设计没注入 query，decoder 瞎猜

原 `generateWithPrompt` 只注入 `[recon×10 + prompt_embd]`，decoder 收不到原始 query 文本。对最差 20 题生成扩展文本：

| 路径 | gold 关键词命中题数 | 精确 gold 实体命中 |
|------|:------------------:|:----------------:|
| `generateWithPrompt`（无 query） | 5/20 (25%) | **0/20 (0%)** |
| 纯 free-running（纯 recon） | 4/20 (20%) | 0/20 (0%) |

"命中"全是通用词噪声（`carolina`/`united`/`states`/`that`），无任何生成文本包含真正的 gold 实体（`Georgia`/`Myanmar`/`Wittenberg` 等）。生成内容是模型自由联想（`North Carolina`/`Nile River`），与 query 脱钩。

### 现象 2：标准 completion 喂 query 能正确推理（对照组）

用 `completeWithText`（token 路径，query+prompt 直接喂 decoder）对照：

| 题 | 标准 completion（喂 query） | generateWithPrompt（无 query） |
|----|----------------------------|------------------------------|
| 缅甸题 | `"school system, country, natural boundary, tournament, Dam. To solve this question, I need to identify..."` ✅ | `"Nile River, Sudan, Egypt"` ❌ |
| 南卡题 | `"Thomas Tucker, state capital, county... Let's break it down."` ✅ | `"North Carolina, South Carolina"` ❌ |

模型完全有推理能力——喂 query 时能正确提取关键实体并开始多跳推理。`generateWithPrompt` 质量差的唯一原因是 **decoder 没读到题目**。

### 现象 3：recon 自投影几乎不携带 query 之外的信息

修正 `generateWithPrompt` 注入 query 后（`[recon + query + prompt]`），对比标准 completion（纯 query+prompt token，无 recon）：

| 路径 | 命中题数 | 关键词命中数 |
|------|:-------:|:----------:|
| A. 标准 completion（无 recon） | 18/20 | 30 |
| B. generateWithPrompt（recon + query） | 18/20 | 33 |

recon 作为额外软提示只带来 **+3 关键词**（30→33），命中题数完全一样。因为 recon 来自 query 自身的 hidden state 投影，没有引入检索结果等 query 之外的信息。

### 现象 4：worst20（最难题）上有提升，但完整 166 题上几乎无效

**worst20（最差 20 题，单跳 R@50=11.25%）hops=2**：

| Recall@K | 单跳 baseline | 多跳 RRF | 多跳 BestRank |
|:---------|:------------:|:--------:|:-------------:|
| 5  | 0.00% | 1.25% | 1.25% |
| 10 | 0.00% | 2.50% | 2.50% |
| 20 | 3.75% | 6.25% | 6.25% |
| 50 | **11.25%** | **18.75%** | **18.75%** |

worst20 上 R@50 +67%，看似显著。但 worst20 是**专门挑选的单跳完全失败的题**（gold 不在 top50），属选择性偏差。

**完整 4-hop 166 题 hops=2**（关键验证，耗时 557s）：

| Recall@K | 单跳 baseline | 多跳 RRF | 多跳 BestRank |
|:---------|:------------:|:--------:|:-------------:|
| 1  | **9.64%** | 9.19% | 9.64% |
| 5  | 23.95% | 22.89% | 24.55% |
| 10 | **31.48%** | 30.27% | 30.57% |
| 20 | 40.36% | 39.01% | 40.51% |
| 50 | 54.52% | 54.52% | **54.67%** |

**完整 166 题上多跳几乎没有提升**（R@50 仅 +0.15%），R@10/20 甚至略降。worst20 的 +67% **不能推广**到完整数据集。

### 现象 4b：0.6B 在 166 题上补齐 2×2 矩阵——模型越小，多跳稀释伤害越重

后续用 0.6B 在另一个索引（`/tmp/musique-corpus2`）上重跑完整 166 题 hops=2，补齐了此前缺失的“0.6B × 多跳”象限（原本只有 0.6B 单跳 + 4B 多跳）。

**0.6B 完整 4-hop 166 题 hops=2**（`corpus2`，耗时 139.9s）：

| Recall@K | 单跳 baseline | 多跳 RRF | 多跳 BestRank |
|:---------|:------------:|:--------:|:-------------:|
| 1  | 9.19% | 8.28% | 9.19% |
| 5  | 21.23% | 20.33% | 19.58% |
| 10 | 26.51% | 26.05% | 24.85% |
| 20 | 35.84% | 35.09% | 31.02% |
| 50 | 48.49% | 45.93% | 46.54% |

hop 分解：hop0 R@50=48.34%（avg 50.0 new docs）→ hop1 R@50=42.77%（avg 18.6 new docs）。

**0.6B vs 4B 的 2×2 矩阵（R@50）**：

| | 单跳 | 多跳 RRF | 多跳相对单跳 |
|--|:----:|:--------:|:----------:|
| 0.6B（corpus2） | 48.49% | 45.93% | **−2.56%** |
| 4B（corpus） | 54.52% | 54.52% | 0% |

**稀释幅度随模型变小而加重**（hop1 相对 hop0 的 R@50 跌幅）：

| 模型 | hop0 R@50 | hop1 R@50 | 稀释幅度 |
|:---:|:---:|:---:|:---:|
| 0.6B | 48.34% | 42.77% | **−5.57%** |
| 4B | 54.22% | 51.36% | −2.86% |

**关键结论**：模型更大只能**缓冲**噪声稀释（4B 把稀释从 5.57% 压到 2.86%），但无法消除——4B 多跳也只能打平单跳、无法超越。换更大模型最多让多跳“不再有害”，永远到不了“多跳有益”，瓶颈在多跳策略本身（无差别融入 top5），不在 embedding 模型大小。

> ⚠️ **数据一致性提醒**：本次 0.6B 单跳 R@50=48.49% 低于 `260618` 文档里 0.6B 单跳 R@50=52.56%，差异来自 `corpus2` vs `corpus`（不同索引实例），横向对比时需标注索引来源。也正因如此，做策略迭代用 0.6B（索引 7min、评测 ~140s）比 4B（索引 30min、评测 557s）划算约 4 倍，且结论方向一致。

### 现象 5：hops=2 最优，更多跳退化

| 配置 | R@50 |
|------|:----:|
| 单跳 baseline | 11.25% |
| recon 向量链 hops=2 | **18.75%**（RRF/BestRank） |
| recon 向量链 hops=3 | 15.00%（RRF）/ 17.50%（BestRank） |
| recon 向量链 hops=4 | 13.75% |
| 文本融合 hops=2（encodeForSearch，已删） | 17.50% |

hops>2 后 R@50 退化。每跳新文档数递减（hop0=50 → hop1=12.8 → hop2=9.4 → hop3=8.2），信息收敛，后续跳检索质量下降，RRF 融合被拉低。

### 现象 6：精细分析证明递归多跳真的发现新线索

**idx=13 宗教改革题**（gold: Reformation / Wittenberg (district) / Mary / Joseph Strickland）：
```
hop0: 检索德国宗教文档(Magdeburg/Lichtenberg神父)，Wittenberg 不在 top50
hop1: 融入 hop0 线索(德国神父 preached sermons)，召回 [GOLD] Wittenberg #22 ← 新出现！
hop2: 融入 Wittenberg 线索，Wittenberg 升到 #1
```
hop0→hop1 召回了 hop0 完全没有的 Wittenberg，这是真正的"新线索发现"。

**idx=6 缅甸题**（gold: That Dam / Myanmar / Geography of Myanmar）：hop0 命中 Geography of Myanmar #22，但 hop1/2 掉出 top50（多跳反而让它下降）。

两个案例揭示 RRF 融合的缺陷：idx13 的 Wittenberg 在 hop2 排 #1，但 RRF 因 hop0 缺席（给低分）把它稀释到 #35。**BestRank（取所有跳最优排名）** 在 hops=3 上 R@50=17.50% > RRF 15.00%。

### 现象 7：question tokens 对 recon 质量关键

`reconForward` 早期版本没在序列末尾拼 `<question>` tokens，取 last10 位置 hidden state → hop0 R@50=10%。修正为末尾拼 question tokens、取 question token 位置 hidden state 后，hop0 R@50=15%。`recon_mlp` 是为 question token 位置的 hidden state 训练的，必须在该位置取值。

## 归因分析

### 为什么 recon 向量链有效（而旧两跳/recon 自投影失败）

| 方案 | 融合方式 | 结果 |
|------|---------|------|
| 旧两跳（正文拼接+RRF） | passage 正文拼到 query 字符串，一次性 embed | 不如单跳（噪声稀释） |
| recon 自投影（generateWithPrompt） | recon 来自 query 自身 hidden state | 几乎无增益（无新信息） |
| **recon 向量链（reconForward）** | recon 历史向量链 + 新线索，embd 注入 forward | **R@50 +67%** |

recon 向量链有效的原因：
1. **拼接的是 recon 向量链（压缩推理状态），不是 passage 正文**——避免正文噪声稀释
2. **forward 的 attention 主动融合**历史推理 + query + 新线索，而非字符串拼接的被动 embed
3. **去重回传**：每跳只把新出现的文档喂给下一跳，避免重复信息累积
4. **recon 历史累积**：每跳的 recon 都保留，形成逐步聚焦的推理记忆链

### 为什么 hops=2 最优

- hop0：初始检索（纯 query），获取第一批线索
- hop1：融入 hop0 新线索，召回 hop0 漏掉的关联文档（如 idx13 的 Wittenberg）
- hop2+：新文档递减（信息收敛），context 过长导致 dense vector 在文本融合下稀释；recon 向量链虽不稀释但后续跳检索增益递减

### 为什么 RRF 不如 BestRank（在某些 case）

RRF 融合所有跳的排名，对“逐跳上升的 gold”不友好：gold 在早期跳（hop0）缺席时 RRF 给低分，拉低它在后期跳（hop1/2）的高排名。BestRank 取所有跳的最优排名，只要某跳召回过就算命中——更贴合“多跳检索召回”的目标。hops=2 两者持平（18.75%），hops=3 BestRank 更优。

### 为什么完整 166 题上无效：hop1 稀释了 hop0（关键反差）

worst20 上 +67% 但 166 题上几乎无效，根因在 hop1 的检索质量：

| | R@5 | R@20 | R@50 |
|--|:---:|:----:|:----:|
| hop0（纯 query，不加 prefix） | 25.00% | 41.57% | 54.22% |
| hop1（融入 hop0 的 top5 线索） | 22.44% | 36.90% | 51.36% |

**hop1 全面低于 hop0**——融入 hop0 检索结果后，第二跳检索质量反而下降。原因：
- hop0 的 top5 passage 多数是**非 gold 噪声**（166 题里 gold 命中率有限）
- 把这些噪声通过 reconForward 融入 query → 检索向量偏移 → **原本 hop0 能找到的 gold 反而丢了**
- 即 idx6 缅甸题的规律：hop0 命中 Geography of Myanmar #22，hop1 掉出

**净效果抵消**：
- worst20 是单跳**完全失败**的题（gold 不在 top50，无 gold 可丢），多跳引入新线索只赚不赔 → +67%
- 166 题多数单跳**已部分成功**，多跳把已找到的 gold 丢了 → 净效果 ≈ 0

**结论**：recon 向量链当前的无差别融入（top5 全塞进 reconForward）对“已部分成功的题”有害。要推广到完整数据集，第二跳必须**筛选**出真正相关的线索（而非无脑 top5），这指向 decoder 推理筛选新线索的方向。

该稀释规律**跨模型成立**（见现象 4b）：0.6B 上 hop1 相对 hop0 稀释 −5.57%，4B 上 −2.86%——模型越大只缓冲不消除，进一步印证瓶颈在融入策略而非 embedding 质量。

## 关键决策

### 决策 1：用 recon 向量链（embd 注入 forward），而非文本拼接或 recon 自投影

**理由**：实测 recon 向量链 hops=2 R@50=18.75% > 文本融合 17.50% > 单跳 11.25%。recon 自投影几乎无增益。向量链拼接压缩推理状态 + attention 主动融合，是唯一有效的多跳机制。

### 决策 2：每跳去重，只回传新出现的文档

**理由**：避免重复信息稀释 dense vector。新文档数递减（50→12.8→9.4）证明信息逐步收敛，去重让 context 保持精简。

### 决策 3：hops=2 为默认配置

**理由**：hops=2 R@50=18.75% 最优，更多跳退化。4-hop 题用 2 跳迭代已足够捕获主要关联。

### 决策 4：question tokens 必须拼到序列末尾，取 question token 位置 hidden state

**理由**：recon_mlp 为 question token 位置训练。不拼 question tokens 则 hop0 R@50=10%（vs 15%）。

### 决策 5：保留 generateWithPrompt 的 query 注入修复

**理由**：原设计不注入 query 是缺陷（decoder 瞎猜）。修复后（includeQuery=true 默认）虽然 recon 自投影对检索增益有限，但 generateWithPrompt 作为 decoder 推理生成的基础能力保留，供后续"decoder 推理 + 检索"混合方案使用。

### 决策 6：放弃 recon 离散化为 token 的方案（_findNearestTokens）

**理由**：早期文档设想的"recon→最近 token→拼接扩展 query"是 token 离散化方案。但 embd 注入补丁（embd-injection 任务）提供了更强的连续向量注入能力，recon 向量链直接用连续向量，无需离散化。token 离散化有信息损失，已否决。

## 实施计划

- [x] 验证 embd 注入 forward + getEmbedding 取 hidden state 机制（max|Δ|=0）
- [x] 发现并修复 generateWithPrompt 不注入 query 的缺陷
- [x] 验证 recon 自投影无效（对照实验）
- [x] 实现 `reconForward`（recon 向量链 embd 注入 forward）
- [x] 实现递归多跳 loop（recon 历史累积 + 去重回传）
- [x] 实现 RRF / BestRank / 最后一跳三种融合对比
- [x] 最差 20 题验证：R@50 11.25% → 18.75%（+67%）
- [x] 精细分析（idx13/idx6）证明递归多跳发现新线索
- [x] 清理临时脚本，精简 eval/debug 脚本
- [x] 在完整 4-hop 166 题上验证（**结论：worst20 的 +67% 是选择性偏差，166 题上 R@50 仅 +0.15%，几乎无效**）
- [ ] 第二跳线索筛选：当前无差别融入 top5 导致 hop1 稀释 hop0，需筛选真正相关线索（decoder 推理方向）
- [ ] 在完整 Musique 1000 题上验证（确认不伤害 2hop/3hop 简单题）
- [ ] 调优 prompt（"找出新线索"在 encoder forward 里效果未单独验证）

## 实施记录

### 2026-06-25

**阶段 1：generateWithPrompt 缺陷发现与修复**
- 跑 `generateWithPrompt`（原版，无 query 注入）对最差 20 题生成：精确 gold 实体命中 0/20，全是通用词噪声
- 对照 `completeWithText`（喂 query）：模型正确提取实体并推理（缅甸题提取 That Dam/natural boundary，南卡题提取 Thomas Tucker）
- **根因**：`generateWithPrompt` 只注入 `[recon×10 + prompt]`，decoder 读不到题目
- **修复**：加 `includeQuery` 选项（默认 true），注入 `[recon×10 + query_embd + prompt_embd]`；加 `context` 参数让 recon 从 query+context 计算

**阶段 2：recon 自投影无效的验证**
- 对比 A（标准 completion，无 recon）vs B（generateWithPrompt，recon+query）：18/20 vs 18/20 命中，关键词 30 vs 33
- **结论**：recon 来自 query 自身投影，无 query 之外信息，几乎不提升生成质量

**阶段 3：机制验证（embd 注入 forward + getEmbedding）**
- 发现 `LlamaEmbeddingContext` 内部 `_llamaContext._ctx.getEmbedding(i)` 可取任意位置 hidden state
- 同一 addon context 有 `initBatchEmbd`/`addToBatchEmbd`（embd-injection 补丁）
- smoke 验证：embd 注入 forward 的 hidden state 与 token 路径 `max|Δ|=0`
- **结论**：可在 embedding context 上做"embd 注入 forward → getEmbedding 取 hidden state → recon_mlp → 新 recon"

**阶段 4：reconForward 实现**
- 布局 `[recon历史链] + [query] + [answer] + [prompt] + [question×10]`
- 取 question token 位置 hidden state → recon_mlp → newRecon[10,dim]（加入历史链）
- mean pool → recon_mlp → align_mlp → 检索 embedding
- 早期版本漏了 question tokens（hop0 R@50=10%），修正后 15%

**阶段 5：递归多跳 + 去重回传**
- 每跳：reconForward 生成新 recon + 检索向量 → 检索 → 去重（seenDocs）→ 新文档作为下跳 answer
- 三种融合：RRF / BestRank / 最后一跳

**阶段 6：评测与精细分析**
- 最差 20 题 hops=2：R@50 11.25% → 18.75%（+67%）
- idx13 精细分析：hop0 未命中 → hop1 召回 Wittenberg #22 → hop2 升到 #1（真新线索）
- idx6 精细分析：hop0 命中 Geography of Myanmar #22，后续掉出（RRF 救回 #48）

**阶段 7：收敛清理**
- 删临时脚本：`260624-recon-gen-quality.ts`、`260624-recon-cause.ts`、`260624-recon-forward-smoke.ts`
- 精简 `260624-recon-multihop-eval.ts`（21KB→9KB，删文本融合分支/实验开关）
- 删 embedder 的 `encodeForSearch`（文本融合版，被取代）、`completeWithText`（临时对照）
- 保留：`reconForward`（核心）、`generateWithPrompt`（修复版）、`260624-recon-multihop-debug.ts`

**阶段 8：完整 4-hop 166 题验证（结论修正）**
- 生成 `/tmp/musique-4hop166.json`（从 musique.json 筛选 4hop，166 题）
- recon 向量链 hops=2 跑 166 题（耗时 557s）：R@50 54.52% → 54.67%（+0.15%），R@10/20 甚至略降
- hop0（纯query）R@50=54.22% vs hop1（融入线索）R@50=51.36%——**hop1 稀释了 hop0**
- **结论修正**：worst20 的 +67% 是选择性偏差（专挑单跳完全失败的题），不能推广。完整数据集上多跳净效果抵消：对“完全失败的题”有小帮助，对“已部分成功的题”有害（丢了已找到的 gold）
- **方向**：当前无差别融入 top5 已触及上限，需第二跳筛选真正相关线索

**阶段 9：0.6B 补齐 2×2 矩阵（corpus2）**
- 用 0.6B 在 `/tmp/musique-corpus2` 上重跑完整 166 题 hops=2（索引 7min、评测 139.9s）
- 0.6B 多跳 RRF R@50=45.93% < 单跳 48.49%（−2.56%），与 4B 的“多跳打平单跳”同向但伤害更重
- hop1 稀释：0.6B −5.57% > 4B −2.86%——模型越大只缓冲不消除
- **结论**：跨模型印证瓶颈在多跳策略（无差别融入），不在 embedding 质量；日常策略迭代改用 0.6B（详见现象 4b）

## 修订记录

### 2026-06-25

**方向修订（token 离散化 → recon 向量链 embd 注入）**：
- 原文档设想"recon→最近 token（_findNearestTokens）→拼接扩展 query"（token 离散化）
- 修订为"recon 向量链 embd 注入 forward → 新 recon"（连续向量），利用 embd-injection 补丁的能力
- 理由：token 离散化有信息损失；连续向量注入更直接，且 embd 注入 forward + getEmbedding 机制已验证（max|Δ|=0）

**generateWithPrompt 缺陷修复**：
- 问题：原版只注入 `[recon + prompt]`，没注入 query，decoder 瞎猜
- 修复：加 `includeQuery`（默认 true）+ `context` 参数

**recon 来源修订（query 自身 → query + 检索结果）**：
- 原 generateWithPrompt 的 recon 来自 query 自身 hidden state（自投影，无新信息）
- reconForward 的 recon 来自 `[recon历史 + query + 新answer + prompt]` 的 forward（融入检索结果，有新信息）

## 总结

### 核心成果（修正）

- **worst20（最难题）**：R@50 11.25% → 18.75%（+67%），精细分析（idx13）证明递归多跳确实发现新 gold 线索（hop0 未命中 → hop1 召回 Wittenberg #22 → hop2 升到 #1）。
- **完整 4-hop 166 题**：R@50 54.52% → 54.67%（+0.15%），**几乎无效**。worst20 的提升是选择性偏差，不能推广。
- **根因**：hop1 融入 hop0 的 top5 噪声线索，稀释了原本正确的检索（hop1 R@50=51.36% < hop0 54.22%）。对“已部分成功的题”有害，只对“完全失败的题”有小帮助，净效果抵消。
- **方向**：当前机制（reconForward 无差别融入 top5）已触及上限。要推广需第二跳筛选真正相关线索（decoder 推理筛选），而非 encoder 被动 attention 融合。

### 关键机制

`reconForward`：把 recon 历史向量链 + query + 本跳新检索线索 + prompt 拼成 embd 序列，在 embedding context 上 forward，取 question token 位置的 hidden state 经 recon_mlp 生成新 recon。新 recon 同时是下一跳的历史前缀和（经 align_mlp 后的）检索向量。机制可行性已验证（embd 注入 forward 的 hidden state 与 token 路径 max|Δ|=0）。

### 关键收获

1. **recon 向量链 > 文本拼接 > recon 自投影**（机制层面，worst20 数据）：拼接压缩的 recon 向量链优于拼接 passage 正文，远优于 recon 自投影。**但整体仍无效**（166 题上 R@50 仅 +0.15%）。
2. **去重回传避免重复稀释**：每跳只把新出现的文档喂给下一跳。
3. **worst20 选择性偏差的教训**：在最差题上 +67% 不能推广到完整数据集。必须用完整 166/1000 题验证，小样本结论会误导。
4. **hop1 稀释 hop0 是整体无效的根因**：无差别融入 hop0 的 top5 噪声线索，导致第二跳检索质量下降（hop1 R@50=51.36% < hop0 54.22%），丢了原本找到的 gold。要突破必须筛选线索。
5. **BestRank 融合在某些 case 优于 RRF**：对“逐跳上升的 gold”，RRF 被早期跳缺席拉低，BestRank 取最优排名更贴合召回目标。
6. **question tokens 位置对 recon 质量关键**：recon_mlp 在该位置训练，必须拼到序列末尾并在该位置取 hidden state。
7. **generateWithPrompt 必须注入 query**：否则 decoder 读不到题目，瞎猜（已修复）。
8. **模型大小只能缓冲稀释，不能消除**（现象 4b）：0.6B 上多跳 R@50 −2.56%、hop1 稀释 −5.57%；4B 上多跳 R@50 0%、稀释 −2.86%。4B 把伤害压低但仍无法让多跳超越单跳——瓶颈在无差别融入 top5 的策略，不在 embedding 质量。日常策略迭代用 0.6B 即可（结论方向一致、快约 4 倍）。

### 使用命令

```bash
# 0. 数据准备：仓库只含 id 列表，先从原始 musique.json 重建子集 json
#    （worst20 的 id 值与原始数据的 id 字段一致，按 id 过滤即可）
python3 -c 'import json; ids=set(open("data/musique-4hop-worst20.ids.txt").read().split()); d=[q for q in json.load(open("/path/to/musique.json")) if q["id"] in ids]; json.dump(d,open("data/musique-4hop-worst20.json","w"))'
# 166 题 4-hop 子集同理：
python3 -c 'import json; ids=set(open("data/musique-4hop.ids.txt").read().split()); d=[q for q in json.load(open("/path/to/musique.json")) if q["id"] in ids]; json.dump(d,open("data/musique-4hop.json","w"))'

# 1. 评测（复用 /tmp/musique-corpus 的 4B 索引，searchOnly 不重建）
npx tsx scripts/evidence/260624-recon-multihop-eval.ts \
    --corpus-dir /tmp/musique-corpus \
    --worst20 data/musique-4hop-worst20.json \
    --config autodev-config.json \
    --max-hops 2 --k-list 1,2,5,10,20,50 \
    --log-level info

# 2. 单题精细分析（看每跳检索结果 + 新线索）
npx tsx scripts/evidence/260624-recon-multihop-debug.ts \
    --corpus-dir /tmp/musique-corpus \
    --worst20 data/musique-4hop-worst20.json \
    --idx 13 --max-hops 3
```

### 后续

- [ ] 完整 4-hop 166 题验证（确认非小样本噪声）
- [ ] 完整 Musique 1000 题验证（确认不伤害简单题）
- [ ] prompt 调优（"找出新线索"在 encoder forward 的效果未单独验证——当前 prompt 在 encoder forward 里只是 attention 输入段，无 decoder 生成步骤，"推理引导"是隐式的）
- [ ] 探索 decoder 推理生成（generateWithPrompt 续写）与 recon 向量链的结合：用 decoder 显式推理筛选新线索，而非 encoder 隐式 attention 融合
- [ ] BestRank 在 hops≥3 上的优势是否稳定（hops=3 BestRank 17.50% > RRF 15.00%）
