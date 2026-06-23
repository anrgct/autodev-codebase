# 260602-escalate-proxy

## 主题/需求

新增 `codebase escalate` 子命令，启动一个本地 HTTP 反向代理，自动将 LLM API 请求按任务难度在 flash 和 pro 模型之间切换。

**核心流程：**

```
第三方客户端 ──→ Proxy Server ──→ DeepSeek API
                     │
                     ├─ 注入 ESCALATION_CONTRACT 到 system prompt
                     ├─ 检测 <<<NEEDS_PRO>>> 标记
                     └─ 自动重试（切换 flash → pro）
```

**背景：** DeepSeek-Reasonix 的 `autoEscalate` 机制仅在 Reasonix loop 内部生效。第三方客户端（Continue、Aider、Zed 等）无法享受自动升级能力。通过一个独立 proxy，任何 OpenAI 兼容客户端都能获得此能力。

## 代码背景

### 参考来源

> **Reasonix 源码目录**：`/Users/anrgct/workspace/DeepSeek-Reasonix/`
> **分析文档**：`/Users/anrgct/workspace/DeepSeek-Reasonix/260528-autoEscalate-and-proxy-analysis.md`

| 组件 | 文件 | 说明 |
|------|------|------|
| `autoEscalate` 机制 | Reasonix loop runtime (Rust/TS) | 运行时布尔配置，控制 flash ↔ pro 自动切换 |
| 升级触发条件 | 分析文档 §1 | 两种路径：self-report (`<<<NEEDS_PRO>>>`) + failure-threshold (3+ 次失败) |
| `escalationContract()` | `src/prompt-fragments.ts:12` | 动态生成契约文本，根据 modelId 返回 flash 版或 pro 版 |
| `EscalatedEvent` | `src/core/events.ts:175-182` | 事件模型，reason: `self-report` / `failure-threshold` / `user-request` |
| 注入位置 | `src/cli/index.ts:86`, `src/code/prompt.ts:9-11`, `src/tools/subagent.ts:111-113` | Chat / Code / Subagent 三个入口注入 CONTRACT |

### 现有基础设施

| 能力 | 位置 | 复用方式 |
|------|------|----------|
| Commander.js 子命令 | `src/cli.ts` | 直接复用 `program.addCommand()` 模式 |
| undici `ProxyAgent` / `fetch` | embedders 各处 | 使用 undici `Pool` 保持到上游 API 的连接复用 |
| 配置管理三层体系 | `src/code-index/interfaces/config.ts` 等 | 扩展 `CodeIndexConfig` 接口 |
| 配置 CLI (`config --get/set`) | `src/commands/config/` | 扩展 metadata、validator、constants |

## 运行现象

N/A（新功能开发，无 bug 现场）

## 归因分析

### 为什么 proxy 只需处理 self-report，不管 failure-threshold

Reasonix 的隐式升级（3+ 次 ToolCallRepair 失败）是 **loop 内部**状态——proxy 层面看不到这些信息。除非客户端主动通过 header（如 `X-Failure-Count: 3`）上报，否则 proxy 无从感知。

**结论**：proxy 只处理 `<<<NEEDS_PRO>>>` 显式标记，failure-threshold 留给客户端自行实现。

### 为什么去掉 preset / enable 开关

- `escalatePreset`：目前需求只有 `auto` 一种模式，不需要 `flash`/`pro` 锁定
- `escalateEnabled`：无开关场景，proxy 启动即生效

### 流式响应的核心矛盾

| 方案 | 延迟 | 问题 |
|------|------|------|
| 全缓冲后判定 | flash_T × 2 | 流式体验全丢 |
| 预检（非流式探测 20 token） | +1 次往返 + token 开销 | 探测结果 ≠ 完整响应 |
| **偷看缓冲（首行判定）** | +~50ms | ✅ 最优 |

## 关键决策

