# 260624-advisor-mode

## 主题/需求

新增 `advisor` 升级模式：注入虚拟 `advisor` 工具到请求中，flash 模型通过**原生 tool call** 调用顾问，proxy 拦截后发给 pro 模型分析，将 tool call + pro 分析作为 tool result 返回给 flash，flash 综合后输出最终回答。

与 `self-report` 模式对比：

| | self-report (现有) | advisor (待实现) |
|---|---|---|
| 触发方式 | 模型输出 `<<<NEEDS_PRO>>>` 文本标记 | 模型调用 `advisor` tool |
| 升级策略 | 整轮切换模型 | flash 保持控制，pro 作为顾问 |
| pro 输出可见性 | 升级后 pro 直接输出给客户端（content） | pro 输出注入 reasoning_content（think 面板可见可折叠） |
| 每轮 pro 调用 | 1 次 | 0 到 N 次（可递归） |
| 适用场景 | 完全超出 flash 能力 | flash 能做但需要更强参考意见 |

**核心流程：**

```
第三方客户端 ──→ Proxy Server ──→ DeepSeek API
                     │
                     ├─ 注入 advisor tool 定义到 tools 数组
                     ├─ 注入 advisor 使用说明到 system prompt
                     ├─ flash reasoning_content → 实时透传客户端
                     ├─ flash tool_call (advisor) → 拦截，不发给客户端
                     ├─ 调 pro（完整 messages，过滤 tools）
                     ├─ pro 分析 → 注入 client think 面板 (reasoning_content)
                     ├─ 构造 tool result { tool_call_id, role: tool, content: pro分析 }
                     ├─ 重新调 flash（追加 tool_call + tool_result 到 messages）
                     └─ flash 最终 content → 实时透传客户端
```

## 代码背景

### 相关文件

| 文件 | 说明 |
|------|------|
| `src/escalate/types.ts` | `EscalationMode` 类型已定义 `'advisor'` |
| `src/escalate/contract.ts` | `injectContract()` — 可复用注入系统提示；需新增 `injectAdvisorTool()` |
| `src/escalate/dispatcher.ts` | `EscalateDispatcher` — 需新增 `dispatchAdvisor()` / `dispatchAdvisorStream()` |
| `src/escalate/sse-buffer.ts` | `SseLineBuffer` — 已支持 tool_calls delta 解析 |
| `src/escalate/server.ts` | 路由层，根据 mode 选择 dispatcher 路径 |

### 现有基础设施

| 能力 | 位置 | 复用方式 |
|------|------|----------|
| `peekTierStream()` | `src/escalate/dispatcher.ts:849` | 扩展：新增 tool_call delta 检测分支 |
| `SseLineBuffer` | `src/escalate/sse-buffer.ts` | 已有 `line.delta.tool_calls` 字段 |
| `buildTierSwitchEvent()` | `src/escalate/dispatcher.ts:240` | 复用构造 advisor 分隔标记 |
| SSE 注入管线 | dispatcher 各处 | 同模式，只换注入内容 |
| `EscalateConfig` | `src/escalate/types.ts` | `mode: 'advisor'` 创建时选择路径 |

## 关键决策

### 决策 1：tool call 协议 — 透明拦截 + 完成后 tool result

flash 输出的 tool_call 不转发给客户端。proxy 拦截后完成 pro 调用，将 `tool_call message` + `tool result message` 追加到 messages，重新调 flash。

```
flash stream:
  delta.tool_calls = [{ index: 0, function: { name: "advisor", arguments: '{"question":"..."}' } }]
  finish_reason = "tool_calls"
  ↑ proxy 拦截，不发给客户端

proxy:
  1. 提取 advisor 的 question 参数
  2. 调用 pro (完整 messages，过滤 tools)
  3. 流式读取 pro 回复 (reasoning_content + content)
  4. 注入 pro 分析到客户端 think (reasoning_content delta)
  5. 构造 tool result，追加到 messages
  6. 重新调 flash（非流式或流式）

flash retry stream:
  delta.content = "根据advisor的分析，你的权限模型应该..."  → 透传客户端
```

