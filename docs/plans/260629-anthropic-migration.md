# 260629-anthropic-migration

## 主题/需求

将 escalate proxy 的对外协议 + 对上游协议**全量迁移到 Anthropic Messages API 格式**，弃用现有的 OpenAI/DeepSeek 兼容格式。

**动机：** 国产模型基本都提供 Anthropic 格式端点（newapi 网关统一聚合），兼容性优于 OpenAI 格式。统一到 Anthropic 后，proxy 可以直接对接任意支持该格式的国产模型，无需逐家适配。

**预期成果：**
- 客户端 → proxy：Anthropic Messages API（`POST /v1/messages`）
- proxy → flash/pro 上游：Anthropic Messages API
- self-report 和 advisor 两种升级模式在 Anthropic 格式下等价工作
- 配置统一新增 `thinkingBudget`，显式开启 thinking（兼容 GLM 这类不传不 think 的模型）

**非目标：**
- 不保留 OpenAI 格式双轨支持（单向迁移，不做抽象层）
- 不改动 escalate 以外的模块

## 代码背景

### 相关文件

| 文件 | 当前格式耦合 | 改造量 |
|------|-------------|--------|
| `src/escalate/server.ts` | 路由 `/v1/chat/completions`；`Authorization: Bearer` | 小 |
| `src/escalate/types.ts` | 默认值 deepseek；无 `max_tokens`/`thinking` 字段 | 小 |
| `src/escalate/sse-buffer.ts` | `parseDelta` 写死 `choices[0].delta` | **重写** |
| `src/escalate/contract.ts` | `injectContract` 在 messages 找 `role:'system'`；advisor tool 用 `{type:'function',function:{parameters}}` | 中 |
| `src/escalate/dispatcher.ts` | `callUpstream` URL/body；所有响应解析；`peekTierStream`/`peekAdvisorStream`/`streamProAsReasoning`；4 个合成事件；tool result 构造 | **大（≈90%）** |
| `src/escalate/__tests__/` | mock 全是 OpenAI 格式 | 大 |

### OpenAI vs Anthropic 关键差异（影响改造点）

| 维度 | OpenAI (当前) | Anthropic (目标) |
|------|---------------|------------------|
| 路由 | `/v1/chat/completions` | `/v1/messages` |
| 认证 | `Authorization: Bearer` | `x-api-key` + `anthropic-version: 2023-06-01` |
| system | `messages` 里 `role:'system'` | 顶层 `system` 字段 |
| tools | `{type:'function',function:{name,description,parameters}}` | `{name,description,input_schema}` |
| tool_choice | `{type:'function',function:{name}}` / `'auto'` | `{type:'tool',name}` / `{type:'auto'}` |
| max_tokens | 可选 | **必填** |
| thinking | DeepSeek 自动返回 `reasoning_content` | 显式 `thinking:{type:'enabled',budget_tokens}` |
| 非流式响应 | `choices[0].message.{content,reasoning_content,tool_calls}` + `finish_reason` | `content:[{type:text/thinking/tool_use}]` + `stop_reason` |
| 流式事件 | `data:{choices:[{delta}]}` + `data:[DONE]` | `event:` + `data:`，`message_start`/`content_block_*`/`message_delta`/`message_stop` |
| 流式 thinking | `delta.reasoning_content` | `content_block_delta` + `thinking_delta` |
| 流式 tool | `delta.tool_calls[].function.arguments` 拼接 | `content_block_start(tool_use)` + `input_json_delta.partial_json` 拼接 |
| 终止 | `finish_reason` + `[DONE]` | `message_delta(stop_reason)` + `message_stop`（**无 [DONE]**） |
| tool result | `{role:'tool',tool_call_id,content}` | `{role:'user',content:[{type:'tool_result',tool_use_id,content}]}` |
| assistant tool_use | `{role:'assistant',tool_calls:[...]}` | `{role:'assistant',content:[{type:'tool_use',id,name,input}]}` |

## 运行观测

### 2026-06-29 — newapi 端点 Anthropic 格式兼容性验证

**端点：** `http://localhost:2302/v1/messages`（newapi 网关，deepseek-v4-flash/pro）