### 决策 1：性能方案 — 偷看缓冲 + 零拷贝透传

```
Client ──→ Proxy ──flash(stream)──→ API
                  │                    │
                  │               [缓冲首行 ~50 chars]
                  │                    │
                  │           ┌─ 无 NEEDS_PRO → flush + pipeTo → Client
                  │           └─ 有 NEEDS_PRO → abort flash → pro(stream) → Client
```

- **判定前**：循环 `reader.read()` 累积到第一个 `\n` 或 50 chars
- **判定后**：`ReadableStream.pipeTo(WritableStream)` 零拷贝透传
- **只付升级代价**：无升级时延迟增加可忽略（~50ms 缓冲），升级时多一次 flash 往返

### 决策 2：HTTP 框架 — h3 (unjs/h3) 替代 Express

| | Express | **h3** | 原生 `http.Server` |
|---|---|---|---|
| 流式响应 | `res.write()` 手动管 | `sendStream()` 原生支持 `ReadableStream` | 完全手动 |
| 读请求体 | `express.json()` 全缓冲 | `readRawBody()` 或直接拿 stream | 手动读 chunk |
| 依赖 | ~30 个包，~2MB | ~5 个包，~200KB | 0 |
| 项目已有 | MCP server | ❌ 需新增 | `createServer` 各处 |

**选 h3 的核心理由**：proxy 的核心是流式透传，h3 的 `sendStream(event, readableStream)` 直接零拷贝透传，代码量比 Express 少一半。Express 留给 MCP server（JSON-RPC，无流式需求），escalate 是独立服务不需要共享 app 实例。

```typescript
// h3 流式透传示例
return sendStream(event, upstream.body!);  // 一行零拷贝
```

### 决策 3：连接管理 — undici Pool 复用

```typescript
const pool = new Pool(apiBase, {
  connections: 4,
  pipelining: 1,
  keepAliveTimeout: 30_000,
});
```

- 避免每次请求重新 TLS 握手
- 4 个并发连接足够覆盖 flash + pro 同时活跃的场景

### 决策 4：API Key 透传

- 配置项 `escalateApiKey` 可选
- 不设时从客户端 `Authorization: Bearer sk-xxx` header 透传到上游
- 设了则使用配置的 key（适合不想暴露 key 给客户端的场景）

### 决策 5：配置设计 — 6 个配置项

| Key | 类型 | 默认值 | 说明 |
|-----|------|--------|------|
| `escalateApiBase` | `string` | `"https://api.deepseek.com/v1"` | API base URL |
| `escalateApiKey` | `string` | — | API Key（可选，不设则透传客户端） |
| `escalateFlashModel` | `string` | `"deepseek-v4-flash"` | Flash 模型 ID |
| `escalateProModel` | `string` | `"deepseek-v4-pro"` | Pro 模型 ID |
| `escalatePort` | `integer` 1–65535 | `8080` | 代理监听端口 |
| `escalateHost` | `string` | `"localhost"` | 代理监听地址 |

配置层优先级：CLI 参数 > 项目配置 > 全局配置 > 默认值。

### 决策 6：模块拆分

```
src/commands/escalate.ts          # 子命令入口 + CLI 选项
src/escalate/server.ts            # h3 HTTP 代理服务器
src/escalate/contract.ts          # ESCALATION_CONTRACT 生成 + 注入
src/escalate/detector.ts          # <<<NEEDS_PRO>>> 检测
src/escalate/dispatcher.ts        # 请求转发 + 重试 + 流式透传
src/escalate/types.ts             # 类型定义
```

### 决策 7：Sticky Pro — 消息前缀匹配的对话级状态保留

默认启用，基于消息内容前缀匹配，类似 LLM prefix caching 的思路。

#### 动机

一旦对话升级到 pro，后续轮次应该跳过 flash 往返直接发 pro。但对话之间必须隔离——A 对话升级了，B 对话不应该受影响。

#### 核心思路

