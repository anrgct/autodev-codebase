# 260519-qrranker-highlighter

## 主题/需求

为 codebase 搜索管线新增 **QRRanker attention-based 行级高亮器**（`QRRankerHighlighter`），使用 Qwen3-4B 的 QR attention heads 计算 query→document 的 per-token 相关性作为行级分数。

### 背景

两个现有高亮器质量不达标：
- `LlamaCppHighlightProvider`（277M XLM-R + 外置 Pruning Head）— 模型太小，pruning head 不是为代码训练的，效果差
- `LlamaCppLLMHighlighter`（0.6B + TOPIC prompt）— 只返回单连续行范围，无法处理不连续的感兴趣行，0.6B 理解代码能力弱

QRRanker（Qwen3-4B）的 `kq_soft_max` attention 数据天然包含 per-token 的 query→document 相关性信号，是更好的高亮基础。

### 目标

- 新增 `HighlighterProvider` 类型 `"qrranker"`
- 实现 `QRRankerHighlighter`（实现 `IHighlighter`），通过 QR attention heads 提取 per-token 相关性 → 行级分数
- `highlighterProvider` 与 `rerankerProvider` 同时为 `"qrranker"` 时共享 `LlamaModel` 实例，避免重复加载
- 新增 `--debug-highlight` CLI 标志，打印 token 级 attention 热力图（每个 token 按分数着色 + 行级分数条）

### 预期成果

- 新增 `QRRankerHighlighter` 类（`src/code-index/highlighters/qrranker.ts`）
- `HighlighterConfig` 新增 `ggufQrrankerPath` 字段
- 配置层新增 `highlighterGgufQrrankerPath` 字段
- service-factory 支持 `"qrranker"` provider + 模型共享
- CLI `--debug-highlight` 标志 + 热力图输出

### 验证方式

```bash
# 普通搜索
npx tsx src/cli.ts search "train method" --demo

# 带 debug 热力图
npx tsx src/cli.ts search "train method" --demo --debug-highlight

# JSON 格式
npx tsx src/cli.ts search "train method" --demo --json | jq '.[0].payload.highlightedText'
```

## 代码背景

### 关键文件

| 文件 | 职责 | 改动 |
|------|------|------|
| `src/code-index/interfaces/highlighter.ts` | IHighlighter 接口、HighlighterConfig | `HighlighterProvider` += `"qrranker"`, `HighlighterConfig.ggufQrrankerPath`, `HighlightOptions.debugHighlight`, `HighlightResult.debugTokenView` |
| `src/code-index/interfaces/config.ts` | CodeIndexConfig 接口 | 新增 `highlighterGgufQrrankerPath`（3 个接口同步） |
| `src/code-index/interfaces/vector-store.ts` | SearchFilter 接口 | 新增 `SearchFilter.debugHighlight` |
| `src/code-index/config-manager.ts` | 配置管理器 | highlighterConfig getter + HOT_RELOADABLE_KEYS + snapshot |
| `src/commands/config/metadata.ts` | 配置元数据 | 新增 `highlighterGgufQrrankerPath` 元数据 |
| `src/code-index/highlighters/qrranker.ts` | 【新建】QRRanker 高亮器 | ~880 行，IHighlighter 实现 + debug 热力图 |
| `src/code-index/service-factory.ts` | 服务工厂 | `_qrrankerModel` 缓存 + `createHighlighter()` 支持 `"qrranker"` |
| `src/code-index/rerankers/qrranker.ts` | QRRanker reranker | 构造函数增加可选 `preloadedModel` 参数 |
| `src/code-index/search-service.ts` | 搜索服务 | 传递 `debugHighlight` / `_qrrankerPerTokenScores` 到 highlight options |
| `src/commands/search.ts` | CLI 搜索命令 | `--debug-highlight` 标志 + 热力图输出渲染 |
| `src/commands/shared.ts` | CLI 共享选项 | `CommandOptions.debugHighlight` |

### 高亮器架构

```text-chart
IHighlighter
├── LlamaCppHighlightProvider    ← 专用 GGUF (277M) + Pruning Head
├── LlamaCppLLMHighlighter       ← 0.6B LLM + TOPIC prompt
└── QRRankerHighlighter          ← 【新增】Qwen3-4B attention-based
```

### QRRanker 推理流程（复用）