**验证脚本：** curl 直接打 `/v1/messages`，日志存 `/tmp/anthropic-stream-*.log`

**验证项与结果：**

| 验证项 | 结果 | 说明 |
|--------|------|------|
| 认证 | ✅ | `x-api-key` + `anthropic-version: 2023-06-01` 可用 |
| 非流式 | ✅ | `content:[{type:'text',text}]` + `stop_reason:'end_turn'` |
| thinking（DeepSeek） | ✅ | **自动返回** `thinking_delta`，未传 `thinking` 参数也有 |
| text 流式 | ✅ | 标准 `text_delta`，事件序列 `message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop` |
| tool_use 流式 | ✅ | `content_block_start(tool_use,id,name,input:{})` + `input_json_delta.partial_json` 逐块拼 JSON + `message_delta(stop_reason:'tool_use')` + `message_stop` |
| 终止事件 | ✅ | `message_delta(stop_reason)` + `message_stop`，**无 `[DONE]`** |
| block index | ✅ | thinking=0 → text/tool=1 递增 |

**关键发现：**
1. DeepSeek 经 newapi 的 Anthropic 端点会**自动**把 reasoning 转成 thinking_delta —— 但这是 DeepSeek 的特性，**不能依赖**。
2. GLM 等其他模型不传 `thinking` 参数就不 think —— 所以 proxy 对未带 `thinking` 的请求注入预设（见决策 3），已带的透传。
3. 终止完全靠 `message_stop`，无 `[DONE]` —— 当前 advisor 模式修过的"[DONE] 吞 flash retry" bug 在新格式下天然不存在（各子流事件类型独立）。

## 归因分析

### 当前 OpenAI 格式耦合分布

OpenAI 格式逻辑**散落在 dispatcher 各处**，不是集中的 adapter 层：
- `callUpstream`：URL `/chat/completions`、body 结构、认证 header
- `buildFlashBody`/`buildProBody`/`buildFlashAdvisorBody`/`buildProAdvisorBody`：body 构造
- `peekTierStream`：从 `choices[0].delta.content` 取 marker
- `peekAdvisorStream`：从 `delta.tool_calls` + `finish_reason:'tool_calls'` 检测 advisor
- `streamProAsReasoning`：重写 `content`→`reasoning_content`，依赖 OpenAI delta 结构
- `buildAdvisorBeginEvent`/`buildAdvisorEndEvent`/`buildTierSwitchEvent`/`buildProxyErrorEvent`：构造 OpenAI `data:` chunk
- tool result：`{role:'tool',tool_call_id}`

### 为什么不保留 OpenAI 双轨 / 不加抽象层

1. **客户端直接面向** —— 客户端（Cline 等）发什么格式，proxy 对外就是什么格式。既然产品方向是 Anthropic，对外的 OpenAI 支持就该移除。
2. **散落耦合** —— OpenAI 格式散在各函数里，加 IR 抽象层 = 重写 + 加层，比直接重写更累且更难读。
3. **YAGNI** —— 当前只需一种格式，双格式抽象是过度设计。

## 关键决策

### 决策 1：直接重写为 Anthropic，不做双格式抽象层

**理由：** 见归因分析。全量迁移是明确产品方向，单向迁移，接受丢失 OpenAI 兼容。

### 决策 2：趁重写抽离 `anthropic-protocol.ts` 协议层

当前格式逻辑和编排逻辑耦合在 `dispatcher.ts`。重写时把**纯格式操作**集中到新文件 `src/escalate/anthropic-protocol.ts`，dispatcher 回归"何时升级/何时拦截"的纯编排：

```
anthropic-protocol.ts  ← 新增，纯格式操作，零编排
├── 构造请求 body（messages/tools/system 合并、thinking、max_tokens）
├── 解析非流式响应（content blocks → text/thinking/tool_use）
├── 流式事件解析（Anthropic 版 SseLineBuffer）
├── 合成事件构造（advisor begin/end、tier switch、error）+ index 重写器
└── tool result / assistant tool_use 消息构造
```

### 决策 3：thinking 预设值 + 透传策略