```
Round 1:  messages = [sys, user_q1]
               -> upgrade to pro
               -> fingerprint(messages[:-1]) -> store prefix key

Round 2:  messages = [sys, user_q1, asst_a1, user_q2]
               -> match from longest prefix to shortest
               -> prefix [sys, user_q1] -> HIT! -> skip flash, direct pro
```

- **存储时机**：flash 检测到 `<<<NEEDS_PRO>>>` -> 成功切换到 pro 后，把当前 messages（去掉最后一条）指纹化存储
- **匹配策略**：从 `messages.length - 1` 到 1 逐一匹配前缀，最长匹配优先
- **清除时机**：pro 模型输出 `<<<NEEDS_FLASH>>>` 降级时 -> 清除该对话的所有 prefix 条目
- **过期**：TTL 默认 5 分钟，无活跃自动降级回 flash，避免"永久 pro"浪费

#### 指纹计算

只取 `role` + `content` 前 200 字符做 SHA256，忽略 `tool_calls`/`function` 等辅助字段，保证相同语义不同调用方式的请求仍然命中。

```typescript
function fingerprintMessages(msgs: ChatCompletionMessage[]): string {
  const simplified = msgs.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content.slice(0, 200) : '',
  }))
  const json = JSON.stringify(simplified)
  return createHash('sha256').update(json).digest('hex').slice(0, 16)
}
```

#### 配置

| Key | 类型 | 默认值 | 说明 |
|-----|------|--------|------|
| `escalateStickyProTtlMs` | `integer` >= 0 | `300000` (5min) | TTL 毫秒。设为 0 关闭 sticky pro |

不设单独开关——`stickyProTtlMs > 0` = 开启，`= 0` = 关闭。

#### 状态管理对比

| 方案 | 粒度 | 客户端配合 | 自动降级 | 碰撞风险 |
|------|------|-----------|---------|---------|
| 按 API Key hash | 粗 | 否 | 是 | 同人多对话串话 |
| 按 `X-Conversation-Id` header | 细 | 要 | 是 | 无 |
| **按消息前缀指纹** | 细 | **否** | 是 | 极小（相同前缀不同对话） |

选消息前缀指纹的理由：完全自动，零客户端配合，且 prefix caching 的逻辑用户已经熟悉。

#### 代码结构

```
src/escalate/sticky.ts    <- 新增
  +-- StickyStore         类
  |   +-- lookup()        查（最长前缀 -> 最短）
  |   +-- storeUpgrade()  存
  |   +-- clear()         清
  |   +-- startCleanup()  定时清理
  |   +-- stopCleanup()
  +-- fingerprintMessages()  指纹函数（纯）
```

Dispatcher 中的集成点：
- `dispatch()` — 接到请求时先查 sticky
- `dispatchDirectPro()` / `dispatchDirectProStream()` — 直接发 pro 的新路径
- `dispatchNonStream()` — 升级后 store，降级后 clear
- `dispatchStream()` — 升级后 store（checkProStreamForDowngrade 内降级时 clear）
- `checkProStreamForDowngrade()` — 新增 `isDirect` 参数，降级时 clear

#### 和 prefix caching 的对应关系

| LLM Prefix Caching | Sticky Pro |
|---|---|
| KV cache key = input tokens prefix | sticky key = messages prefix |
| 共享 prefix 的请求复用 KV | 共享 prefix 的请求复用 pro |
| prefix 越长越精确 | 同样 |


## 实施计划

- [ ] **阶段 1：配置层**
  - 新增 `EscalateConfig` 接口
  - 扩展 `CodeIndexConfig`（6 个 `escalate*` key）
  - 更新 `DEFAULT_CONFIG`
  - 更新 `CONFIG_KEY_METADATA`
  - 更新 `ConfigValidator`

