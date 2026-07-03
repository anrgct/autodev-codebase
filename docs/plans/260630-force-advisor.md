# 260630-force-advisor

## 主题/需求

advisor 模式依赖 flash **自愿**调用 `advisor` tool，但实际中 flash 经常不调用——无论 `advisor` tool 的 `description` 怎么写、怎么强调触发场景，flash 都倾向于直接作答或直接调客户端工具，绕过顾问。

新增**强制触发**机制：proxy 在固定时机主动伪造一次 advisor 调用，用预设 question 咨询 pro，把结果注入 messages 后再进入 flash 循环。**pro 必被咨询，question 100% 确定**。

三条触发规则（预设 question 写死，仅 `mode === 'advisor'` 生效）：

| 规则 | 触发条件 | 预设 question |
|------|---------|--------------|
| user-turn | messages 末尾是 user 且 content **不含** `tool_result` | 「我的用户指令理解对吗？」 |
| tool-error | messages 末尾是 user 含 `tool_result`，且末尾 `tool_result` 为 error | 「为什么工具报错？」 |
| tool-count | messages 末尾是 user 含 `tool_result`，且 history 中真实 tool_use 总数 N>0 且 N%5==0 | 「我的思路对吗？」 |

**优先级：** `tool-error` > `tool-count`；`user-turn` 与 `tool-*` 互斥（末尾状态不同）。每个请求至多触发一次。

## 代码背景

### 相关文件

| 文件 | 说明 |
|------|------|
| `src/escalate/dispatcher.ts` | `dispatchAdvisorNonStream` / `dispatchAdvisorStream` — advisor 主循环，强制触发入口 |
| `src/escalate/contract.ts` | `injectAdvisorTool` / `advisorToolDefinition` — advisor tool 注入 |
| `src/escalate/anthropic-protocol.ts` | 合成事件 + 消息构造；需新增 `buildMessageStartEvent` |
| `src/escalate/types.ts` | `EscalateConfig` — 需新增 `forceAdvisor` |
| `src/commands/escalate.ts` | 配置加载 + banner |
| `src/code-index/interfaces/config.ts` | `CodeIndexConfig` — 需新增 `escalateForceAdvisor` |

### 现有基础设施（复用）

| 能力 | 位置 | 复用方式 |
|------|------|----------|
| pro 请求构造 | `buildProAdvisorBody(rawBody, messages)` | 直接调用（已 strip tools/tool_choice） |
| tool_result 消息 | `buildToolResultMessage(toolUseId, content)` | 构造 forced advisor 的 result |
| assistant tool_use 消息 | `buildAssistantToolUseMessage(toolUseId, name, input)` | 构造 forced advisor 的 tool_use |
| 流式 pro→think 注入 | `streamProAsReasoning(reader, controller, rewriter)` | 流式预咨询复用 |
| think 分隔符 | `buildAdvisorBeginEvent` / `buildAdvisorEndEvent` | 标记 forced 咨询段 |
| 非流式 pro 解析 | `parseNonStreamResponse` + `extractTextFromBlocks` | 非流式预咨询复用 |
| advisor user 消息 | `extractAdvisorQuestion` 构造的 `[Advisor consultation ...]` | forced question 同格式 |

## 运行观测

### flash 不自愿调用 advisor

**现象：** advisor 模式上线后，实测 flash 极少调用 `advisor` tool。即使把 `description` 写满触发场景（ambiguous / trade-offs / tool failure / 2+ failed attempts / cross-file），flash 仍倾向于：
- 直接给出答案（即使需求模糊）
- 直接调客户端工具（read_file/grep 等），跳过顾问
- 工具报错后自行重试，不咨询

调整 `advisorToolDefinition.description` 措辞、加 "call DIRECTLY without preamble" 等强引导，调用率无明显改善。

**结论：** 依赖模型自愿的方案在 flash 这类小模型上不可靠，需要 proxy 层的确定性触发。

## 归因分析

### 为什么 flash 不调 advisor

1. **tool description 是软约束** — 模型可以遵守也可以忽略，flash 的指令遵循能力弱于 pro，倾向于走"最短路径"（直接答/直接做）。
2. **没有强制信号** — 当前 `buildFlashAdvisorBody` 只注入 tool 定义，不设 `tool_choice`，flash 完全自由选择。
3. **触发判断在模型侧** — "需求是否模糊""是否需要权衡"是主观判断，flash 判断能力弱，倾向乐观估计自己能处理。