### 决策 2：tool 注入 — 追加到客户端 tools + system prompt

```json
{
  "tools": [
    ...client_tools,  // 保留客户端原有 tools
    {
      "type": "function",
      "function": {
        "name": "advisor",
        "description": "当遇到以下情况时调用此工具：1) 用户需求模糊、不确定；2) 面临多个方案需要权衡；3) 工具调用返回意外结果；4) 同一问题尝试2次仍无法解决；5) 涉及复杂的跨文件重构、并发安全、正确性验证。调用后你会获得 pro 模型的深度分析，综合后回答用户。",
        "parameters": {
          "type": "object",
          "properties": {
            "question": {
              "type": "string",
              "description": "你需要顾问帮助的具体问题，要具体、有上下文"
            }
          },
          "required": ["question"]
        }
      }
    }
  ]
}
```

**为什么不替换 tools：** 客户端可能依赖自己的 tool call 白名单。追加比替换更安全。

**idempotency：** 如果 tools 数组中已有 `name: "advisor"` 的条目，跳过注入（同 contract sentinel 模式）。

### 决策 3：pro 输出可见性 — reasoning_content 透传

```
客户端 think 面板时间线：

  [flash 原生 think...]

  <proxy-advisor-consult question="<question>">

    ## 分析过程
    (pro 的 reasoning_content)

    ## 结论
    (pro 的 content)

  </proxy-advisor-consult>

  (flash retry 的 reasoning_content)    ← flash 综合 pro 分析的 think

  [flash 综合后的最终回答]              ← content
```

- pro 的分析过程 + 结论全部作为 `reasoning_content` delta 注入
- 客户端 think 面板天然支持折叠
- 不污染 `content`（最终答案区域）

### 决策 4：发给 pro 时移除 `tools` 数组

```typescript
function buildProBodyForAdvisor(body: ChatCompletionRequestBody): ChatCompletionRequestBody {
  const { tools, tool_choice, ...rest } = body
  return rest as ChatCompletionRequestBody
}
```

- 移除请求 body 中的 `tools` 字段（pro 不需要工具定义）
- 移除 `tool_choice`（配合 tools 的字段）
- messages 中的 tool_call / tool_result 历史**全部保留**（pro 需要看到完整对话）

### 决策 5：允许递归 — flash 可多次调用 advisor

flash retry 的请求**仍带 advisor tool 定义**。如果 flash 在拿到 pro 分析后仍然不确定，可以再次调用 advisor。每次 advisor 调用对应一次 pro 请求。

客户端看到的多层 think 结构：

```
[flash think] → [advisor] → [pro 分析] → [flash think] → [advisor] → [pro 分析] → [flash think] → [最终 content]
```

不设硬上限，实际使用中很少超过 2 次。

### 决策 6：流式路径时序

```
客户端时间线：

  T1   flash reasoning_content        → 实时透传（同 v4）
  T2   flash content 前几个 chunk     → buffer（不发）
  T3   flash delta.tool_calls         → 检测到 advisor
  T4   → 丢弃 buffer 中的 flash content
  T5   advisor 分隔标记              → reasoning_content delta
  T6   pro reasoning_content + content → reasoning_content delta（流式）
  T7   回落标记                       → reasoning_content delta
  T8   flash retry content            → 透传客户端（最终答案）

客户端感受：
  - think: 出现 advisor 分隔 + pro 分析（可折叠）
  - content: 只看到 flash 综合后的最终答案
  - 不知道发生过 tool call / 重试
```

## 实施计划

- [ ] **阶段 1：tool 注入**
  - `src/escalate/contract.ts` — 新增 `injectAdvisorTool(body)` 函数
  - 追加 advisor 定义到 `tools` 数组
  - 在 system prompt 追加 advisor 使用说明
  - idempotency 检测