- [ ] **阶段 2：核心模块**
  - `src/escalate/types.ts` — 类型定义
  - `src/escalate/contract.ts` — ESCALATION_CONTRACT 生成 + prompt 注入
  - `src/escalate/detector.ts` — `<<<NEEDS_PRO>>>` 首行检测
  - `src/escalate/dispatcher.ts` — 非流式 + 流式请求转发、重试、偷看缓冲透传

- [ ] **阶段 3：HTTP 服务器**
  - `src/escalate/server.ts` — h3 代理服务器（`createServer` + `eventHandler`）
    - `POST /v1/chat/completions` — 非流式 + 流式（`sendStream` 透传）
    - `GET /health` — 健康检查
    - 其他端点（`/v1/models` 等）直通

- [ ] **阶段 4：CLI 子命令**
  - `src/commands/escalate.ts` — `codebase escalate` 子命令
  - 在 `src/cli.ts` 注册

- [ ] **阶段 5：测试**
  - `contract.ts` 单元测试
  - `detector.ts` 单元测试
  - `dispatcher.ts` 单元测试（mock fetch）
  - e2e：启动 proxy → curl 发请求 → 验证升级行为

## 实施记录

### 2026-06-02

- 实施所有 5 个阶段（配置层 → 核心模块 → HTTP 服务器 → CLI → 测试）
- 依赖：新增 `h3@^1.13.0`（流式透传原生支持）
- 新增文件：
  - `src/escalate/types.ts` — `EscalateConfig` / `DispatchResult` / `EscalationReason`
  - `src/escalate/contract.ts` — `escalationContract()` 动态生成 + `injectContract()` 注入系统提示
  - `src/escalate/detector.ts` — `detectNeedsPro()` 首行检测 + `stripNeedsProMarker()`
  - `src/escalate/dispatcher.ts` — `EscalateDispatcher` 业务核心（流式 peek-and-passthrough + 偷看缓冲）
  - `src/escalate/server.ts` — `startEscalateServer()` / `buildEscalateApp()` h3 代理服务器
  - `src/commands/escalate.ts` — `codebase escalate` CLI 子命令
  - `src/escalate/__tests__/contract.spec.ts` — 10 测试
  - `src/escalate/__tests__/detector.spec.ts` — 17 测试
  - `src/escalate/__tests__/dispatcher.spec.ts` — 12 测试（mock fetch）
  - `src/escalate/__tests__/e2e.spec.ts` — 4 测试（真 h3 + mock upstream）
  - `scripts/evidence/260602-escalate-e2e-deepseek.ts` — 真实 DeepSeek API 端到端测试
- 修改文件：
  - `src/code-index/interfaces/config.ts` — 扩展 `CodeIndexConfig` 加 6 个 `escalate*` key
  - `src/code-index/constants/index.ts` — `DEFAULT_CONFIG` 加默认值
  - `src/commands/config/metadata.ts` — `CONFIG_KEY_METADATA` 加元数据
  - `src/code-index/config-validator.ts` — `escalatePort` 端口范围验证
  - `src/cli.ts` — 注册 `escalate` 子命令
  - `package.json` / `package-lock.json` — `h3` 依赖
- 测试结果：119/119 测试文件通过，1100/1100 测试通过
- 实际 DeepSeek API 端到端测试：
  - Case A (trivial task): 200 OK，1.2s，flash 响应，未升级 ✅
  - Case B (tricky task): 200 OK，10s，pro 响应，X-Escalated-To: pro，X-Escalation-Reason 携带原因 ✅
- 构建：rollup 构建通过 (4.7MB dist/cli.js)

### 关键修复 / 设计决策