### 为什么不直接 `tool_choice` 强制

Anthropic 的 `tool_choice: {type:'tool', name:'advisor'}` 能强制 flash 调 advisor，但：
- 强制后 flash **这一轮不能调任何其他工具**（包括 read_file/grep 等客户端工具），会打断 agentic 流程
- question 仍由 flash 组织，不保证是预设文案

→ 选择 proxy 伪造调用（方案 B）：flash 自由度保留 + pro 必被咨询 + question 确定。

### stateless 去重的依据

proxy 是 per-request stateless（`StickyStore` 仅 self-report 用，advisor 未用）。但 agentic 客户端的请求模式规整：
- 用户新消息 → 请求 messages 末尾是纯 user
- 工具循环 → 请求 messages 末尾是 user(tool_result)

因此基于 messages **末尾状态**判断触发，天然去重，无需内存计数器或 messages 内嵌 sentinel（见决策 2）。

## 关键决策

### 决策 1：方案 B — proxy 伪造 advisor tool_call

触发时（flash 循环之前）：
```
1. 伪造 advisorCall = { id: 'forced_<uuid>', name:'advisor', input:{ question: 预设 } }
2. 调 pro（buildProAdvisorBody，messages = workingMessages + advisorUserMsg）
3. 构造 [assistant tool_use(forced) + user tool_result] 追加到 workingMessages
4. 进入标准 flash 循环 — flash 第一轮就看到 history 里已有 advisor 结果
```

复用现有 advisor 分支全部基础设施。flash 仍可自由调客户端工具（不破坏 agentic 流程）。

### 决策 2：stateless 去重 — 基于 messages 末尾状态

- 末尾 user 纯文本 → 用户新 turn（规则 1）。后续请求末尾必为 tool_result，不会重复触发规则 1。
- 末尾 user(tool_result) → 工具循环中。tool_use 总数单调递增，5/10/15 是离散点，每个点只在对应 tool_result 完成后的那个请求出现一次。

无需内存状态、无需 messages sentinel。

### 决策 3：tool_use 计数排除 advisor 自身

规则 2 数 history 中所有 `type:'tool_use'` block，但**排除 `name==='advisor'`**。否则伪造的 forced 调用和模型自愿的 advisor 调用会污染计数，违背"每 5 次真实工具"语义。

### 决策 4：tool_result error 判定（启发式）

Anthropic `tool_result` 有标准 `is_error?: boolean`，但多数客户端返回 error 时只把错误写在 content 里。判定（满足任一即视为 error）：
- `block.is_error === true`
- `block.content` 为字符串且匹配 `/^\s*(error|err):\s/i` 或包含 `<error>` 标记

独立成 helper，便于调整阈值。记录为启发式、非精确。

### 决策 5：流式场景合成 message_start

现有流程客户端流的 `message_start` 来自 flash 第一轮 `peekAdvisorStream`（`swallowMessageStart=false`）。强制触发时 pro 先注入 think，flash 第一轮之前客户端流还没有 `message_start`。

方案：
- protocol 层新增 `buildMessageStartEvent(model)` 合成 `message_start`
- 强制触发时序：合成 `message_start` → advisor begin → pro 流式 think → advisor end → flash 循环
- flash 第一轮 `swallowMessageStart=true`（其 message_start 已被合成替代）
- 引入 `messageStartSent` 标志：`swallowMessageStart = messageStartSent || !isFirstFlashCall`

### 决策 6：配置 — 总开关默认关，question 写死

- `EscalateConfig.forceAdvisor: boolean`（默认 `false`）— opt-in，避免破坏现有 advisor 行为与测试
- 三个 question + tool-count 间隔（5）写死为模块常量，不进配置
- 仅 `mode === 'advisor'` 下生效

## 实施计划