**问题：** DeepSeek 自动 think，但 GLM 等模型不传 `thinking` 参数就不 think。各家行为不一致。

**方案：无则注入预设，有则透传**
- 客户端请求**没有** `thinking` 字段 → proxy 注入 `thinking:{type:'enabled',budget_tokens:thinkingBudget}`（用配置预设值）
- 客户端请求**有** `thinking` 字段 → 透传，不覆盖（尊重客户端意愿）
- `EscalateConfig` 新增 `thinkingBudget: number`（默认值如 8000）
- 同理 `max_tokens`：Anthropic 必填，客户端未传则用预设默认值，传了则透传

**不做复测。** 原生 Anthropic 开 thinking 时 `temperature` 必须 = 1、`budget_tokens` < `max_tokens`。按字面规则执行（thinking/temperature/max_tokens 各自独立判断有无），遇上游限制报错由客户端可见，不主动加强制逻辑。

### 决策 4：content block index 重写器

**问题：** Anthropic streaming 的每个 content block 有递增 `index`（thinking=0, text=1, ...）。proxy 在多个独立子流（flash / advisor分隔 / pro / flash retry）之间拼接合成事件时，各子流的 index 从 0 开始，直接拼接会让客户端看到 index 跳跃/重复，解析混乱。

**方案：** `anthropic-protocol.ts` 提供 index 重写器 —— 一个单调递增计数器，所有经过 proxy 转发/注入的 `content_block_*` 事件的 `index` 字段重写为连续值。这是 Anthropic 格式特有的，OpenAI 格式（扁平 delta）没有这个问题。

### 决策 5：advisor 分隔标记注入方式

当前 advisor 分隔标记（`--- [proxy: consulting advisor] ---`）注入为 `delta.reasoning_content`。迁移后注入为**独立的 thinking content block**（`content_block_start(thinking)` + `content_block_delta(thinking_delta)` + `content_block_stop`），通过 index 重写器保证连续。

**实施注意：** Anthropic 规范要求 thinking block 不能作为消息最后一个 block（需后跟 text/tool_use）。proxy 注入的分隔标记后总会接续其他子流内容，但"连续 thinking block"和"thinking 后无 text"在 newapi 下的宽容度需在阶段 5 验证；若不合法则退化为 text block 注入。

### 决策 6：终止事件设计

无 `[DONE]`。每个**中间**上游子流的 `message_delta`(stop_reason) + `message_stop` **都不转发**给客户端（否则客户端误判整个流结束，复现 advisor 的"[DONE] 吞 flash retry" bug）。整个客户端流由**最终 flash retry 的 `message_delta` + `message_stop`** 终止。

## 实施计划

- [x] **阶段 1：底层 + 配置**
  - `src/escalate/types.ts` — 新增 `thinkingBudget`/`maxTokens` 字段；默认 apiBase 改 Anthropic 风格（`anthropic-version` 作常量放 protocol 层，不入配置）
  - `src/escalate/anthropic-protocol.ts` — **新建**，纯格式操作（body 构造/响应解析/流式解析/合成事件/index 重写器）
  - `src/escalate/sse-buffer.ts` — 重写为 Anthropic `event:`+`data:` 解析

- [x] **阶段 2：入口层**
  - `src/escalate/server.ts` — 路由 `/v1/chat/completions` → `/v1/messages`；认证改 `x-api-key`+`anthropic-version`；`handleChat` body 解析适配 Anthropic 结构（`system` 顶层、`messages` 无 system role）；passthrough 路径适配
  - `src/commands/escalate.ts` — banner + 配置加载（thinkingBudget 等）

- [x] **阶段 3：contract 注入**
  - `src/escalate/contract.ts` — `injectContract` 改顶层 `system` 字段注入；`injectAdvisorTool` 改 `{name,description,input_schema}`；idempotency sentinel 保留

- [x] **阶段 4：self-report 模式**
  - `dispatcher.ts` — `peekTierStream` marker 检测从 `text_delta.text` 取数；`buildTierSwitchEvent`/`buildProxyErrorEvent` 改 Anthropic 合成事件；非流式响应解析改 content blocks