- [ ] **阶段 2：dispatcher 非流式路径**
  - `src/escalate/dispatcher.ts` — 新增 `dispatchAdvisorNonStream(rawBody, clientHeaders)`
  - 调 flash（带 advisor tool）
  - 检测 `finish_reason: "tool_calls"` + tool name: "advisor"
  - 提取 question，调 pro（过滤 messages）
  - 构造 tool result，重新调 flash
  - 返回最终 flash 响应

- [ ] **阶段 3：dispatcher 流式路径**
  - `src/escalate/dispatcher.ts` — 新增 `dispatchAdvisorStream(rawBody, clientHeaders)`
  - 扩展 `peekTierStream` 或新增专用 peek
  - 检测 `delta.tool_calls` 中的 advisor 调用
  - 拦截后构造 ReadableStream：
    - 注入 advisor 分隔标记
    - 流式注入 pro 回复
    - 注入回落标记
    - 调 flash retry → pump 到 client

- [ ] **阶段 4：mode 路由**
  - `src/escalate/dispatcher.ts` — `dispatch()` 根据 `config.mode` 路由
  - `self-report` → 现有逻辑
  - `advisor` → 新逻辑

- [ ] **阶段 5：CLI + 配置**
  - `src/commands/escalate.ts` — banner 显示 `advisor` 模式信息

- [ ] **阶段 6：测试**
  - `contract.ts` — `injectAdvisorTool` 单元测试
  - `dispatcher.ts` — 非流式 advisor 路径测试
  - `dispatcher.ts` — 流式 advisor 路径测试
  - e2e — 完整 advisor 流程测试

## 实施记录

### 2026-06-24 — 阶段 6 实施 (测试)

- 添加 `contract.spec.ts` 中的 advisor 单元测试 (12 个新测试)
- 添加 `dispatcher.spec.ts` 中的 advisor dispatcher 测试:
  - 非流式路径: 8 个测试 (passthrough, 注入, 单次调用, tool result, 递归, 错误处理, passthrough non-advisor tool, client tools 保留)
  - 流式路径: 4 个测试 (passthrough, 完整拦截 + pro 注入 reasoning, pro 无 tools, tool result in retry)
- 修复 `sse-buffer.ts` 中的 `finish_reason` 解析 (从 `c0` 而不是 `delta`)

### 2026-06-24 — 阶段 1-6 完成

- 阶段 1 (tool 注入): 完成 - `injectAdvisorTool()` + advisor tool 定义 + system prompt fragment
- 阶段 2 (dispatcher 非流式): 完成 - `dispatchAdvisorNonStream()` + 完整循环支持递归
- 阶段 3 (dispatcher 流式): 完成 - `dispatchAdvisorStream()` + `peekAdvisorStream()` + `streamProAsReasoning()`
- 阶段 4 (mode 路由): 完成 - `dispatch()` 根据 `config.mode` 路由
- 阶段 5 (CLI banner): 完成 - escalate.ts banner 反映 `advisor` tool 名称
- 阶段 6 (测试): 完成 - 32 个 dispatcher 测试 + 22 个 contract 测试 全部通过

## 修订记录

### 2026-06-24 — 阶段 1-6 完成

- 阶段 1 (tool 注入): 完成 - `injectAdvisorTool()` + advisor tool 定义 + system prompt fragment
- 阶段 2 (dispatcher 非流式): 完成 - `dispatchAdvisorNonStream()` + 完整循环支持递归
- 阶段 3 (dispatcher 流式): 完成 - `dispatchAdvisorStream()` + `peekAdvisorStream()` + `streamProAsReasoning()`
- 阶段 4 (mode 路由): 完成 - `dispatch()` 根据 `config.mode` 路由
- 阶段 5 (CLI banner): 完成 - escalate.ts banner 反映 `advisor` tool 名称
- 阶段 6 (测试): 完成 - 32 个 dispatcher 测试 + 22 个 contract 测试 全部通过