1. **头大小写冲突**：初版 `buildUpstreamHeaders` 同时输出 `content-type` 和 `Content-Type` 两个 key，致 DeepSeek API 返回 415。后统一为小写，问题解决。
2. **h3 catch-all 参数名**：radix3 的 `**` 通配符的参数名是 `_`（下划线），不是 `**`。调整为 `getRouterParam(event, '_')`。
3. **undici Pool 接受 origin**：原 `new Pool(apiBase)` 报错 `invalid url`，需去除路径部分。增加了 `buildEscalatePool` 内部的路径剥离逻辑。
4. **SSE 内容提取**：检测器需从 SSE `data:` 包的 `choices[0].delta.content` 字段提取累积内容，而不是原始字节流。使用 `extractChatContent` / `extractSseDelta` 两个辅助函数。
5. **单 reader 读取**：流式偷看缓冲与后续透传只能使用同一个 reader，初版双 reader 报错 `ReadableStream is locked`。
6. **PEEK_MAX_CHARS 提升到 256**：考虑到 SSE 包头 `data: {...}\n\n` 本身有 ~50 字节可用空间，50 字符探测会遗漏从 token 靠后位置开始输出的 marker。提升到 256 字符以覆盖完整首个 SSE 数据包。

## 修订记录

- **v5 (2026-06-23)**: 修复 `peekTierStream` SSE 行丢失 bug —— 当多个 SSE 事件打包在同一 TCP chunk 中且首个 content 触发 `no-marker` 时，同一 chunk 中后续行被 `break` 跳过导致数据丢失。新增 `flushRemainingLines()` 在切换到 passthrough 前 flush 剩余行。

- **v1 (2026-06-02)**: 首次实现并测试通过。
- **v2 (2026-06-02)**: 新增 `<<<NEEDS_FLASH>>>` 降级支持，pro 模型可自由决定降级到 flash。
- **v3 (2026-06-02)**: 新增 Sticky Pro —— 消息前缀指纹匹配的对话级状态保留。
- **v4 (2026-06-18)**: 流式路径重构 —— reasoning_content 实时透传 + 前缀增量检测 + tier 切换分隔标记。彻底解决推理模型长 think block 导致客户端 TTFB 飙升的问题。

### v4 变更详情 (2026-06-18)

#### 动机

v3 的流式 peek 实现把**所有上游字节**（含 `reasoning_content` / think block）都缓冲到 `peekBytes`，直到累积满 256 chars 的 `delta.content` 才调用 `detectEscalationMarker()` 判定。对于推理模型（DeepSeek-R1、o1 等），模型会先输出几十秒的 `reasoning_content` 再输出第一个 `content` token，期间代理持续缓冲但客户端收不到任何字节，TTFB = think_duration + content_buffering_duration，5–30s+ 的无响应等待体验接近超时。

#### 核心设计

**reasoning_content 实时透传 + content 前缀增量检测**：

```
flash stream → peek 循环:
  delta.reasoning_content → 立即 controller.enqueue() (客户端实时看到 think)
  delta.content → 累积到 sseContentBuf + detectMarkerPrefix()
    ├─ no-marker (第一个 content char 不是 `<`) → flush content, 切纯透传
    ├─ matched-pro → cancel flash, 发分隔标记, 调 pro
    └─ need-more → 继续累积
```

- **`detectMarkerPrefix(text)`**：新增的前缀增量检测器。返回 `no-marker` / `matched-pro` / `matched-flash` / `need-more`。对非 `<` 开头的 content 在**第一个 chunk** 就判定 `no-marker`，立即结束 peek（>99% 的请求几乎零延迟）。
- **`buildTierSwitchEvent(from, to, reason)`**：升级/降级时构造一个合成 SSE 事件，把分隔标记注入到 `delta.reasoning_content`。客户端在 think 区域看到 `--- [proxy: switched flash → pro (reason)] ---`，清晰知道发生了 tier 切换。
- **`SseLineBuffer`**：新增的增量 SSE 行解析器，跨 chunk 正确处理行边界，保留字节保真度，支持 leftover flush。
- **`peekTierStream(controller, reader, expectedDirection)`**：抽出的通用 peek 方法，flash 和 pro 复用。返回 `{outcome:'done'}` 或 `{outcome:'switched', reason?}`。