- [x] **阶段 5：advisor 模式**
  - `dispatcher.ts` — `peekAdvisorStream` 从 `tool_use` content block + `stop_reason:'tool_use'` 检测；`streamProAsReasoning` 重写 `text_delta`+`thinking_delta`→客户端 thinking block；tool result 改 `{role:'user',content:[{type:'tool_result'}]}`；assistant tool_use 改 `content:[{type:'tool_use'}]`
  - advisor begin/end 改独立 thinking content block

- [ ] **阶段 6：测试**
  - `__tests__/` — mock 全改 Anthropic 格式
  - e2e — 完整 self-report + advisor 流程
  - 复现脚本：content block index 连续性断言、message_stop 只出现一次（最末尾）

## 实施记录

### 2026-06-29 — 阶段 1-5 实施完成 + 阶段 6 基础测试

**改动文件清单：**

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/escalate/types.ts` | 修改 | 新增 `thinkingBudget`、`maxTokens` 字段 |
| `src/escalate/anthropic-protocol.ts` | **新建** | 纯格式操作层：body 构造、响应解析、流式解析、合成事件、index 重写器、消息构造 |
| `src/escalate/sse-buffer.ts` | **重写** | OpenAI 格式 → Anthropic 格式（`anthropicEvent` 代替 `delta`/`done`） |
| `src/escalate/server.ts` | 修改 | 路由 `/v1/messages` 为主入口（保留旧路由别名），`buildEscalateApp` 同步更新 |
| `src/escalate/contract.ts` | **重写** | Anthropic-native：`injectContract` 操作顶层 `system` 字段；`injectAdvisorTool` 用 `{name,description,input_schema}`；移除 `ChatCompletionMessage`/`ChatCompletionRequestBody` |
| `src/escalate/dispatcher.ts` | **完全重写** | ~2000 行 Anthropic 格式迁移：`callUpstream` URL→`/v1/messages`，auth→`x-api-key`+`anthropic-version`；所有 peek 方法使用 Anthropic SSE 事件；合成事件委托到协议层 |
| `src/escalate/sticky.ts` | 修改 | `ChatCompletionMessage`→`AnthropicMessage`，`fingerprintMessages` 处理 content block 数组 |
| `src/commands/escalate.ts` | 修改 | 加载 `thinkingBudget`(默认8000)、`maxTokens`(默认4096)；默认 apiBase→`http://localhost:2302`；banner 增加新字段 |
| `src/code-index/interfaces/config.ts` | 修改 | `CodeIndexConfig` 新增 `escalateThinkingBudget`、`escalateMaxTokens` |
| `src/commands/config/metadata.ts` | 修改 | 新增 config metadata 定义 |
| `src/escalate/__tests__/sse-buffer.spec.ts` | 修改 | `delta`/`done`→`anthropicEvent`，Anthropic 事件格式 mock |
| `src/escalate/__tests__/contract.spec.ts` | 修改 | `system` 字段注入、`AnthropicTool` 类型、bracket notation |
| `src/escalate/__tests__/dispatcher.spec.ts` | 修改 | `makeConfig` 增加 `thinkingBudget`/`maxTokens` |
| `src/escalate/__tests__/e2e.spec.ts` | 修改 | `makeConfig` 增加 `thinkingBudget`/`maxTokens` |
| `src/escalate/__tests__/abort-propagation.spec.ts` | 修改 | `makeConfig` 增加 `thinkingBudget`/`maxTokens` |
| `scripts/evidence/290629-anthropic-sse-format.ts` | **新建** | Anthropic SSE 格式验证脚本 |

**实施中发现并修复的 bug：**

1. **`message_delta`/`message_stop` 在 peeking 模式被吞掉**（`dispatcher.ts` peekTierStream / peekAdvisorStream）
   - **现象：** proxy 输出 SSE 流缺少 `message_delta`/`message_stop` 终止事件（纯 thinking 响应场景），客户端看到流提前终止
   - **根因：** peeking 模式下 `message_delta`/`message_stop` 被无条件 `continue` 吞掉；passthrough 切换发生在首个 text_delta 触发 `no-marker` 之后——纯 thinking 响应无 text 块，永远不进入 passthrough
   - **修复：** `peekTierStream` 改为转发（marker 检测会 cancel reader，终止事件不可能在 marker 后到达）；`peekAdvisorStream` 改为缓存到 `passthroughBytes`（passthrough 时刷新，advisor 检测到则 cancel reader 丢弃）