### 2026-06-24 — 修订: advisor 模式不再注入 tier contract

**问题：** `buildFlashAdvisorBody()` 之前调用了 `injectContract()`,导致 advisor 模式的 flash 调用依然注入了 `<<<NEEDS_PRO>>>` 文本标记的完整说明。与 advisor fragment 中明确说明的 "<<<NEEDS_PRO>>> marker is NOT active here" 矛盾,会让模型混淆于两种不同的升级渠道。

**修复：**
- `buildFlashAdvisorBody()` 改为只调用 `injectAdvisorTool()`,不再调用 `injectContract()`
- 手动设置 `model: this.config.flashModel` 补偿移除的 `injectContract()` 副作用
- 测试增强:`injects the advisor tool and fragment on the flash call` 现在验证 system prompt 不包含 "Tier escalation instruction" 等 self-report contract 的特征文本

**原因：** advisor 模式与 self-report 模式是两种独立的升级策略,不应混用。advisor 模式仅依赖原生的 `advisor` tool call,所有升级都通过 tool_call 机制表达。

### 2026-06-24 — 修订: advisor fragment 清理 `<<<NEEDS_PRO>>>` 提到

**问题：** advisor fragment 中仍然提到 `<<<NEEDS_PRO>>>` 标记 ("The `<<<NEEDS_PRO>>>` marker is NOT active here"),以及"If asked which model you are" 元信息。

**修复：**
- 移除这两段表述,fragment 仅描述 advisor tool 的使用场景与调用方式
- advisor 模式下 `<<<NEEDS_PRO>>>` 本来就不存在,提及它会让模型拉回到 self-report 概念

### 2026-06-24 — 修订: advisor 模式 pro 端不注入任何 system prompt contract

**问题：** `buildProAdvisorBody()` 之前调用了 `injectContract(..., pro, pro)` 注入 pro contract。pro contract 中包含 "Two markers are available across the system — `<<<NEEDS_PRO>>>` and `<<<NEEDS_FLASH>>>`" 这类 self-report 说明,但 advisor 模式下 pro 是被动的顾问,不应该被注入任何与 self-report 标记相关的说明。

**修复：**
- `buildProAdvisorBody()` 不再调用 `injectContract()`,只设置 `model: proModelId` 并 strip `tools`/`tool_choice`
- pro 收到的请求只包含客户的原始 system message(如果有) + assistant tool_calls + tool result 历史
- 客户配置的 `system` 消息原样透传

**原因：** advisor 模式与 self-report 模式是两种独立的升级策略。advisor 模式下,pro 不需要知道 `<<<NEEDS_FLASH>>>` 降级标记(它是被动顾问,只是回答问题)。


### 2026-06-29 — 文档补充: 记录客户端断开传播 (abort propagation) 行为

**背景：** escalate proxy 一直有个未被文档记录的行为：客户端断开连接时，proxy 会把 cancel 信号传播到 upstream，中止 in-flight fetch（避免 upstream 继续算、浪费 token/资源）。该行为此前只在代码注释和测试文件里有体现。

**实现位置：** `src/escalate/dispatcher.ts` 的 `callUpstream()` —— 将客户端断开信号 (`clientSignal`) 与内部超时 (`UPSTREAM_TIMEOUT_MS`) 通过 `AbortSignal.any([...])` 合并后传给 upstream fetch：

```typescript
// Combine the internal timeout with the client-disconnect signal so that
// the upstream fetch is aborted as soon as the client walks away.
const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
const effectiveSignal = clientSignal
  ? AbortSignal.any([timeoutSignal, clientSignal])
  : timeoutSignal
```