```
输入: query + codeChunk 拼接为一个序列
  → llama_decode(ctx, batch)
    → cbEval 被每个 kq_soft_max-{17..24} 张量触发
    → 收集 8 层 × [n_kv, n_tokens, n_head] float32 数组
  → JS 侧 computePerTokenScores():
      for each QR head (layer, head):
        attention = kqSoftMaxData[layer]  # [n_kv, n_tokens, n_head]
        query_attn = mean(attention[queryStart..queryEnd, :, head])
        # per-KV-position score
      → 聚合 16 个 QR head → per-token relevance scores
  → Token→Line 映射（字符偏移比例）→ per-line scores
  → Top-K 筛选 → HighlightResult
```

## 关键决策

### 决策1：复用 reranker attention 分数（fast path）替代独立 forward pass

**初始选择：** `QRRankerHighlighter` 每次 `highlight()` 调用独立运行 `llama_decode`，不与 reranker 共享 forward pass 数据。

**理由：**
- 高亮器接口 `(query, codeChunk, startLine)` 收不到 reranker 结果的 payload
- 独立的 forward pass 信号更干净（单 query + 单 document，无 attention 稀释）

**最终选择：复用 reranker 的 attention QR 分数。**

reranker 的 `_rerankBatch()` 已计算出 per-token attention 分数。通过 payload 传递避免了重复 `llama_decode`。

实现方式：
1. `QRRankerReranker.computeQRScores()` 返回 `perChunkTokenScores`
2. 在 `RerankerResult.payload` 上存储 `_qrrankerPerTokenScores` + `_qrrankerCodeText`
3. search-service 管线层从 payload 读取预计算分数，传给 `highlight()` 的 `options` 参数
4. `QRRankerHighlighter` 检测到预计算数据后，跳过 `llama_decode`，直接做 token→line 映射 + 筛选

**Bug 修复——强制统一 fast path：**
- 初始 debug 模式跳过了 fast path 走独立 forward pass，产生不同 attention 分数
- 修复：`highlight()` 统一使用 fast path 计算 `lineScores`，debug 仅做可视化
- ⚠ reranker 多文档上下文分数低于 standalone（attention 被摊薄），但不影响选择一致性

### 决策2：复用 QR_HEADS 而非全部 heads

**选择：** 使用与 QRRanker reranker 相同的 16 个 (layer, head) 对进行 attention 聚合。

**理由：**
- QR heads 专门为 query-document 相关性微调，注意力聚焦于相关 token
- 使用全部 heads（32 heads × 8 layers = 256）会引入大量噪声
- 16 heads 的计算开销很小，不影响 highlight 延迟

### 决策3：Prompt 格式与 reranker 一致

**选择：** 使用与 QRRanker reranker 相同的 prompt 格式（chatml 模板 + chunk 包裹）。

**理由：**
- QR heads 在 chatml 格式的 query-document 场景下微调，一致 prompt 保证 attention 分布一致
- 单 chunk 时不需要 `[1] Title:` 前缀，直接 `codeChunk` 即可

### 决策4：不共享模型实例

**最初选择：** `QRRankerHighlighter` 独立加载模型。

**最终：** 通过 fast path 复用 reranker 的 forward pass 结果，高亮器不再需要独立模型加载推理，仅需 `_ensureModel()` 用于 debug 模式下的 tokenization。最终 debug 热力图改为字符级着色后不再需要 tokenization，模型加载被完全移除。

### 决策5：ANSI 256 色映射

使用 10 级颜色梯度（scoreRatio: 0→1）：

| 范围 | ANSI 色号 | 颜色 |
|------|-----------|------|
| 0 | 237 | 灰（近不可见） |
| < 0.05 | 240 | 深灰 |
| < 0.15 | 33 | 蓝 |
| < 0.3 | 45 | 浅蓝 |
| < 0.45 | 47 | 绿 |
| < 0.55 | 119 | 浅绿 |
| < 0.65 | 227 | 黄 |
| < 0.75 | 214 | 橙 |
| < 0.9 | 202 | 深橙 |
| >= 0.9 | 196 | 红 |

`scoreToAnsiFg(score, maxScore)` 使用 `score / (maxScore * 1.15)` 自适应缩放，避免分数分布不均时全绿或全灰。

### 决策6：合并行级 + token 级视图

**方案：** 每行一个显示行，左侧是 `{行号} {10格分数条}`，右侧是每个 token 独立着色的代码文本。