2. **验证脚本 JSON 截断导致 `message.id` 检查失败**（`290629-anthropic-sse-format.ts`）
   - **现象：** `message_start` 事件的 raw payload 被截断到 200 chars→`JSON.parse` 失败
   - **修复：** 存储完整 `parsed` 对象，直接从对象读取 `message.id`

3. **中间子流 `message_delta`/`message_stop` 的 `event:` 行泄漏**（`peekAdvisorStream`）
   - **现象：** advisor 模式输出中出现孤立的 `event: message_delta` / `event: message_stop` 行（无配对 `data:` 行）
   - **根因：** `data:` 行被缓冲到 `passthroughBytes`，但 `event:` 行和空白分隔行被无条件转发。advisor 检测后 `data:` 行被丢弃，`event:` 行已发出
   - **修复：** 新增 `inTerminationEvent` 标志，当看到 `event: message_delta`/`message_stop` 时进入缓冲模式，将 `event:` + `data:` + 空白行作为一个整体缓冲

4. **Pro 子流的 `message_start`/`message_delta`/`message_stop` 泄漏**（`streamProAsReasoning`）
   - **现象：** 客户端看到 pro 子流的 `message_start`（重复 message_start），以及 pro 的终止事件
   - **根因：** `streamProAsReasoning` 只吞咽 `data:` 行，对应的 `event:` 行通过 fallback 转发路径泄漏
   - **修复：** 新增 `swallowing` 标志，完整吞咽 `message_start`/`message_delta`/`message_stop` 的 `event:` + `data:` + 空白行

5. **合成事件 index 硬编码为 0**（`anthropic-protocol.ts`）
   - **现象：** `buildAdvisorBeginEvent`/`buildAdvisorEndEvent`/`buildTierSwitchEvent`/`buildProxyErrorEvent` 的 content_block index 全为 0，导致客户端看到 index 跳跃
   - **修复：** 4 个 builder 函数增加 `rewriter: ContentBlockIndexRewriter` 参数，使用 `rewriter.allocate()` 分配连续 index

6. **Content block index 不连续——tool_use block 事件被丢弃后 index 留下空洞**（`peekAdvisorStream`）
   - **现象：** advisor 检测后 tool_use block 的 buffered 事件被丢弃，但 `rewriteIndexInLine` 已为其分配了 index，导致后续事件 index 跳跃
   - **修复：** `ContentBlockIndexRewriter` 增加 `saveCheckpoint()`/`restoreCheckpoint()`/`discardCheckpoint()`。tool_use block 开始前保存 checkpoint，advisor 检测到时 `restoreCheckpoint()` 回滚 index 计数器

7. **中间 `message_start` 泄漏**（第二轮 flash retry 的 `message_start`）
   - **现象：** advisor 循环中第二轮 flash retry 的 `message_start` 被转发到客户端，违反一个流一个 `message_start` 的预期
   - **修复：** `peekAdvisorStream` 增加 `swallowMessageStart` 参数，第一轮 `false`（转发），后续轮 `true`（完整吞咽）

8. **合成事件 thinking 内容重复**（`anthropic-protocol.ts`）
   - **现象：** `content_block_start.thinking` 和 `content_block_delta.thinking` 都包含完整文本，客户端显示两次
   - **修复：** `content_block_start.thinking` 改为空字符串 `""`，正文只在 `content_block_delta` 出现