advisor 模式下，`dispatchAdvisorStream()` 进一步用本地 `AbortController` (`localAbort`) 桥接 `clientSignal`，并在 `cancel(reason)` 回调里 `localAbort.abort()` + `currentReader?.cancel()`，确保 pro/flash 任意阶段客户端断开都能传播到当前 upstream reader。

**测试覆盖：** `src/escalate/__tests__/abort-propagation.spec.ts`（e2e，2 个用例）—— 验证非流式 + 流式两种场景下，客户端 abort 后 upstream 连接被关闭 (`lifecycle.aborted === true`)。

### 2026-06-29 — 修订: 修复 streamProAsReasoning 泄漏 pro 子流 [DONE] 导致 flash retry 被吞

**问题：** `streamProAsReasoning()` 把 pro 子流的 `data: [DONE]` 转发给客户端。真实 SSE 客户端（Cline/EventSource）收到 `[DONE]` 后认为整个流结束并停止读取，导致后续的 advisor end 分隔符 + flash retry 的最终内容**全部丢失**。表现为：客户端只看到 pro 分析（think 面板），看不到 flash 综合后的最终答案（content 区域为空）。用户称“最后一个 flash 的响应被吞了，有发请求但没有转发”。

curl 黑盒测试无法复现（curl 不解析 SSE 语义，读完整个字节流），只有真实 SSE 客户端受影响。

**根因：** `data: [DONE]` 行的 `line.delta` 为 undefined，命中 `if (!line.isData || !line.delta)` 分支被 `controller.enqueue(line.bytes)` 转发。pro 的 `[DONE]` 只标记 pro 子流结束，不应终止整个客户端流。

**修复：** `streamProAsReasoning` 循环开头加 `if (line.done) continue`，吞掉 pro 的 `[DONE]`。整个客户端流由 flash retry 的最终 `[DONE]`（passthrough 时转发）终止。

**验证：**
- 对比：修复前 `[DONE]=2`（pro 中间 + flash 末尾），第一个在中间致其后 flash 事件丢失；修复后 `[DONE]=1`（仅末尾）
- 单元测试：advisor stream 测试加 [DONE] 位置断言（只 1 次 + 在最后），154 测试全过
- 复现脚本 `scripts/evidence/290629-sse-missing-id.ts` 加 [DONE] 检查

### 2026-06-29 — 修订: 合成 SSE 事件补齐 id/object/created/model 字段

**问题：** proxy 注入的合成事件（`buildAdvisorBeginEvent`、`buildAdvisorEndEvent`、`buildTierSwitchEvent`、`buildProxyErrorEvent`）只有 `choices`，缺少 `id`/`object`/`created`/`model` 字段。`streamProAsReasoning` 重写 content→reasoning_content 时也丢弃了原始事件的顶层字段。上游 DeepSeek API 的事件都带这些字段，注入事件不一致。

**修复：**
- 4 个合成事件函数新增 `model` 参数，payload 补齐 `id: randomUUID()`、`object: 'chat.completion.chunk'`、`created: Math.floor(Date.now()/1000)`、`model`
- 调用点按语义传 model（advisor 段/pro 调用失败→proModel；flash 段/降级→flashModel）
- `streamProAsReasoning` 改为 `{ ...parsed, choices: [...] }` spread，保留原始事件全部顶层字段

### 2026-06-28 — 修订: 修复 advisor 流式路径 content 事件空行丢失 + [DONE] 位置错误

**问题：** `peekAdvisorStream()` 中，空行分隔符、`[DONE]` 信号被立即转发，但 content/tool_call 数据行被缓冲到流结束才 flush。导致 SSE 输出顺序重排：空行和 [DONE] 出现在 content 之前，content 事件之间失去 `\n\n` 分隔符。SSE 客户端将连续多个 `data:` 行拼接为单事件，`JSON.parse()` 失败：

```
SyntaxError: Unexpected non-whitespace character after JSON at position 319
```