#### 设计权衡：流式路径移除 `X-Escalated-*` 头

HTTP 响应头必须在 body 之前发送。但 reasoning 实时透传要求 dispatch 立即返回 stream（不等 peek 完成才能开始发 body）。两者矛盾，取舍如下：

| 路径 | `X-Escalated-*` 头 | 升级信号 |
|------|-------------------|---------|
| 非流式 | ✅ 保留 | 头 + body |
| 流式 | ❌ 移除 | body 中的分隔标记（`reasoning_content`）|

客户端通过 body 中注入到 `reasoning_content` 的 `--- [proxy: switched ...] ---` 感知 tier 切换，不再依赖响应头。

#### 修改文件

- `src/escalate/sse-buffer.ts` — 🆕 新增，`SseLineBuffer` 增量 SSE 行解析器
- `src/escalate/detector.ts` — 新增 `detectMarkerPrefix()` + `MarkerPrefixDecision` 类型 + `isPossibleMarkerPrefix()` 内部辅助
- `src/escalate/dispatcher.ts` — 重写流式路径：
  - 新增 `peekTierStream()`（通用 peek，flash/pro 复用）
  - 新增 `buildTierSwitchEvent()` / `buildProxyErrorEvent()` / `concatBytes()` / `pumpReaderToController()`
  - `dispatchStream()` 重构为「立即返回 stream + 边读边发」模式
  - `dispatchDirectProStream()` 同步重构（sticky pro 路径）
  - 删除旧的 `checkProStreamForDowngrade()`、`extractSseDelta()`、`PEEK_MAX_CHARS`
- `src/escalate/__tests__/sse-buffer.spec.ts` — 🆕 12 测试
- `src/escalate/__tests__/detector.spec.ts` — 新增 `detectMarkerPrefix` 38 测试
- `src/escalate/__tests__/dispatcher.spec.ts` — 重写流式测试（6 测试），验证 reasoning 透传、分隔标记、无 X-Escalated 头

#### 测试结果

- 类型检查通过（`tsc --noEmit`）
- 123/123 escalate 测试通过（含 12 新增 sse-buffer + 38 新增 detector prefix + 6 重写流式）

#### 性能影响

| 场景 | v3 TTFB | v4 TTFB |
|------|---------|---------|
| 简单任务（无 think，直接 content） | ~50ms (缓冲首 chunk) | ~0ms (第一个 content char 非 `<` 立即透传) |
| 复杂任务（长 think 后升级） | think_duration + 256 chars 缓冲 | 0ms (think 实时透传) + 第一个 content chunk 判定 |
| 复杂任务（长 think 后不升级） | think_duration + 256 chars 缓冲 | 0ms (think 实时透传) + 第一个 content chunk 判定 |


#### 新增功能

- **Sticky Pro**：一旦对话升级到 pro，后续请求只要消息前缀匹配就跳过 flash 直接发 pro。
- **消息前缀指纹**：基于 `role` + `content` 前 200 字符做 SHA256，类似 LLM prefix caching。
- **StickyStore** 类：纯内存 `Map` 存储，TTL 自动过期（默认 5 分钟），定期清理。
- **`dispatchDirectPro()` / `dispatchDirectProStream()`** — 直接从 pro 开始的新 dispatch 路径。
- **配置项 `escalateStickyProTtlMs`**：控制 TTL，设为 0 关闭。

#### 设计要点

- **无单独开关**：`stickyProTtlMs > 0` = 开启，`= 0` = 关闭。默认 300000ms。
- **最长前缀匹配**：从 `messages.length - 1` 到 1 逐一匹配，命中最长前缀。
- **降级清除**：pro 输出 `<<<NEEDS_FLASH>>>` 时清除全部 sticky 条目，下次请求从 flash 开始。
- **零客户端配合**：不需要客户端发任何 header，纯靠消息内容区分对话。
- **线程安全**：单线程 event loop，不需要锁。