9. **孤立 `event:` 行泄漏 + `event:`/`data:` 配对断裂**（`peekAdvisorStream`）
   - **现象：** tool_use block 的 `event:` 行和 `data:` 行被分到不同 buffer，flush 后 `event:` 行出现在 `data:` 行前面或孤立存在
   - **根因：** (a) `event:` 行被提前转发而 `data:` 行被缓冲；(b) `flushPendingEvent` 在 `flushPassthrough` 之前调用，导致 event 行被提前 flush
   - **修复：** (a) 新增 `pendingEventLine` 机制——content_block `event:` 行延迟到 `data:` 行到达后一起处理；新增 `isOrphanedContentBlockEvent` helper 丢弃无配对 `data:` 的孤立 `event:` 行；(b) `flushPendingEvent` 调用移到 `flushPassthrough` 之后，确保 event 行和 data 行始终在同一个 buffer

**验证结果（`290629-anthropic-sse-format.ts`）：**

```
=== 基础对话-带thinking ===     ✅ 通过  (event:=data: 完全配对, indices 0-N 连续)
=== 基础对话-无thinking ===      ✅ 通过  (event:=data: 完全配对, indices 0-N 连续)
=== 测试advisor ===             ✅ 通过  (event:=data: 完全配对, indices 0-N 连续)
```

所有检查项：
- ✅ 所有 data 行都是有效 Anthropic Stream Event（有 `type` 字段）
- ✅ `message_start.message.id` 存在
- ✅ 事件序列合规：`message_start → content_block_* → message_delta → message_stop`
- ✅ 无 `[DONE]`
- ✅ `message_stop` 仅在最末尾出现一次
- ✅ Content block indices 为连续非负整数
- ✅ `event:` 行与 `data:` 行完全配对（无孤立 event 行）
- ✅ 中间子流的 `message_start`/`message_delta`/`message_stop` 不泄漏
- ✅ 合成事件（advisor begin/end、tier switch）index 连续

### 2026-06-29 — advisor 流 text/thinking 语义 + content block index 合规修复

> 阶段 1-5 完成后，通过真实流量（`test5.log`）发现 3 项语义/格式 bug。前一轮的 `index 连续` 检查是假象（连续但不共享）。

**新增 bug 修复（10-12）：**

10. **flash 第一轮 text 泄漏为 `text_delta`**（`peekAdvisorStream`）
    - **现象：** advisor 模式下 flash 调 advisor 之前输出的过渡语（如“好的，我来测试一下 advisor 工具。”）被作为 `text_delta` 透传，客户端看到两段 text（过渡语 + flash retry 真正答案）
    - **根因：** 遇 tool_use block 时 `flushPassthrough()` 把缓冲的 flash text block 原样输出；但这段 text 只是过渡语
    - **修复：** 遇 tool_use 时若之前缓冲了 text block，用 `buildThinkingBlockBytes` 重写为 thinking block（`text`→`thinking`、`text_delta`→`thinking_delta`）；checkpoint 回滚原 text block 的 index 后重新分配共享 index

11. **pro 段 `content_block_start` 类型未重写 + delta index 未走 rewriter**（`streamProAsReasoning`）
    - **现象：** pro 的 text block 的 `content_block_delta` 被重写成 `thinking_delta`，但 `content_block_start` 仍是 `type:text`（类型与 delta 不匹配）；且 delta 重写用了原始 `event.index`
    - **根因：** 只重写 delta 类型不重写 block 类型；手动构造 delta 时直接用 `event.index`
    - **修复：** 加 `content_block_start` text→thinking 重写分支；delta 的 index 改用 `rewriter.rewriteBlockIndex`

12. **content block index：同一 block 的 start/delta/stop 各占一个 index**（`ContentBlockIndexRewriter`）
    - **现象：** 同一 block 的 start/delta/stop 事件 index 递增（start=0, delta=1, delta=2, stop=3），违反 Anthropic 规范（应共享同一 index）
    - **根因：** `rewriteIndexInLine` 对每个事件都 `allocate()`；4 个合成事件 builder 各 allocate 3 次
    - **修复：** `ContentBlockIndexRewriter` 增加 `indexMap`（per-sub-stream original→rewritten 映射）+ `rewriteBlockIndex(orig, isBlockStart)`（同 block 复用）+ `beginSubStream()`（子流切换重置映射）；`rewriteIndexInLine`/`streamProAsReasoning` 改用 `rewriteBlockIndex`；4 个 builder 改 allocate 1 次；4 个子流入口（peekTierStream/peekAdvisorStream/streamProAsReasoning/pumpReaderToController）加 `beginSubStream()`