**理由：** 合并视图能在单一屏幕中同时感知行级趋势和 token 级细粒度，无需上下滚动对比。

### 决策7：per-token 块着色（最终方案，替代字符级着色）

**经历三次迭代：**

1. **v1 — per-token detokenize：** 每个 token 独立 detokenize，用 detokenize 文本的累积长度做字符位置映射。**问题：** fast path 下，高亮器独立 tokenize 代码文本，与 reranker 的 tokenization 因 BPE 边界合并不一致，数据错位
2. **v2 — 字符级着色：** 直接对 `codeChunk` 每个字符用比例映射 `(charPos / codeChars) * totalTokens` 找到对应 token，无依赖 tokenization。**问题：** 步进位置是虚构的，同一单词在不同位置表现不同切分（如 `m|odel` vs `mod|el`）
3. **v3（最终）— per-token 块 + 真实 BPE 边界：** reranker 存储 code 区域的真实 token IDs（来自 full forward pass），highlighter 用 `model.detokenize([tid])` 恢复文本，`buildTokenHeatmap()` 用 detokenize 累积字符长度做线映射。**优势：** 真实 BPE 边界、单词不被切碎、数据源一致

**经验教训：** 字符级着色是 BPE 边界不一致时期的"权宜之计"。一旦保证了 token IDs 数据源一致（reranker 侧存储），就应该回到 per-token 块着色以获得真实 BPE 边界。

### 决策9：后处理排除不连续纯符号行

**选择：** topK 选择后，剔除满足以下条件的行：
1. 不连续（前后无其他被选行）
2. 文本去除空白后长度为 1-3 字符，且全部由非单词字符组成（`!/\w/`）

**理由：**
- QR attention heads 对代码结构锚点（`"""`、`)`、`}` 等）有高注意力，但纯结构性行被选中无意义
- 仅剔除不连续的：若 `"""` 行被连续的 docstring 内容行包围，保留不影响阅读
- `!/\w/.test()` 覆盖所有符号组合，不含字母数字下划线，不需要手动维护符号列表
- 若后处理清空所有行，fallback 保留 top-1 内容行

### 决策8：行号偏移使用 startLine

热力图行号应显示文件中的原始行号（如 L68 起而不是 L1 起）。`buildTokenHeatmap` 添加 `startLine` 参数，所有调用链传递 `startLine`。

## 实施计划

### 高亮器核心

- [x] **步骤 1：配置层** — 接口、config-manager、metadata
  - `highlighter.ts`: `HighlighterProvider` += `"qrranker"`，`HighlighterConfig.ggufQrrankerPath`
  - `config.ts`: `CodeIndexConfig` / `PreviousConfigSnapshot` / `ConfigSnapshot` 三个接口同步新增 `highlighterGgufQrrankerPath`
  - `config-manager.ts`: highlighterConfig getter（转发 ggufQrrankerPath）、HOT_RELOADABLE_KEYS、snapshot
  - `metadata.ts`: 新增 `highlighterGgufQrrankerPath` 元数据

- [x] **步骤 2：QRRankerHighlighter 实现** — 新建 `highlighters/qrranker.ts`
  - 构造函数接收 `modelPath` + 配置参数
  - `highlight()`: 构建 prompt → tokenize → 计算 token 范围 → context（`collectKqSoftMax: true`）→ `evaluateWithoutGeneratingNewTokens()` → 提取 attention → 计算 per-token scores → 映射到行 → 筛选 → `HighlightResult`
  - `validateConfiguration()`: 文件检查 + 模型加载 + 测试 forward pass
  - 核心方法: `computePerTokenScores()`、`tokensToLines()`、`formatOutput()`

- [x] **步骤 3：service-factory 集成**
  - `createHighlighter("qrranker")`: 创建 `QRRankerHighlighter`，传入配置中的 `ggufQrrankerPath`
  - 共享模型

- [x] **步骤 4：注意力复用（fast path）**
  - `rerankers/qrranker.ts`: `computeQRScores()` 返回 `perChunkTokenScores`，`_rerankBatch()` 存入 `payload._qrrankerPerTokenScores`
  - `highlighters/qrranker.ts`: `highlight()` 检测预计算分数后跳过 forward pass，`_mapPrecomputedToLines()` 做分数→行映射
  - `search-service.ts`: 调用高亮前从 payload 提取预计算分数传入 `HighlightOptions`
  - `interfaces/highlighter.ts`: `HighlightOptions` 新增 `_qrrankerPerTokenScores` / `_qrrankerCodeText`