- [x] **阶段 1：protocol 层** — `buildMessageStartEvent(model)`
- [x] **阶段 2：触发判断纯函数** — `detectForcedAdvisor(messages)` + helper（`isToolResultError`, `countRealToolUses`）
- [x] **阶段 3：非流式强制预咨询** — `dispatchAdvisorNonStream` 循环前加段
- [x] **阶段 4：流式强制预咨询** — `dispatchAdvisorStream` 加 message_start 合成 + 预咨询 + swallowMessageStart
- [x] **阶段 5：配置链路** — types / commands / config / metadata
- [x] **阶段 6：测试** — 触发判断单测、非流式/流式强制 e2e、现有测试回归

## 实施记录

### 2026-06-30 — 阶段 1-6 完成

**改动文件：**

| 文件 | 改动 |
|------|------|
| `src/escalate/anthropic-protocol.ts` | 新增 `buildMessageStartEvent(model)`；`AnthropicContentBlock` 加 `is_error?: boolean` |
| `src/escalate/dispatcher.ts` | 新增 `detectForcedAdvisor` / `countRealToolUses` / `isToolResultError` + 3 个预设 question 常量 + `ForcedAdvisorTrigger` 类型；`dispatchAdvisorNonStream` / `dispatchAdvisorStream` 在 flash 循环前加 forced 预咨询段；流式加 `messageStartSent` 标志 + 合成 `message_start` + 第一轮 `swallowMessageStart=messageStartSent||!isFirstFlashCall` |
| `src/escalate/types.ts` | `EscalateConfig` 加 `forceAdvisor: boolean` |
| `src/commands/escalate.ts` | 加载 `forceAdvisor`（默认 false）+ banner |
| `src/code-index/interfaces/config.ts` | `escalateForceAdvisor?: boolean` |
| `src/commands/config/metadata.ts` | `escalateForceAdvisor` metadata |
| `dispatcher.spec.ts` / `e2e.spec.ts` / `abort-propagation.spec.ts` | `makeConfig` 补 `forceAdvisor: false` |

**验证：**
- type-check：零新增错误（baseline 的 6 个 pre-existing 错误与本改动无关，已 `git stash` 验证）
- `dispatcher.spec.ts`：48 测试全过（原 34 + 新增 14）
- escalate 全套：7 文件 / 166 测试全过，零回归
- **e2e（真实上游）**：`scripts/evidence/260630-forced-advisor.ts` 三条 forced 规则全部触发并匹配预设 question。实测 flash=mimo-v2.5 / pro=glm-5.2，每个用例 think 面板出现 `--- [proxy: consulting advisor (pro): <预设question>] ---` 分隔符 + pro 分析，`message_start`/`message_stop` 各仅 1 次，block index 连续，content 为 flash 综合答案。
  - rule1-user-turn：「我的用户指令理解对吗？」✅
  - rule3-tool-error：「为什么工具报错？」✅
  - rule2-tool-count（5 个真实 tool_use）：「我的思路对吗？」✅

**新增测试（14 个）：**
- `detectForcedAdvisor` 纯函数 10 个：user-turn(2) / tool-error(2) / tool-count(3) / 优先级(1) / 不触发(2)
- forced advisor 非流式 3 个：user-turn 完整流程 / `forceAdvisor=false` 不触发 / tool-error preset question
- forced advisor 流式 1 个：`message_start` 合成 + pro think 注入 + flash retry + `message_start`/`message_stop` 各仅 1 次

## 修订记录

### 2026-06-30 — 预设 question 文案调整（适配 pro-flash 流程）

**问题：** 初版 question（「我的用户指令理解对吗？」「为什么工具报错？」「我的思路对吗？」）是 **flash 视角的自问**，隐含“flash 已有理解/思路”。但 forced 是 pro-flash 流程，pro 预咨询时 flash 还未出场，pro 无从验证一个不存在的“flash 理解”。evidence 验证显示 pro 把 question 当孤立主问题复述，而非给 flash 指导。

**修复：**
- question 改为「对 pro 的明确请求」（让 pro 基于对话上下文产出指导）：
  - user-turn：「用户指令的核心需求与歧义？」
  - tool-error：「工具报错的根因与修复建议？」
  - tool-count：「当前方向和进度评估与下一步建议？」