**修复：** 引入 `bufMode` 标志位。content/tool_call 行缓冲时进入 buffering 状态（`bufMode=true`），后续的空行、`[DONE]`、非 delta 数据行（如 cost 事件）全部跟随缓冲，保持 `data:\n\n` 的正确顺序。reasoning 行立即转发并重置 `bufMode=false`。

**验证：** 复现脚本 `scripts/evidence/280628-sse-content-blank-line-loss.ts` confirm 空行缺失=0，[DONE] 位置正确。全部 36 个 dispatcher 测试通过。

### 2026-06-27 — 修订: pro 不再保留 advisor tool 定义

**问题：** `buildProAdvisorBody()` 在 strip 客户端 tools 后又调用 `injectAdvisorTool()`，导致 pro 仍然持有 advisor tool 定义。当用户问题涉及 tool 行为（如"测试下advisor"）时，pro 可能自己调用 advisor tool，返回 `content: null` + `tool_calls`，导致 tool result 的 content 为空字符串。flash 看到空 tool result 后误判 "advisor 工具调用成功"。

**修复：**
- `buildProAdvisorBody()` 改为 strip **所有** tools 和 tool_choice，不再调用 `injectAdvisorTool()`
- pro 是纯被动顾问，不应拥有任何 tool 定义

**原因：** pro 不需要 tool 定义来理解对话中的 tool_call 历史 — messages 中的 assistant tool_call + tool result 已提供足够上下文。

### 2026-06-27 — 修订: advisor question 作为 user 消息发送给 pro

**问题：** flash 调用 advisor 后，pro 只看到原始用户消息，看不到 flash 的具体问题（advisor question）。例如用户说"测试下advisor"，flash 的问题是"请确认 advisor 工具正常工作"，但 pro 收不到这个上下文。

**修复：**
- 使用已有的 `extractAdvisorQuestion()` 提取 question
- 以 `[Advisor consultation - do not call any tools, analyze and answer, do not repeat this prefix] {question}` 为前缀，追加为独立的 user 消息发给 pro
- 非流式和流式路径均已实现

### 2026-06-27 — 修订: 多次 advisor 调用改为递归顺序处理

**问题：** flash 一次响应可能返回多个 advisor tool_call。初版实现用 for 循环批量处理，将所有 tool result 与 assistant 消息一起追加到 workingMessages，导致调用看起来是并行的，不符合标准 tool call 协议（assistant tool_call → tool result 应一一对应）。

**修复：**
- 每次 flash 响应只取**第一个** advisor call 处理
- `firstCallOnly` 只包含一个 advisor call + 保留非 advisor tool call（如 read_file）
- 剩余 advisor call 由递归自然衔接：flash 重试时看到第一个 tool result，可能再次调用 advisor
- 新增 `extractAllAdvisorToolCalls()` 函数（保留供外部使用）

### 2026-06-27 — 修订: 保留 reasoning_content 以符合 DeepSeek thinking mode

**问题：** 构造 `firstCallOnly` 时丢弃了 flash assistant message 中的 `reasoning_content`。DeepSeek thinking mode 要求 reasoning_content 必须在后续请求中原样传回，否则返回 `invalid_request_error`。

**修复：**
- 非流式路径：`firstCallOnly` 保留 `assistantMsg['reasoning_content']`
- 流式路径：`peekAdvisorStream` 累积 `reasoningAcc`，写入返回的 `assistantMsg`；`firstCallOnly2` 同样保留

### 2026-06-27 — 修订: 合并 pro reasoning_content 到 tool result

**问题：** pro 使用 thinking 模型时，分析过程在 `reasoning_content` 中，`content` 可能只有简短结论。tool result 只取 `content` 会让 flash 丢失 pro 的详细分析。

**修复：**
- 非流式路径：合并 `reasoning_content` + `content` 为 `proFullContent`
- 流式路径：`streamProAsReasoning()` 同时累积 `reasoningAcc` 和 `contentAcc`，返回合并结果