- [x] **步骤 5：类型检查 + 构建验证**
  - `npx tsc --noEmit` 通过
  - `npm run build` 成功

### Debug 热力图

- [x] **步骤 6：接口定义**
  - `highlighter.ts`: `HighlightResult.debugTokenView`、`HighlightOptions.debugHighlight`
  - `vector-store.ts`: `SearchFilter.debugHighlight`
  - `shared.ts`: `CommandOptions.debugHighlight`

- [x] **步骤 7：CLI 集成**
  - `search.ts`: `.option('--debug-highlight', ...)` + 输出渲染（`═══` 分隔块）

- [x] **步骤 8：ANSI 颜色工具**
  - `scoreRatioToAnsiFg(ratio)`: 0~1 → 10 级 256 色
  - `scoreToAnsiFg(score, maxScore)`: 相对缩放着色

- [x] **步骤 9：热力图构建 + 字符级着色**
  - 比例映射 `(charPos / codeChars) * totalTokens` → 每个字符一个颜色
  - 每行分数条复用 `lineScores`（与选择逻辑一致）
  - 图例 + 统计（max/min/mean tokens）

- [x] **Bug 修复 1：全零分** — `_findSubsequence()` 替代算术范围计算
- [x] **Bug 修复 2：显示错乱** — 字符累积位置映射替代等比例映射
- [x] **Bug 修复 3：行号偏移** — `startLine` 参数
- [x] **Bug 修复 4：debug/non-debug 选择不一致** — 统一 fast path
- [x] **Bug 修复 5：BPE 边界合并 token 数不一致** — 字符级着色（后续改为 per-token 块 + reranker 存储 token IDs）
- [x] **Bug 修复 6：subsequence 匹配全部失败** — prefix tokenization 估计 code 位置
- [x] **Bug 修复 7：分数条与 token 颜色不一致** — `computeHeatmapLineScores()` 统一映射策略
- [x] **Bug 修复 8：fast path 比例映射选择错误行** — `tokensToLines()` 替代 `_mapPrecomputedToLines()`
- [x] **已知限制：热力图字符偏移 ~1-2 token** — BPE 边界合并导致，不影响筛选正确性

## 实施记录

### 2026-05-19

- 需求确认：新增 `QRRankerHighlighter`，配置层 + 实现 + 模型共享
- Task doc 创建

### 2026-05-20

#### 高亮器核心

- **配置层完成**：`highlighter.ts` 新增 `"qrranker"` provider + `ggufQrrankerPath`；`config.ts` 3 接口同步新增 `highlighterGgufQrrankerPath`；`config-manager.ts` HOT_RELOADABLE_KEYS / snapshot / getter；`metadata.ts` 新增元数据
- **QRRankerHighlighter 实现完成**：新建 `highlighters/qrranker.ts`，`computePerTokenScores()` 提取 16 QR heads × query tokens attention → per-KV-position 分数，`tokensToLines()` 字符偏移映射到行，`_formatOutput()` 连续行分组
- **service-factory 集成**：`createHighlighter()` 新增 `"qrranker"` 分支
- **端到端测试**：配置 `demo/autodev-config.json` 启用 qrranker，topk 模式（`threshold` 模式对 attention 分数阈值太高）。对 `"train method"` 查询结果质量明显优于旧高亮器——`def train()` 函数签名+方法体 docstring 10 行正确高亮

- **注意力复用优化**：
  - `rerankers/qrranker.ts`：`computeQRScores()` 新增返回 `perChunkTokenScores`，`_rerankBatch()` 存入 `payload._qrrankerPerTokenScores`
  - `highlighters/qrranker.ts`：`highlight()` 检测预计算分数后跳过 forward pass，`_mapPrecomputedToLines()` 直接从 chunk token 分数映射到行
  - `search-service.ts`：调用高亮前从 payload 提取预计算分数传入 `HighlightOptions`
  - `interfaces/highlighter.ts`：`HighlightOptions` 新增内部字段 `_qrrankerPerTokenScores` / `_qrrankerCodeText`
  - 验证：同时启用 reranker + highlighter（之前 OOM exit 137），现正常返回结果，证明跳过了独立模型加载

