# 260516-llm-highlight

## 主题/需求

为 codebase 搜索管线新增 **LLM Prompt 驱动的行级高亮器** (`LlamaCppLLMHighlighter`)，与现有的专用模型高亮器 (`LlamaCppHighlightProvider`) 并行存在，形成与 Reranker 层一致的"专用模型 vs LLM Prompt"双路线架构。

### 目标

- 新增 `LlamaCppLLMHighlighter` 实现 `IHighlighter` 接口，通过 LLM chat prompt 判断代码行相关性
- 支持 0.6B 小模型，prompt 需高度优化（简洁指令、少 token 输出）
- 配置层新增 `highlighterProvider` 字段区分两种 provider
- 与 reranker/summarizer 共享 `LlamaModel` 实例，不重复加载

### 预期成果

- 新增 `LlamaCppLLMHighlighter` 类 (`src/code-index/highlighters/llamacpp-llm.ts`)
- `HighlighterConfig` 新增 `provider`、`ggufLlmPath` 字段
- `CodeIndexConfig` 新增 `highlighterProvider`、`highlighterGgufLlmPath`
- 原 `highlighterGgufModelPath` 重命名为 `highlighterGgufPath`
- service-factory 支持按 provider 创建不同 highlighter 实例

### 验证方式

```json
// demo/autodev-config.json
"highlighterEnabled": true,
"highlighterProvider": "llamacpp-llm",
"highlighterGgufLlmPath": "/path/to/qwen-0.6b.gguf",
"highlighterTopK": 20
```

```bash
npx tsx src/cli.ts search "where is the train method" --demo --json | jq '.[0].payload.highlightedText'
```

## 代码背景

### 现有两条 Reranker 路线（参考模式）

```text-chart
IReranker
├── LlamaCppReranker          ← 专用 cross-encoder GGUF 模型
└── LlamaCppLLMReranker       ← 共享 LLM + chat prompt 打分
```

### 现有一条 Highlighter 路线（需补齐）

```text-chart
IHighlighter
└── LlamaCppHighlightProvider  ← 专用 semantic-highlight GGUF + pruning head
└── LlamaCppLLMHighlighter     ← 【新增】共享 LLM + chat prompt 行级过滤
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/code-index/interfaces/highlighter.ts` | `IHighlighter`、`HighlighterConfig` 接口 |
| `src/code-index/highlighters/llamacpp.ts` | 专用模型高亮器（参考实现） |
| `src/code-index/rerankers/llamacpp-llm-rerank.ts` | LLM reranker（prompt 构建参考） |
| `src/code-index/interfaces/config.ts` | `CodeIndexConfig` 配置接口 |
| `src/code-index/config-manager.ts` | 配置管理器 |
| `src/code-index/service-factory.ts` | 服务工厂，`createHighlighter()` |
| `src/code-index/manager.ts` | 管线编排 |
| `src/code-index/search-service.ts` | 搜索服务，调用 highlighter |

## 关键决策

### 决策1：配置字段命名与 Provider 选择

**选择：** 新增 `highlighterProvider` 字段，重命名模型路径字段

```json
{
  "highlighterEnabled": true,
  "highlighterProvider": "llamacpp",       // "llamacpp" | "llamacpp-llm"
  "highlighterGgufPath": "...",            // 专用模型（原 highlighterGgufModelPath）
  "highlighterGgufLlmPath": "...",         // LLM 模型（新增）
  "highlighterTopK": 20,
  "highlighterMode": "topk"
}
```

**理由：**
- `highlighterGgufModelPath` → `highlighterGgufPath`：GGUF 本身就是模型格式，`Model` 冗余
- 新增 `highlighterGgufLlmPath`：与 `highlighterGgufPath` 对称，一个语义清晰
- `highlighterProvider` 与 reranker 的 `rerankerProvider` 模式一致

### 决策2：LLM 响应格式 — JSONL 行范围

**选择：** LLM 返回相关行范围而非逐行打分

```jsonl
{"reason":"定义 train 函数签名和核心训练循环","startLine":34,"endLine":45}
{"reason":"学习率调度器配置","startLine":89,"endLine":92}
```

**理由：**
- 逐行返回 token 消耗巨大（200 行代码 = 200 个 JSON 对象）
- 连续相关行通常成块出现，范围表示自然且省 token
- 未提及的行自动视为"移除"
- `reason` 字段帮助小模型思考（类似 CoT），也便于调试
- 0.6B 小模型需要简单直接的输出格式

### 决策3：Prompt 优化策略（针对 0.6B 小模型）

**选择：** 极简 prompt + 1-shot 示例 + 严格输出约束

**策略：**
- 指令压缩到 3-4 句核心规则
- 只给 1 个 few-shot 示例（省 context）
- 明确约束：只输出 JSONL，无其他文字
- 添加"只保留最相关的 ≤30% 行"的激进过滤指令
- `maxTokens` 限制在 512（小模型输出慢）