**验证结果（`290629-advisor-text-leak.ts`，4/4 通过）：**

```
✅ flash 段无 text 泄漏, pro 段无 text 泄漏, index 合规（7-8 个 block, idx 连续无空洞）
```

- ✅ flash 调 advisor 前的过渡语已重写为 thinking_delta（不再泄漏为最终 text）
- ✅ pro 段全部重写为 thinking（无 text_delta / 无 type:text 的 content_block_start）
- ✅ 同一 block 的 start/delta/stop 共享 index（如 225 个事件仅 8 个 index）
- ✅ 不同 block 的 index 连续递增，无空洞

**改动文件：**
- `src/escalate/anthropic-protocol.ts` — `ContentBlockIndexRewriter` 重构（indexMap + beginSubStream + rewriteBlockIndex，删无调用的 rewriteDataLine/current）+ 4 个合成事件 builder 改 allocate 1 次
- `src/escalate/dispatcher.ts` — `rewriteIndexInLine`/`streamProAsReasoning` 改用 rewriteBlockIndex；`peekAdvisorStream` 加 flash text→thinking 重写（`buildThinkingBlockBytes`）；4 个子流入口加 `beginSubStream()`

**验证脚本：** `scripts/evidence/290629-advisor-text-leak.ts`（合并原 flash-text-leak + pro-text-leak）

## 修订记录

| 日期 | 修订内容 |
|------|---------|
| 2026-06-29 | 阶段 1-5 核心代码实施完成：types、protocol、sse-buffer、server、contract、dispatcher、sticky、commands 全部迁移到 Anthropic 格式 |
| 2026-06-29 | 修复 `message_delta`/`message_stop` peeking 模式吞事件 bug |
| 2026-06-29 | 创建 `290629-anthropic-sse-format.ts` 验证脚本 |
| 2026-06-29 | 更新 `CodeIndexConfig`、`config/metadata.ts` 的 escalate 配置字段 |
| 2026-06-29 | 修复 advisor 模式 SSE 格式 7 项 bug：中间终止事件泄漏、pro message_start 泄漏、合成事件 index 硬编码、index 不连续（checkpoint 机制）、中间 message_start 泄漏、thinking 内容重复、event:/data: 配对断裂 |
| 2026-06-29 | 修复 advisor 流 text/thinking 语义 3 项 bug：flash 第一轮 text 泄漏（过渡语未重写为 thinking）、pro 段 content_block_start 类型未重写、index 重写器同 block 不共享 index（加 indexMap + rewriteBlockIndex + beginSubStream） |

## 总结

**已完成：** escalate proxy 的核心代码（Phase 1-5）全部完成 Anthropic Messages API 格式迁移。类型检查 0 错误，核心测试通过。

**关键成果：**
1. **协议层抽离** — `anthropic-protocol.ts` 将纯格式操作集中管理，dispatcher 回归编排逻辑
2. **单向迁移** — 不保留 OpenAI 格式支持，所有接口统一为 Anthropic
3. **content block index 重写** — 通过 `ContentBlockIndexRewriter`（含 checkpoint 机制）实现跨子流连续索引
4. **thinking 透传策略** — 客户端未传时注入预设，已传则透传
5. **SSE event:/data: 配对保证** — `pendingEventLine` 延迟机制 + `isOrphanedContentBlockEvent` 孤立行丢弃，确保 event 行和 data 行始终配对
6. **中间子流隔离** — advisor 循环中除第一轮外的 `message_start`/`message_delta`/`message_stop` 均被完整吞咽，客户端只看到一个完整的 message 生命周期
7. **验证脚本** — `290629-anthropic-sse-format.ts` 可复现验证 SSE 格式合规性

**待完成（Phase 6）：**
- `dispatcher.spec.ts` 的 mock 数据全面迁移到 Anthropic 格式（当前仅修复编译错误）
- `e2e.spec.ts` 的 mock upstream 适配 Anthropic 响应格式
- advisor 模式的完整 streaming e2e 测试