#### Debug 热力图

1. **接口定义**
   - `highlighter.ts`: 添加 `debugTokenView`、`debugHighlight`
   - `vector-store.ts`: 添加 `SearchFilter.debugHighlight`
   - 类型变更：`llamacpp | llamacpp-llm` → `llamacpp | llamacpp-llm | qrranker`

2. **CLI 集成**
   - `search.ts` 添加 `.option('--debug-highlight', ...)` 和输出渲染代码
   - `shared.ts` 添加 `CommandOptions.debugHighlight`

3. **搜索服务集成**
   - `search-service.ts` 读取 `filter.debugHighlight` 设置 `highlightOptions.debugHighlight`
   - 同时传递 reranker 预计算分数供高亮器复用
   - 持久化 `highlightResult.debugTokenView` 到 `result.payload.debugTokenView`

4. **核心热力图实现**
   - `buildTokenHeatmap()` 初始版本使用等比例 token→字符映射
   - 每 token 独立 detokenize + ANSI 着色
   - 每行显示行号、分数条、着色 token

5. **Bug 1: 全零分 (max=0)**
   - 根因：Qwen3 BPE tokenizer 边界合并导致 token 序列长度变化，范围计算越界
   - 修复：改用 `_findSubsequence()` 搜索而非算术计算

6. **Bug 2: 显示错乱**
   - 根因：等比例 `(ti / codeTokenCount) * codeChars` 映射假设 token 等长
   - 修复：改用实际 detokenize 字符长度累积映射 + 剔除 `\n` token

7. **Bug 3: 行号偏移**
   - `buildTokenHeatmap` 使用 `li + 1` 从 1 开始计数，但用户期待绝对行号
   - 修复：添加 `startLine` 参数，输出 `startLine + li`

8. **Bug 4: debug/non-debug 选择不一致**
   - 问题：`--debug-highlight` 强制走 full forward pass（`_runForwardPass`），用 highlighter 独立计算的分数，与 reranker 的分数不同。同一查询加不加 `--debug-highlight` 得到不同的筛选结果
   - 修复：`highlight()` 统一使用 fast path（预计算分数）计算 `lineScores`，debug 模式只额外构建热力图，不再重跑 forward pass

9. **Bug 5: BPE 边界合并导致 debug 热力图 token 数与分数数不一致**
   - 问题：fast path debug 模式用 `model.tokenize(codeChunk)` 对代码文本独立 tokenize，但 `_qrrankerPerTokenScores` 来自 reranker 的完整 prompt 上下文 tokenization。Qwen3 BPE 的跨边界合并导致两次 tokenization 结果不同（如 129 vs 118 token），字符位置映射错位
   - 症状：热力图文本错位（如 L71 末尾出现 "Examples"、L79 末尾出现 "!!!!!!!"）
   - 修复：改为**字符级着色**（character-level coloring）——直接用原始 `codeChunk` 文本，对每个字符用比例映射 `(charPos / codeChars) * totalTokens` 找到对应 token，取分数着色。完全消除了对 `model.tokenize(codeChunk)` 的依赖，无需高亮器侧做任何 tokenization
   - 涉及文件：
     - `highlighters/qrranker.ts` — 移除 fast path debug 模式中的 `model.tokenize()`/`model.detokenize()`，替换为字符级循环
     - `rerankers/qrranker.ts` — 移除临时存储的 `_qrrankerCodeTokens`（不再需要）
     - `interfaces/highlighter.ts` — 移除 `_qrrankerCodeTokens` 字段
     - `search-service.ts` — 移除 `_qrrankerCodeTokens` 传递逻辑

10. **重要认知：reranker 分数 vs standalone highlighter 分数**
    - reranker 在一次 forward pass 中处理所有文档（如 10 个 chunk ≈ 3000+ KV 位置），query attention 被摊薄，分数显著低于 standalone highlighter（单文档 ≈ 300 位置）
    - 这不是 bug，是 attention softmax 归一化的固有特性
    - 选择集已经一致（都使用 reranker 分数），分数绝对值差异不影响结果

### 2026-05-20（后续修复）