- forced 的 `advisorUserMsg` 前缀（独立于原生 advisor 分支）经多轮微调定为最终版：
  `[Forced advisor — You are pro model, the flash model is about to answer the user. Based on the conversation above, give flash concise actionable guidance; do NOT answer the user directly and do not call any tools. Task: <question>]`
  - 「You are pro model, the flash model」—— 身份指认，让 pro 入戏为顾问
  - `do NOT answer the user directly` —— pro 分析只注入 think 面板，不直接答用户
  - `do not call any tools` —— 双保险（`buildProAdvisorBody` 已 strip 所有 tools，协议层 pro 本就无法 tool_use；此句防止 pro 在文本里建议调用工具）
  - 原生 advisor 分支（flash 自愿调）前缀保持 `[Advisor consultation - do not call any tools...]` 不变

**验证：** e2e 重跑（flash=mimo-v2.5 / pro=glm-5.2），rule3 的 pro 回答从“复述问题”变为「ENOENT = 当前工作目录下不存在 config.json，常见触发点：拼写/相对路径/环境...快速定位...」的根因分析，flash 综合后输出有用的调试建议。三条规则全部 ✅。framework 经身份指认（You are pro model）+ 工具约束 + 问句化 question 三项调整后，pro 入戏为顾问、产出针对性指导的最终效果已确认。

### 2026-06-30 — DeepSeek thinking_content 回传修复（forced advisor flash 400）

**问题：** flash 上游从 mimo-v2.5 换成 DeepSeek（deepseek-v4-flash）后，forced advisor 模式下 pro 预咨询成功，但紧接的 flash 调用返回 400：`Error from provider (DeepSeek): The reasoning_content in the thinking mode must be passed back to the API.`。三条 forced 规则全部复现。

**根因（两层）：**

1. **forced 伪造的 assistant 消息缺 thinking block。** forced 分支用 `buildAssistantToolUseMessage` 伪造的 assistant 消息只含 `tool_use` block，**缺 `thinking` block**。DeepSeek 在 thinking 模式下强制要求 assistant 消息携带 `reasoning_content`（Anthropic 格式即 `thinking` block），否则拒绝。这层问题在 rule1（messages 无 assistant 历史）直接暴露：pro 预咨询成功后首次 flash 调用即 400。mimo-v2.5（GLM 系）不强制该约束放行；DeepSeek 严格执行。原生 advisor 分支不受影响——其 `toolUseMsg.content` 保留了 flash 自身返回的 thinking block（在 `nonAdvisorTCs` 里）。

2. **客户端 messages 历史里的 assistant tool_use 消息缺 thinking block。** rule2/rule3 的 messages 带有客户端发来的 assistant tool_use 历史（agentic 工具循环），这些消息没有 thinking block。这层与 forced 无关，是整个 proxy 对 DeepSeek 的兼容性问题：thinking 模式下 messages 里**任何** assistant 消息缺 thinking 都会被拒。

**附带 bug：** 非流式 forced 的 `proThinking` 提取写错（`extractTextFromBlocks(content.filter(thinking))`，先筛 thinking 再用 extractText 筛 text）→ 永远空串。应使用 `extractThinkingFromBlocks`。

**修复：**
1. **forced 分支补 thinking block（治第 1 层）。** 非流式 + 流式构造 `toolUseMsg` 时，在 `tool_use` block 前插入一个 `thinking` block，内容用 pro 的 thinking（为空时退化为 pro 的全文）。
2. **`callUpstream` 统一规范化历史（治第 2 层）。** 新增 `ensureAssistantThinkingBlocks`（anthropic-protocol.ts）：遍历 messages，给任何缺 thinking block 的 assistant 消息在头部补一个空 thinking block（content 为数组的直接补；content 为字符串的先转为 `[{type:'text'}]` 再补；已有 thinking 的不动）。在 `callUpstream`（所有上游请求唯一出口）发送前调用，覆盖 flash/pro × self-report/advisor 全部路径。glm 等不强制 reasoning_content 的模型收到空 thinking block 无副作用。
3. **`streamProAsReasoning` 返回 `{ text; thinking }`**（原 `Promise<string>`），让流式路径能拿到 pro 的 thinking 用于构造 forced 的 thinking block；两个调用点（forced + 原生 advisor）适配，tool_result.content 拼接逻辑不变。
4. 非流式 forced 改用 `extractThinkingFromBlocks`。