### 2026-06-27 — 修订: 流式路径 passthrough 时保留非 advisor tool call 及 finish_reason

**问题：** `peekAdvisorStream` 中 tool_calls delta 行和 finish_reason 行被累积但从未 forward 给客户端。非 advisor 的普通 tool call（如 read_file）在 passthrough 时丢失。

**修复：**
- 统一 content、tool_calls、finish_reason 三类 delta 行到 `passthroughBytes` buffer
- passthrough 时完整 flush；advisor 拦截时丢弃
- 防重复：同一行只 buffer 一次

### 2026-06-27 — 修订: advisor begin 分隔符显示 question

**修复：** `buildAdvisorBeginEvent()` 接受可选的 `question` 参数，在 think 面板分隔符中展示：`--- [proxy: consulting advisor (pro): 完整问题] ---`

### 2026-06-27 — 修订: 日志输出

**修复：** 非流式和流式路径均输出两条 info 日志：
- `[escalate] advisor question: ...`
- `[escalate] pro response (N chars): ...`

### 2026-07-01 — 修订: advisor 标记 XML 化 + 回传剥离 + 常量抽离

**问题（路径 A — 客户端回传污染）：** proxy 注入客户端 think 面板的 advisor 分隔标记（`--- [proxy: consulting advisor (pro): Q] ---` … `--- [proxy: back to flash ...] ---`）被 agentic 客户端存进 assistant 消息 thinking 历史，下一轮原样发回。`callUpstream` 此前只调 `ensureAssistantThinkingBlocks`（补空 thinking），从不剥离这些标记 → flash/pro 反复看到"自己"的推理里嵌着伪造的 advisor 咨询 → 模仿标记、伪造咨询流程，pro 的第三人称视角（"给 flash 指导"）也让 flash 角色错乱。

**修复：**
1. **标记 XML 化 + 常量化：** think 面板分隔标记从 `--- [proxy: consulting advisor ...] ---` 改为 XML 配对标签 `<proxy-advisor-consult question="...">` … `</proxy-advisor-consult>`。标签名抽离为顶部常量 `ADVISOR_CONSULT_TAG`（`anthropic-protocol.ts`），注入（`buildAdvisorBeginEvent`/`buildAdvisorEndEvent`）与剥离共用同一常量；`escapeXmlAttr` 处理 question 属性转义。
2. **路径 A — 出口剥离：** 新增 `stripAdvisorMarkersFromThinking(messages)`，在 `callUpstream`（所有上游请求唯一出口）`ensureAssistantThinkingBlocks` 之后调用，把任何 assistant thinking block 里 `<proxy-advisor-consult …>…</proxy-advisor-consult>` 整段删掉，只保留模型自己的推理。flash/pro 再也看不到伪造咨询。
3. **forced / 原生 advisor prompt 前缀常量化：** forced 的 `FORCED_ADVISOR_PROMPT_PREFIX`（`[Forced advisor — … Task: ${q}]`）与原生（flash 自愿调）的 `ADVISOR_CONSULT_PROMPT_PREFIX`（`[Advisor consultation - …] ${q}`）各抽成顶部常量 + 构造 helper（`buildForcedAdvisorPrompt` / `buildAdvisorConsultPrompt`），消除内联魔术字符串。

**改动文件：** `src/escalate/anthropic-protocol.ts`（`ADVISOR_CONSULT_TAG` + helper + strip 函数 + begin/end event 复用）；`src/escalate/dispatcher.ts`（`callUpstream` 出口剥离；两处 prompt 前缀常量化）。

**验证：** type-check escalate 零错误；escalate 全套 7 文件 / 173 测试通过（含新增 7 个：路径 A 集成 1 + `stripAdvisorMarkersFromThinking` 纯函数 5 + 路径 B 详见 260630 同日修订）。