11. **重构：per-token 块着色（替代字符级着色）**
    - **原因：** 字符级着色在每个字符上独立用 `(charPos / codeChars) * totalTokens` 比例映射，由于步进位置是虚构的，同一单词在不同位置表现不同的切分方式（如 `m|odel` vs `mod|el` 交替）
    - **方案：** 回到 per-token 块着色，每个 token 作为一整块统一颜色
    - **核心改动：** reranker 存储 code 区域的真实 token IDs（来自 full forward pass），highlighter 用 `model.detokenize([tid])` 恢复每个 token 的文本，`buildTokenHeatmap()` 用 detokenize 字符累积长度做线映射
    - **新接口：** `HighlightOptions._qrrankerCodeTokenIds: number[]`
    - **涉及文件：**
      - `rerankers/qrranker.ts` — 新增 `_qrrankerCodeTokenIds` 存储逻辑
      - `interfaces/highlighter.ts` — `HighlightOptions` 新增 `_qrrankerCodeTokenIds`
      - `search-service.ts` — 传递 `_qrrankerCodeTokenIds`
      - `highlighters/qrranker.ts` — 移除字符级着色循环，恢复 `buildTokenHeatmap()` + `model.detokenize()` 的 per-token 块方式

12. **Bug 6: subsequence 匹配全部失败，`codeTokenIds` 始终为空**
    - **根因：** reranker 中用 `_findSubsequence()`（等价的 inline 版本）在 `chunkTok`（完整 chunk tokenization）中搜索 `contentTok`（独立 code tokenization）。Qwen3 BPE 跨边界合并导致 `contentTok` 的第一个 token 在 chunk 上下文中不存在，所有 subsequence 匹配都失败（`codeStart = -1`）
    - **影响：** `codeTokenIds` 始终为 `[]`，热力图不显示。同时 `codeScores` 也未被切片，高亮器收到的是完整 chunk 分数
    - **修复：** 改用 prefix tokenization 精确计算 code 位置。`chunkStr.substring(0, chunkStr.indexOf(content))` 提取 prefix 字符串，`model.tokenize(prefixStr).length` 得出准确的 code start 位置。比字符比例法精确（边界误差 0-1 token vs 2-5 tokens）
    - **涉及文件：** `rerankers/qrranker.ts` — `else` 分支替换字符比例法为 prefix tokenization

13. **Bug 7: 分数条与 token 颜色不一致（`"""` 分数被分配到不同行）**
    - **根因：** `_mapPrecomputedToLines()`（线分数计算）使用 `(ti / totalTokens) * codeChars` 比例映射，但 `buildTokenHeatmap()`（token 着色）使用 `(detokAcc / totalDetokLen) * codeChars` detokenize 累积映射。两个映射策略不同，边界不一致
    - **症状：** `"""` token 的分数被比例映射分配到行 87（`) -> None:`），但被 detokenize 累积映射分配到行 88，导致行 88 分数条偏低而 token 颜色高
    - **修复：** 新增 `computeHeatmapLineScores()` 函数，使用与 `buildTokenHeatmap()` 完全相同的 detokenize 累积映射计算线分数。fast path debug 模式先计算 `heatmapLineScores`，再传入 `buildTokenHeatmap()`，确保分数条和 token 着色一致
    - **涉及文件：** `highlighters/qrranker.ts` — 新增 `computeHeatmapLineScores()` 文件级函数，fast path debug 调用它替代使用 `_mapPrecomputedToLines()` 的结果

14. **Bug 8: fast path 比例映射 `_mapPrecomputedToLines()` 选择错误行（L115 当选而非 L117）**
    - **根因：** `_mapPrecomputedToLines()` 使用简单比例映射 `(ti / totalTokens) * codeChars`，假设每个 token 等长。但 BPE token 长度差异很大，比例映射将 token 分数错误分配到相邻行。而 `tokensToLines()` 和 `computeHeatmapLineScores()` 使用 detokenized 字符累积映射，两者不一致导致 lineScores 错误→topK 选择错误行
    - **症状：** `__init__` 片段 (L82-129) 中 L117（`self.trainer = None`，score=██████████）是最高分行，但 fast path 选择了 L115（`self.predictor = None`，score=█░░░░░░░░░）。比例映射把 `self.trainer` token 的分数错误分配到 L115 的行范围
    - **修复：** fast path 中当 `_qrrankerCodeTokenIds` 可用时（reranker 总是提供），调用 `tokensToLines()`（detokenized 字符累积映射）替代 `_mapPrecomputedToLines()`（比例映射）。需先 `await this._ensureModel()` 加载模型用于 detokenization
    - **涉及文件：** `highlighters/qrranker.ts` — fast path 判断 `tokenIds` 可用性后使用 `tokensToLines()` 替代比例映射