#### 修改文件

- `src/escalate/sticky.ts` — 🆕 新增，StickyStore + fingerprintMessages
- `src/escalate/types.ts` — 扩展 `EscalateConfig` 加 `stickyProTtlMs`
- `src/escalate/dispatcher.ts` — 集成 sticky 到 dispatch 全流程
- `src/code-index/interfaces/config.ts` — `CodeIndexConfig` 加 `escalateStickyProTtlMs`
- `src/code-index/constants/index.ts` — 默认值 300000
- `src/commands/config/metadata.ts` — 元数据描述
- `src/code-index/config-validator.ts` — TTL 校验
- `src/commands/escalate.ts` — CLI 加载 TTL + banner 显示
- `src/escalate/__tests__/sticky.spec.ts` — 🆕 新增，14 个测试
- `src/escalate/__tests__/dispatcher.spec.ts` — 添加 `stickyProTtlMs: 0`
- `src/escalate/__tests__/e2e.spec.ts` — 添加 `stickyProTtlMs: 0`

#### 测试结果

- 120/120 测试文件通过，1133/1133 测试通过（原 1119 + 14 新增）

### v2 变更详情 (2026-06-02)

#### 新增功能

- **Pro 模型降级路径**：在 pro 模型的 system 提示中注入 `Cost-aware downgrade note`，告诉 pro 模型在认为任务足够简单时输出 `<<<NEEDS_FLASH>>>` 降级到 flash。
- **`detectNeedsFlash()`** 检测器：与 `detectNeedsPro()` 对称，支持裸标记和带原因格式。
- **`detectEscalationMarker()`** 统一检测器：返回 `{ matched, direction: 'pro' | 'flash', reason }`，原 `detectNeedsPro` 现为薄包装。
- **Dispatcher 降级流程**：
  - 非流式：flash → pro (escalate) → flash (downgrade) → 返回 flash 响应
  - 流式：flash stream peek → cancel + pro stream → pro stream peek → cancel + flash stream
- **Path tracking**：`DispatchResult.path: Array<'flash' | 'pro'>` 记录请求跨 tier 的路径（如 `['flash', 'pro', 'flash']`）。
- **新增响应头 `X-Escalation-Path`**：包含路径信息（如 `flash->pro` 或 `flash->pro->flash`）。

#### 修改文件

- `src/escalate/detector.ts` — 统一检测逻辑，新增 `NEEDS_FLASH_MARKER` 常量与 `detectNeedsFlash` 函数。
- `src/escalate/contract.ts` — pro 模型的 contract 文本改为降级说明。`CONTRACT_SENTINEL` 用于幂等检测。
- `src/escalate/dispatcher.ts` — `buildProBody` 注入 pro-side contract；新增降级流程逻辑；`annotationHeaders` 辅助函数；`checkProStreamForDowngrade` 处理流式降级。
- `src/escalate/types.ts` — `EscalationReason` 新增 `'downgrade'`；`DispatchResult` 新增 `path` 字段。
- `src/escalate/__tests__/detector.spec.ts` — 新增 15 个 `detectNeedsFlash` / `detectEscalationMarker` / `stripNeedsProMarker` 测试。
- `src/escalate/__tests__/dispatcher.spec.ts` — 新增 4 个降级测试（流式 + 非流式 + 路径跟踪）。
- `src/escalate/__tests__/contract.spec.ts` — 更新 pro contract 测试期望。
- `src/escalate/__tests__/e2e.spec.ts` — 更新 e2e 测试期望 pro body 包含 pro-side contract。
- `scripts/evidence/260602-escalate-e2e-deepseek.ts` — 新增 Case C 强制升级 + 降级尝试。

#### 测试结果