**注：** 上方决策 3 时间线已同步为 XML 标记展示。历史修订记录里的旧标记描述保留为当时记录。

### 2026-07-02 — 修订: pro 端注入 dummy `finish` tool + 流式 tool_use 透穿修复

**问题：** advisor 模式下 `buildProAdvisorBody` strip 了所有 tools，pro 作为纯文本顾问。但 agentic 模型在**无任何工具**时会陷入 reasoning 空转——反复输出"让我用工具实际检查代码""让我搜索与分割相关的增强代码""我将探索代码库以查找关键文件"等计划性废话，既消耗 token 又不产出有效建议。

**根因：** 这类模型的训练使其强烈倾向于"调工具收集信息再回答"。messages 里带着客户端的 tool_call/tool_result 历史，强化了"本对话有工具可用"的预期。但 body 里 tools 被完全 strip，模型在"想调工具"与"无工具可调"之间反复打转，无法收敛到"直接给文本建议"。

**修复：** 给 pro 注入**一个** dummy tool `finish`（`proFinishToolDefinition`，`contract.ts`），带 `done: boolean` 参数（required）：
- description 明确告知"你是 ADVISOR，没有其他工具，不能搜索/读取/运行代码，基于对话上下文分析，写完文本建议后调用 finish（done=true）表示完成"。
- pro 调用 finish 只是"压力释放阀"——满足它必须发 tool_call 的冲动，避免在 reasoning 里空转。
- proxy **完全忽略** pro 的 finish tool_call：非流式走 `extractTextFromBlocks` + `extractThinkingFromBlocks`（只取 text/thinking，跳过 tool_use block）；pro 的建议永远来自文本内容。

**透穿修复（流式）：** 初版上线后发现 finish tool_call 在**流式路径**透穿到客户端——`streamProAsReasoning` 的"转发所有其他行"fallback 把 pro 的 tool_use block 事件（content_block_start type=tool_use / input_json_delta / content_block_stop）原样转发给了客户端 SSE 流。修复：新增 `toolUseIndices` 集合，检测到 content_block_start 的 type=tool_use 时记录 index 并进入 swallowing，该 index 的后续 delta/stop 全部吞掉不转发。非流式路径本就只取 text block，不受影响。

**改动文件：**
- `src/escalate/contract.ts` — 新增 `proFinishToolDefinition`（name `finish`，`done: boolean` required）。
- `src/escalate/dispatcher.ts` — `buildProAdvisorBody` 注入 finish tool；`streamProAsReasoning` 新增 `toolUseIndices` 过滤 tool_use block（透穿修复）。
- `src/escalate/__tests__/dispatcher.spec.ts` — 3 处 `proBody.tools` 断言更新；新增 2 个测试：（1）非流式 pro 返回 text + finish tool_call → proxy 忽略 tool_call，tool_result 只含 text，finish 不泄漏进 flash history；（2）流式 pro 返回 text + finish tool_use block → 客户端 SSE 流不含 finish/tool_use（透穿修复验证）。

**验证：** type-check escalate 零错误；escalate 全套 7 文件 / 175 测试通过（新增 2），零回归。

## 总结

### 核心设计要点

1. **透明 Tool Call** — 客户端不感知 `advisor` tool，proxy 拦截并完成调用
2. **reasoning_content 透传** — pro 分析可见但可折叠，不污染最终 content
3. **标准协议** — 遵循 OpenAI tool call 规范（assistant tool_call + tool result）
4. **复用现有管线** — SSE 注入、peek 逻辑、消息过滤均基于 v4 基础设施
5. **允许递归** — flash retry 仍带 advisor tool，可多次调用顾问

### 与 self-report 的关系

两种模式共享 `EscalateDispatcher` 基础结构，通过 `config.mode` 在 `dispatch()` 入口分发。未来可以扩展到更多模式（如 hybrid：先 advisor 再 self-report fallback）。