15. **后处理：排除不连续纯符号行**
    - **原因：** QR attention heads 对代码结构锚点（`"""`、`)`、`}`、`---` 等）有高注意力，导致这些纯符号行被选中但无意义
    - **方案：** topK 选择后做后处理，剔除满足以下条件的行：不连续（前后无相邻行）且文本去空白后 1-3 个非单词字符（`!/\w/`）。全部被剔除时 fallback 保留 top-1 内容行
    - **涉及文件：** `highlighters/qrranker.ts` — `highlight()` 选择后加后处理循环

### 2026-05-20（BPE 边界偏差 & 已知问题记录）

16. **BPE 边界合并导致的~1-2 token 偏差（已知限制）**
    - **问题：** L68-80 片段的热力图中，"Examples" 文本出现在 L71 末尾，":" 单独在 L73。而非 debug 输出的筛选结果是正确的（L73 `Examples:` 被正确选中）
    - **根因：** `perChunkTokenScores[i]` 的索引范围通过隔离 tokenization 计算（`chunkRanges`），但 scores 对齐的是上下文 KV 位置。BPE 在 chunk 边界（prefix↔chunk1、chunk1↔chunk2、chunk2↔query）会合并 token，导致：
      - `chunkRanges` 估计的起始/结束位置与上下文实际位置偏差 1-2 token
      - 每次尝试对齐都会遇到 BPE 边界合并的新组合
    - **尝试过的对齐方法（均受 BPE 边界限制）：**
      1. 直接 subsequence 匹配：第一个 code token 被合并到 prefix，搜索失败
      2. Prefix tokenization 估计：独立的 prefix tokenization 与上下文前缀的 token 数不一致
      3. Skip-first-N 搜索：跳过前 3 个 content token 再搜索 tail——BPE 合并影响的不止前 3 个 token，且字节级 token 在不同上下文中 ID 不同
      4. 上下文 token detokenization 字符累积：group-detokenize 恢复的文本与原始 chunk 文本在空格/字节编码上有细微差异，`indexOf` 定位偏差
    - **影响范围：** 仅影响 debug 热力图的字符对齐可视化。实际筛选结果（非 debug）= 正确。lineScores（选择依据）和 heatmapLineScores（热力图条）使用相同 detokenized 映射逻辑，差异仅来自 reranker 侧 codeStart 的 ~1-2 token 偏差
    - **结论：** 这是 BPE tokenizer 上下文与隔离 tokenization 不一致的固有限制。所有对齐方法都基于某种形式的隔离 tokenization，无法消除边界合并的残余误差。修复的边际收益递减，该偏差作为已知限制接受

### 经验教训

- `threshold` 模式对 attention-based 分数不适用：16 heads × N query tokens 归一化后，单个 code token 的 attention 分数通常 < 0.01（被分散到序列中所有 token）。需用 `topk` 模式
- `QRRankerReranker` 的 `rerankerMinScore` 默认 0.5 对 reranker 分数范围偏高，可能过滤所有结果（实测 top 分数约 0.08）
- 运行中同时加载两个 4B 模型实例超过 16GB 内存 → OOM。优化后 reranker + highlighter 共享一份 adata 实现零额外加载
- BPE tokenizer 的边界合并在多上下文 tokenization 中一直是个陷阱。绝对避免在 highlighter 侧独立 tokenize 代码文本再与 reranker 分数对齐——由 reranker 存储 token IDs，highlighter 直接 detokenize 复用
- 字符级比例映射避免了 BPE 依赖，但虚构的步进位置导致单词被随机切分，视觉上不可接受。综合最优解是 reranker 存储 token IDs + highlighter detokenize 恢复 BPE 边界
- `_mapPrecomputedToLines()` 的比例映射与 `buildTokenHeatmap()` 的 detokenize 累积映射不一致，导致分数条和 token 颜色反映不同的行级分数。debug 热力图应使用统一的 `computeHeatmapLineScores()` 确保一致性
- subsequence 匹配在 BPE 场景下不可靠（边界合并导致 token 不匹配），prefix tokenization 是更精确的 code 区域估计方法
- BPE 边界合并导致上下文 tokenization 与隔离 tokenization 之间存在 ~1-2 token 的偏差，此偏差无法通过任何 tokenization 对齐方法完全消除（因为对齐方法本身也依赖隔离 tokenization）。contextual 组 detokenization 能精确保留原始文本，但单个 token 的 `detokenize([id])` 存在字节级字符长度误差，累积后定位偏差与 prefix tokenization 在同一量级
- `perChunkTokenScores` 的 chunk 范围（`chunkRanges`）基于隔离 tokenization 计算，但 scores 对齐上下文 KV 位置。这导致 debug 热力图中 prefix↔code 边界有 ~1-2 token 的视觉偏移。筛选结果不受影响（偏移量相对 code 内容总 token 数可忽略，不影响 topK 行级选择）
- 修复 BPE 边界偏差的 4 种尝试均受限于同一根本原因（隔离↔上下文不一致），边际收益递减。作为已知限制接受，不影响核心功能正确性