- 119/119 测试文件通过，**1119/1119** 测试通过（原 1100 + 19 新增）
- 实际 DeepSeek API 端到端测试：
  - Case A (trivial task): 200 OK，~1s，flash 响应，path=`flash` ✅
  - Case B (tricky task): 200 OK，~30s，pro 响应，path=`flash->pro`，X-Escalation-Reason 携带原因 ✅
  - Case C (forced escalate + downgrade 尝试): flash 模型足够智能识别任务简单，未升级；pro-side contract 已被注入 (通过 e2e 单元测试验证) ✅

#### 关键修复 (v2)

1. **SSE 流锁定 bug**：`checkProStreamForDowngrade` 中 `proResp.body.getReader()` 后再返回 `proResp.body` 会报 `ReadableStream is locked`。修复：构造新的 `ReadableStream` 重新发出 peek 过的原始字节，然后 pump 剩余数据。
2. **Contract 函数签名语义错位**：原 `escalationContract(targetModelId, otherModelId)` 在调用 `escalationContract(PRO, FLASH)` 时会把 PRO 误认为 flash 模型（因为 `PRO !== FLASH`），返回错的 contract。修复：将第二个参数改为 `proModelId`，调用者明确传 `proModel`。
3. **Idempotency 传递问题**：第一次 flash 调用后 system 消息包含 `CONTRACT_SENTINEL`，pro 调用的 idempotency 跳过注入。修复：pro 调用从原始 `rawBody` 重新构建（不是从 flash 修改后的 body），因此 idempotency 是新检查。

## 总结

### 核心设计要点

1. **偷看缓冲** — 只缓冲 256 chars 判定，零拷贝透传，无升级时几乎无性能损失
2. **连接池** — undici `Pool` 复用 TLS 连接，避免重复握手
3. **消息前缀匹配** — sticky pro 基于 `messages` 内容前缀指纹匹配对话，零客户端配合
4. **纯文本注入** — CONTRACT 注入只修改 system prompt 文本，不改变 API 协议语义
5. **头透传机制** — `X-Escalated-To: pro` 头告知客户端发生了升级，客户端可据此展示通知
6. **双向 tier 切换** — flash → pro (升级) 与 pro → flash (降级) 对称，pro 模型可自由决定降级以节省成本
7. **路径跟踪** — `X-Escalation-Path: flash->pro->flash` 记录请求跨 tier 的完整路径，便于调试与遥测
8. **TTL 自动降级** — sticky pro 条目 5 分钟无活动自动过期，避免永久 pro 浪费

### 局限性

- failure-threshold 隐式升级不在此 proxy 范围内（需客户端配合上报）
- 仅支持 OpenAI 兼容协议（`/v1/chat/completions`）
- 升级重试只做 1 次（flash → pro），不做多次级联
- 消息前缀指纹是 best-effort，两个对话恰好有相同 system + 第一条 user 消息时可能误匹配（概率极低）
- **流式路径无 `X-Escalated-*` 响应头**（v4 起）：为了让 `reasoning_content` 实时透传（避免长 think block 期间客户端无响应等待），流式响应的升级判定发生在响应头发送之后。客户端通过 body 中注入到 `reasoning_content` 的分隔标记（`--- [proxy: switched flash → pro] ---`）感知 tier 切换。非流式路径仍保留完整的 `X-Escalated-To / From / Path / Reason` 头。

### 后续优化方向

- 支持 `X-Failure-Count` header 接收客户端上报的失败计数
- 支持多 provider（OpenAI、Anthropic 等）的 CONTRACT 注入
- 支持 `X-Escalated-From / X-Escalated-To` 审计日志
- **PEEK 超时兑底**：为 peek 阶段加 `PEEK_TIMEOUT_MS`，超时后直接透传。目前如果模型输出超长的 `need-more` 前缀（如 `<<<NEEDS_PRO: ` 后跟超长 reason），会在 `PEEK_MAX_CONTENT_CHARS=1024` 才兑底。超时机制能在极端情况下更快释放。