**改动文件：** `src/escalate/anthropic-protocol.ts`（新增 `ensureAssistantThinkingBlocks`）；`src/escalate/dispatcher.ts`（import + `callUpstream` 规范化；非流式/流式 forced toolUseMsg 加 thinking block；`streamProAsReasoning` 返回对象；原生 advisor 流式调用点适配；import `extractThinkingFromBlocks`）。

**验证：** type-check 零新增错误；escalate 全套 7 文件 / 166 测试通过。e2e 重跑（flash=deepseek-v4-flash / pro=glm-5.2）三条 forced 规则全部跑通，content 不再为 proxy error：rule1「巴黎」、rule3「config.json 文件不存在（ENOENT）...处理方式...」（flash 综合 pro 根因分析）、rule2「已依次读取了 5 个文件...」。

### 2026-07-01 — 修订: forced thinking block 改空（路径 B）+ question 文案对齐 + 常量抽离

**问题（路径 B — forced 身份污染）：** forced 伪造的 assistant tool_use 消息为满足 DeepSeek "reasoning_content must be passed back" 约束，把 **pro 的完整 reasoning_content** 塞进 thinking block（`forcedThinking = proThinking || proFullContent`）。但 pro 分析已在 tool_result 里，thinking block 里重复放置纯属冗余，更严重的是把 pro 的第三人称视角（"You are pro model… give flash guidance"）灌进 flash 的"自我推理"槽位 → flash 读到"自己"的推理在谈论"指导 flash"，角色错乱。此污染不进客户端历史、不累积，但每轮 forced 都发生、当轮直击身份。

**修复：**
1. **forced thinking 改空占位：** 非流式 + 流式 `forcedThinking = ''`。DeepSeek 只要求 thinking block **存在**（`ensureAssistantThinkingBlocks` 早证明空内容可行），pro 分析**只走 tool_result** 一条路。既去冗余，又从源头消除身份视角污染。**（取代本条上方 06-30 修复里"forced thinking block 内容用 pro 的 thinking"的做法。）**
2. **question 文案对齐：** 三个预设 question 调整为当前代码值：user-turn「用户指令的核心需求？是否有歧义？」、tool-error「工具报错的原因？修复建议？」、tool-count「当前方向是否正确？下一步建议？」。（注：上方 06-30 的 question 文案修订记录是当时历史值，已被本次取代。）
3. **forced prompt 前缀常量化：** `FORCED_ADVISOR_PROMPT_PREFIX` + `buildForcedAdvisorPrompt`（详见 260624 同日修订）。evidence 脚本 `scripts/evidence/260630-forced-advisor.ts` 同步更新（期望文案、`questionRe` 正则改匹配 XML 标签 `<proxy-advisor-consult question="…">`、`proLeak` 检测改 `proxy-advisor-consult`）。

**改动文件：** `src/escalate/dispatcher.ts`（两处 `forcedThinking = ''` + prompt 前缀常量化）；`src/escalate/__tests__/dispatcher.spec.ts`（7 处测试期望文案对齐）；`scripts/evidence/260630-forced-advisor.ts`（5 处同步）。

**验证：** type-check escalate 零错误；escalate 全套 7 文件 / 173 测试全过；evidence 脚本正则单测确认能从 `<proxy-advisor-consult question="…">` 提取 question 并匹配预设值。

### 2026-07-02 — 修订: advisor tool description 加一句“复述”指导，让 pro 分析跨轮次延续

**问题（pro 指导只活一轮）：** forced（及原生）advisor 的 pro 分析只影响触发后紧接的**单个** flash retry，后续 agentic 工具循环轮次里 pro 的方向指导完全丢失。两层原因：
1. proxy 伪造的 `[tool_use, tool_result]` 对只活在当次请求的 `workingMessages` 里，**不进客户端历史**——客户端只拿到 flash 综合后的最终输出，下一轮请求时这对消息不存在。
2. 即使 pro 分析被 `<proxy-advisor-consult>` 包着注入了客户端 think 面板，下一轮请求也会被 `stripAdvisorMarkersFromThinking` 在 `callUpstream` 出口整段删掉。

结果：pro 的方向评估只被 flash 看到一次，后续轮次指导丢失，pro 调用的 ROI 低。