### 决策4：模型共享

**选择：** 通过 `service-factory._getOrCreateLlamaCppLlmModel(path)` 共享实例

**理由：**
- 与 reranker/summarizer 共享 `LlamaModel`，避免重复加载
- 按 `highlighterGgufLlmPath` 独立 key 缓存（可能与 `llamaCppModelPath` 不同）
- 如果路径相同则自然命中缓存

### 决策5：fallback 策略

**选择：** LLM 解析失败时返回所有行（与 `LlamaCppHighlightProvider._fallbackAllLines` 一致）

**理由：**
- 不阻塞搜索管线
- 返回全部代码好过返回空

## 实施计划

- [x] **阶段1：配置层** — 接口、config-manager、config metadata
  - `highlighter.ts`: 新增 `HighlighterProvider` 类型，`HighlighterConfig` 新增 `provider`/`ggufLlmPath`/`concurrency`，重命名 `ggufModelPath` → `ggufPath`
  - `config.ts`: 新增 `highlighterProvider`/`highlighterGgufLlmPath`/`highlighterConcurrency`，重命名 `highlighterGgufModelPath` → `highlighterGgufPath`
  - `config-manager.ts`: 更新 getter、snapshot、HOT_RELOADABLE_KEYS
  - `commands/config/metadata.ts`: 新增 5 个配置键元数据
- [x] **阶段2：LlamaCppLLMHighlighter 实现** — 新建 `highlighters/llamacpp-llm.ts`
  - 构造函数接收 `modelPath`（字符串）+ 配置，内部 `_ensureModel()` 延迟加载
  - `highlight()` 方法：构建 prompt → `_ensureModel()` → chat session → 解析 JSONL → 构建 HighlightResult
  - `validateConfiguration()` 方法：检查文件 + 模型加载 + 测试调用
  - 纯逻辑方法：`_buildPrompt`（极简 0.6B 优化）、`_parseResponse`、`_buildResult`、`_formatOutput`、`_fallbackAllLines`
- [x] **阶段3：service-factory 集成** — 按 provider 分发
  - `createHighlighter()` 根据 `highlighterProvider` 创建 `LlamaCppLLMHighlighter` 或 `LlamaCppHighlightProvider`
  - 模型延迟加载由 highlighter 内部处理，factory 只需传入 `modelPath`
  - `search-service.ts`: 并发控制的并行 highlighter 处理（`Promise.all` + batch）
- [x] **阶段4：类型检查 + 构建验证**
  - `npx tsc --noEmit` 通过（0 errors）
  - `npm run build` 成功
- [ ] **阶段5：测试** — 纯逻辑单元测试（prompt 构建、响应解析、格式化）

## 实施记录

### 2026-05-16

- 需求确认、Task Doc 创建
- **阶段1-4 完成** — 配置层、LlamaCppLLMHighlighter 实现、service-factory 集成、类型检查+构建通过
- 新增文件：
  - `src/code-index/highlighters/llamacpp-llm.ts` — LlamaCppLLMHighlighter（~380 行）
- 修改文件：
  - `interfaces/highlighter.ts` — 新增 `HighlighterProvider`、`ggufPath`/`ggufLlmPath`/`provider`/`concurrency`
  - `interfaces/config.ts` — 三个接口同步更新（CodeIndexConfig / PreviousConfigSnapshot / ConfigSnapshot）
  - `config-manager.ts` — highlighterConfig 更新、HOT_RELOADABLE_KEYS 新增 7 个 highlighter key
  - `commands/config/metadata.ts` — 新增 5 个配置键
  - `service-factory.ts` — createHighlighter() 支持双 provider
  - `search-service.ts` — 并发控制的并行 highlighter 处理
- 关键决策调整：
  - `LlamaCppLLMHighlighter` 改为接收 `modelPath`（字符串）+ 内部 `_ensureModel()` 延迟加载，而非工厂层预加载 `LlamaModel`，保持与 `LlamaCppHighlightProvider` 一致的构造模式
  - 并发控制放在 `search-service.ts` 管线层（`Promise.all` 按 `concurrency` 分批），而非 highlighter 内部

## 修订记录

（暂无）

## 总结

**核心思路：** 用 LLM chat prompt（模仿 `LlamaCppLLMReranker`）替代专用 GGUF 模型 + pruning head（`LlamaCppHighlightProvider`），实现行级代码高亮。

**关键技术点：**
1. Prompt 需针对 0.6B 小模型极致优化（极简指令、1-shot、严格输出格式）
2. JSONL 行范围格式省 token，适合小模型
3. 模型共享避免重复加载
4. fallback 策略保证管线健壮性