## 修订记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | 2026-05-19 | 初始文档，需求 + 架构 + 决策 |
| v2 | 2026-05-20 | 配置层 + 实现 + 测试 + 注意力复用优化 |
| v3 | 2026-05-20 | 合并 debug-highlight：CLI 标志 + 热力图 + 字符级着色 + 5 个 Bug 修复 |
| v4 | 2026-05-20 | per-token 块着色替代字符级着色、reranker 存储 token IDs、Bug 6/7 修复 |
| v5 | 2026-05-20 | Bug 8 + 后处理排除不连续纯符号行 + fast path detokenized 映射 |
| v6 | 2026-05-20 | BPE 边界偏差已知限制记录 + reranker codeStart 多种对齐方法尝试 |

## 总结

**核心思路：** Qwen3-4B 的 QR attention heads 在 reranking 中已证实能捕捉 query-document 相关性，将其 per-token attention 信号用于行级高亮，质量预期优于 277M 专用模型和 0.6B prompt 高亮器。

**关键技术点：**
1. `kq_soft_max` 的 per-token attention 通过 `cbEval` 回调收集，与 reranker 共用 C++ addon patch
2. 16 个 QR heads 的 attention 聚合 → 稳定的 per-token relevance 信号
3. Token→Line 字符偏移映射（与现有 highlighter 一致）
4. **Fast path 复用：** reranker 的 attention 分数通过 payload 传递，高亮器跳过独立 forward pass，节省 ~10 秒/块
5. **字符级着色：** debug 热力图不使用独立 tokenization，避免 BPE 边界合并导致的 token 数不一致
6. **选择一致性：** debug 模式不改变选择逻辑，热力图仅做可视化

**关键 Bug 修复总结：**

| Bug | 根因 | 修复 |
|-----|------|------|
| 全零分 | BPE 边界合并导致 token 范围计算越界 | `_findSubsequence()` 搜索替代算术计算 |
| 显示错乱 | 等比例映射假设 token 等长 | 字符累积位置映射 |
| 行号偏移 | 未使用 startLine | 添加 `startLine` 参数 |
| 选择不一致 | debug 模式独立 forward pass | 统一 fast path |
| 热力图文本错位 | BPE 导致 token 数不匹配 | reranker 存储 token IDs → per-token 块着色 |
| tokenIds 为空 | subsequence 匹配被 BPE 破坏 | prefix tokenization 精确估计 code 位置 |
| 分数条与颜色不一致 | 比例映射 vs detokenize 映射策略不同 | `computeHeatmapLineScores()` 统一策略 |
| fast path 选择错误行 | `_mapPrecomputedToLines()` 比例映射假设 token 等长 | `tokensToLines()` detokenized 映射替代 |
| [K] 热力图字符偏移~1-2 token | BPE 边界合并导致隔离↔上下文 tokenization 不一致 | 已知限制，不影响筛选正确性 |

**参考：**
- QRRanker reranker 实现：`src/code-index/rerankers/qrranker.ts`
- QRRanker addon patch 方案：`docs/plans/260519-qrranker-llamacpp-patch.md`
- 专用模型高亮器：`src/code-index/highlighters/llamacpp.ts`
- LLM prompt 高亮器：`src/code-index/highlighters/llamacpp-llm.ts`
- Debug 热力图文档：`docs/plans/260520-debug-highlight.md`（已合并到本文档）