**方案演进：**
- **方案 A（试后放弃）：** 在每个 advisor `tool_result.content` 末尾追加 `ADVISOR_SUMMARIZE_HINT`，引导 flash 在 reasoning 里复述。实测效果不佳（hint 作为 tool_result 尾巴较突兀、且依赖 flash 认真读 result 末尾），废弃。
- **方案 B（最终采用）：** 在 `advisorToolDefinition.description` 末尾加一句**泛化契约**：
  > `After receiving an advisor result, briefly restate its key points in your own thinking before continuing.`

**为什么 description 方案更好：**
- description 是 flash **每轮请求都读**的工具使用契约，约束力比 result 尾巴强；
- 泛化措辞不依赖“上方有 advisor 建议”这个前提（方案 A 的 hint 说 "restate the advisor's guidance above"，未调 advisor 时指代空泛）；
- 不污染 `tool_result.content`（pro 原文保持干净）；
- 与已有的 `Synthesize pro's analysis into your answer` 句语义连贯，同属“调用后怎么处理”的指导。

flash 据此产生的复述写进它自己的 reasoning_content → 进客户端历史 → 后续每轮 replay，使 pro 指导贯穿整个工具循环；复述是 flash 自我表述，无第三人称污染，不需要 strip。

**改动文件：** `src/escalate/contract.ts`（`advisorToolDefinition.description` 末尾加一句，拆成两行拼接）。

**验证：** type-check escalate 零错误；escalate 全套 7 文件 / 173 测试通过，零回归。

### 2026-07-03 — 修订: pro 端注入 dummy `finish` tool + 流式 tool_use 透穿修复

**问题：** `buildProAdvisorBody` strip 了所有 tools，agentic 模型在**无任何工具**时反复输出"让我搜索代码""我将探索代码库"等死循环废话，不产出有效建议。流式路径下 pro 的 tool_use block 还被 `streamProAsReasoning` 的 fallback 转发到客户端 SSE（透穿）。

**修复：**
- 给 pro 注入 dummy `finish` tool（`done: boolean` required）：description 明确"你是 ADVISOR，没有其他工具，写完文本建议后调用 finish(done=true)"。满足模型必须发 tool_call 的冲动，扼制空转。
- `streamProAsReasoning` 新增 `toolUseIndices`，检测 content_block_start type=tool_use 后进入 swallowing，该 index 的后续 delta/stop 吞掉不透穿。
- 非流式路径本就走 `extractTextFromBlocks` 跳过 tool_use，不受影响。

**改动文件：**
- `src/escalate/contract.ts` — 新增 `proFinishToolDefinition`（`done: boolean` required）。
- `src/escalate/dispatcher.ts` — `buildProAdvisorBody` 注入 finish tool；`streamProAsReasoning` 过滤 tool_use block。
- `src/escalate/__tests__/dispatcher.spec.ts` — 3 处断言更新；新增 2 个测试（非流式忽略 + 流式不透穿）。

**验证：** type-check escalate 零错误；escalate 全套 7 文件 / 175 测试通过（新增 2），零回归。



## 总结

**核心成果：**
1. **确定性触发** — pro 必被咨询，question 100% 确定（预设常量），彻底摆脱 flash 自愿性。
2. **方案 B（proxy 伪造 advisor tool_call）** — 复用现有 advisor 全套基础设施（pro 调用 / tool_result 构造 / 流式 think 注入），flash 仍可自由调客户端工具，不打断 agentic 流程。
3. **stateless 去重** — 基于 messages 末尾状态判断（纯 user → 规则 1；含 tool_result → 规则 3/2），无需内存计数器或 messages 内嵌 sentinel。
4. **流式 message_start 合成** — forced 触发下客户端流缺失 `message_start` 的问题，通过 `buildMessageStartEvent` 合成 + 第一轮 flash `swallowMessageStart=true` 解决。

**使用方式：** 配置 `escalateForceAdvisor: true`（仅 `mode: 'advisor'` 生效，默认 false）。三条触发规则用写死的中文预设 question，间隔固定为 5。

**后续可调点：** `isToolResultError` 的 content 启发式阈值；`FORCE_ADVISOR_TOOL_COUNT_INTERVAL`。
