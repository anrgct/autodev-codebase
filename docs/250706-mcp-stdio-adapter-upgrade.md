# MCP Stdio Adapter 升级指南

## 概述

本文档记录了将 MCP Stdio Adapter 从 SSE (Server-Sent Events) 传输升级到 StreamableHTTP 传输的完整过程，以及在升级过程中遇到的调试经验和解决方案。这次升级是为了保持与 MCP 服务器架构升级的一致性。

## 背景

原始的 Stdio Adapter 使用 SSE 架构连接到 MCP 服务器，采用双端点设计（`/sse` + `/messages`）。升级后使用 StreamableHTTP 架构和单一端点设计（`/mcp`），提供更好的会话管理和错误处理。

## 升级过程中的重要发现

在升级过程中，我们发现了一个关键的协议理解问题：

**问题表现：**
- ✅ 官方 MCP Inspector 可以正常连接
- ❌ 自定义测试客户端报错：`Request 0 timed out`

**根本原因：**
- Adapter 在启动时自动发送 `initialize` 请求
- 客户端再次发送 `initialize` 请求导致协议冲突
- 根据 MCP 协议，`initialize` 在一个会话中只能发送一次

**解决方案：**
- 修改 Adapter 启动逻辑，让客户端主导初始化过程
- Adapter 保持透明，不主动发起协议请求
- 在客户端的第一个 `initialize` 请求时才建立会话

## 升级对比

### 架构差异

| 方面 | SSE Adapter | StreamableHTTP Adapter |
|------|-------------|------------------------|
| 类名 | `StdioToSSEAdapter` | `StdioToStreamableHTTPAdapter` |
| 端点架构 | `/sse` (GET) + `/messages` (POST) | `/mcp` (GET/POST/DELETE) |
| 会话管理 | 无 | 完整的 session ID 管理 |
| 初始化流程 | 直接连接 SSE | 先初始化获取会话ID，再建立SSE |
| 响应处理 | 仅 SSE 流 | HTTP 直接响应 + SSE 流混合 |
| 默认端口 | 3001 | 3002 |

### 文件变更

主要涉及的文件：
- `src/mcp/stdio-adapter.ts` - 核心 adapter 实现
- `src/cli/tui-runner.ts` - CLI 运行器中的类名引用
- `src/examples/debug-mcp-client.js` - 测试客户端

## 详细升级步骤

### 第一阶段：基础架构升级

#### 1. 类名和注释更新

```typescript
// 原始
export class StdioToSSEAdapter {
  // ...
}

// 升级后
export class StdioToStreamableHTTPAdapter {
  // ...
}
```

**变更内容：**
- 类名从 `StdioToSSEAdapter` 改为 `StdioToStreamableHTTPAdapter`
- 更新注释说明，从 SSE 改为 StreamableHTTP
- 更新示例URL：`3001/sse` → `3002/mcp`

### 2. 添加会话管理

```typescript
export class StdioToStreamableHTTPAdapter {
  private serverUrl: string;
  private timeout: number;
  private requests: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>;
  private sseConnection: http.IncomingMessage | null = null;
  private connected: boolean = false;
  private running: boolean = false;
  private sessionId: string | null = null; // 新增
}
```

**关键变更：**
- 添加 `sessionId` 私有属性
- 用于存储从服务器获取的会话ID

### 3. 重构初始化流程

```typescript
async start(): Promise<void> {
  this.running = true;

  // 第一阶段：初始化连接获取 session ID
  await this.initializeConnection();

  // 第二阶段：使用 session ID 建立 SSE 连接
  await this.connectSSE();

  // 设置 stdio 处理器
  this.setupStdioHandlers();

  console.error('🔌 Stdio adapter started and connected to server');
}
```

**新增初始化方法：**

```typescript
private async initializeConnection(): Promise<void> {
  const initRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {
        roots: { listChanged: true },
        sampling: {}
      },
      clientInfo: {
        name: 'stdio-streamable-adapter',
        version: '1.0.0'
      }
    }
  };

  console.error('🔧 Initializing connection...');

  try {
    const response = await this.httpRequest('', 'POST', initRequest);

    // 从响应头提取 session ID
    if (response.headers && response.headers['mcp-session-id']) {
      this.sessionId = response.headers['mcp-session-id'];
      console.error(`🔑 Session ID obtained: ${this.sessionId}`);
    } else {
      throw new Error('No session ID received from server');
    }
  } catch (error) {
    console.error('❌ Failed to initialize connection:', error);
    throw error;
  }
}
```

### 4. 更新 SSE 连接逻辑

```typescript
private async connectSSE(): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(this.serverUrl);

    if (!this.sessionId) {
      reject(new Error('Session ID is required for SSE connection'));
      return;
    }

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'MCP-Session-ID': this.sessionId  // 关键：添加会话ID头
      }
    }, (res) => {
      // ... 处理响应
    });
  });
}
```

### 5. 更新 HTTP 请求方法

```typescript
private async httpRequest(path: string, method: string = 'GET', data: any = null): Promise<any> {
  return new Promise((resolve, reject) => {
    // 直接使用 serverUrl，不再需要路径拼接
    const serverUrl = new URL(this.serverUrl);
    const postData = data ? JSON.stringify(data) : null;

    const headers: any = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',  // 关键：接受两种类型
      ...(postData && { 'Content-Length': Buffer.byteLength(postData) })
    };

    // 添加 session ID 头（如果可用）
    if (this.sessionId) {
      headers['MCP-Session-ID'] = this.sessionId;
    }

    const options = {
      hostname: serverUrl.hostname,
      port: serverUrl.port,
      path: serverUrl.pathname,  // 直接使用 /mcp 端点
      method: method,
      headers
    };

    // ... 处理请求和响应
  });
}
```

### 6. 更新响应处理逻辑

```typescript
private async forwardRequestToServer(request: any): Promise<any> {
  try {
    // 发送 HTTP POST 请求到 /mcp 端点
    const response = await this.httpRequest('', 'POST', request);

    // 处理不同的响应格式
    if (response.data && typeof response.data === 'string' && response.data.includes('data: ')) {
      // SSE 格式响应 - 解析它
      const lines = response.data.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          try {
            const jsonResponse = JSON.parse(data);
            if (jsonResponse.id === request.id) {
              console.error('📨 Parsed SSE response:', JSON.stringify(jsonResponse, null, 2));
              return jsonResponse;
            }
          } catch (e) {
            console.error('Failed to parse SSE data:', data);
          }
        }
      }
      throw new Error('No valid response found in SSE data');
    } else if (response.id === request.id) {
      // 直接 JSON 响应
      console.error('📨 Direct response:', JSON.stringify(response, null, 2));
      return response;
    } else {
      // 响应通过 SSE 到达 - 等待它
      return new Promise((resolve, reject) => {
        // ... 设置超时和 promise 解析器
      });
    }
  } catch (error) {
    console.error('❌ Request error:', error);
    throw error;
  }
}
```

### 7. 更新 CLI 运行器

在 `src/cli/tui-runner.ts` 中：

```typescript
// 原始
const { StdioToSSEAdapter } = await import('../mcp/stdio-adapter');
const adapter = new StdioToSSEAdapter({
  serverUrl: options.stdioServerUrl || 'http://localhost:3001/sse',
  timeout: options.stdioTimeout || 30000
});

// 升级后
const { StdioToStreamableHTTPAdapter } = await import('../mcp/stdio-adapter');
const adapter = new StdioToStreamableHTTPAdapter({
  serverUrl: options.stdioServerUrl || 'http://localhost:3002/mcp',
  timeout: options.stdioTimeout || 30000
});
```

### 8. 更新测试客户端

在 `src/examples/debug-mcp-client.js` 中：

**主要变更：**
- 默认 URL：`http://localhost:3001/sse` → `http://localhost:3002/mcp`
- 更新帮助文档和注释
- ⚠️ **注意：这里的跳过 initialize 测试导致了后续的调试问题**

```javascript
// 更新默认配置
this.serverUrl = options.serverUrl || 'http://localhost:3002/mcp';

// 初始的错误实现（导致了调试问题）
async testInitialize() {
  console.log('\n🔧 Testing initialize...');
  console.log('ℹ️  Note: Initialize is already handled by the adapter during startup');
  console.log('✅ Initialize completed during adapter startup');
  return { result: 'already_initialized' };
}
```

### 第二阶段：调试和修复

#### 9. 发现协议理解问题

升级完成后，测试发现：
- 官方 MCP Inspector 工作正常
- 自定义测试客户端报错：`Request 0 timed out`

**错误日志分析：**
```
🔧 Initializing connection...  // Adapter 自动初始化
🔑 Session ID obtained: xxx
🔌 Stdio adapter started and connected to server

// 客户端发送 initialize 请求
❌ Failed to handle stdin message: ... Error: Request 0 timed out
```

#### 10. 修复 Adapter 启动逻辑

**原始错误设计：**
```typescript
async start(): Promise<void> {
  this.running = true;

  // ❌ 错误：Adapter 自动发送 initialize 请求
  await this.initializeConnection();
  await this.connectSSE();

  this.setupStdioHandlers();
}
```

**修复后的正确设计：**
```typescript
async start(): Promise<void> {
  this.running = true;

  // ✅ 正确：等待客户端发送 initialize 请求
  this.setupStdioHandlers();

  console.error('🔌 Stdio adapter started and ready for connections');
}
```

#### 11. 重构请求处理逻辑

**关键改进：**
```typescript
private async forwardRequestToServer(request: any): Promise<any> {
  try {
    // 特殊处理 initialize 请求
    if (request.method === 'initialize' && !this.sessionId) {
      console.error('🔧 Handling initialize request from client...');
      const response = await this.httpRequest('', 'POST', request);

      // 从响应头提取 session ID
      if (response.headers && response.headers['mcp-session-id']) {
        this.sessionId = response.headers['mcp-session-id'];
        console.error(`🔑 Session ID obtained: ${this.sessionId}`);

        // 启动 SSE 连接
        await this.connectSSE();
      }

      return this.handleInitializeResponse(response, request.id);
    }

    // 对于非 initialize 请求，确保有会话
    if (!this.sessionId) {
      throw new Error('No session ID available. Initialize must be called first.');
    }

    // 正常处理其他请求...
  }
}
```

#### 12. 修复测试客户端

**问题：** 测试客户端跳过了真实的 `initialize` 请求

**修复：** 恢复真实的 `initialize` 请求
```javascript
async testInitialize() {
  console.log('\n🔧 Testing initialize...');
  try {
    const response = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        roots: { listChanged: true },
        sampling: {}
      },
      clientInfo: {
        name: 'stdio-adapter-test-client',
        version: '1.0.0'
      }
    });
    console.log('✅ Initialize response:', response);
    return response;
  } catch (error) {
    console.error('❌ Initialize error:', error);
    throw error;
  }
}
```

## 关键技术要点

### 1. 会话管理

- **初始化请求**：第一次 POST `/mcp` 请求不包含 session ID
- **会话获取**：从响应头 `MCP-Session-ID` 提取会话ID
- **后续请求**：所有请求都必须包含 `MCP-Session-ID` 头
- **⚠️ 重要**：`initialize` 请求在一个会话中只能发送一次

### 2. 响应处理

StreamableHTTP 可能返回两种格式的响应：
- **直接 JSON 响应**：立即通过 HTTP POST 返回
- **SSE 格式响应**：以 `event: message\ndata: {...}` 格式返回

### 3. 错误处理

- 增强的连接错误处理
- 更详细的调试日志
- 会话ID验证和错误提示
- 重复 initialize 请求的检测和处理

### 4. 兼容性

- 保持与原有 stdio 协议的兼容
- 向后兼容的端点配置
- 无缝的服务器切换

### 5. MCP 协议理解

- **初始化唯一性**：`initialize` 请求在一个会话中只能发送一次
- **客户端主导**：会话初始化应该由客户端发起，而不是 Adapter
- **透明代理**：Adapter 应该透明地转发请求，不应该主动发起协议请求

### 6. 架构设计原则

- **单一职责**：Adapter 只负责协议转换，不负责会话管理
- **被动响应**：等待客户端请求，而不是主动初始化
- **状态管理**：基于客户端请求的状态变化，而不是预设状态

## 测试验证

### 启动服务器
```bash
codebase mcp-server --demo --port=3002
```

### 测试 Adapter
```bash
node src/examples/debug-mcp-client.js
```

### 预期结果

**修复前（错误的输出）：**
```
🔧 Initializing connection...  // ❌ Adapter 自动初始化
🔑 Session ID obtained: xxx
🔌 Stdio adapter started and connected to server

// 客户端发送 initialize 请求
❌ Failed to handle stdin message: ... Error: Request 0 timed out
```

**修复后（正确的输出）：**
```
🧪 Stdio Adapter Test Client Starting...
📋 Configuration:
   Server URL: http://localhost:3002/mcp
   Timeout: 30000ms
🔌 Starting Stdio Adapter...
🔌 Stdio adapter started and ready for connections  // ✅ 等待客户端

// 客户端发送 initialize 请求
🔧 Handling initialize request from client...  // ✅ 正确处理
🔑 Session ID obtained: [session-id]
📨 Initialize response: {...}  // ✅ 成功响应
✅ Tools list: [tools]
✅ Search result: [results]
✅ All tests completed successfully!
```

## 常见问题和解决方案

### 问题1: `StdioToSSEAdapter is not a constructor`
**原因：** 类名更新后，导入引用未更新
**解决：** 更新所有文件中的类名引用

### 问题2: `ECONNREFUSED`
**原因：** 服务器未启动或端口不匹配
**解决：** 确保服务器在正确端口运行

### 问题3: `Request timed out`（重要问题）
**原因：** 重复发送 initialize 请求导致协议冲突
**错误理解：** ~~adapter 启动时已处理初始化，测试客户端无需重复~~
**正确理解：** Adapter 不应该主动发起初始化，应该等待客户端请求
**解决方案：**
1. 修改 Adapter 启动逻辑，移除自动初始化
2. 在客户端的第一个 `initialize` 请求时才建立会话
3. 恢复测试客户端的真实 `initialize` 请求

### 问题4: `No session ID received`
**原因：** 服务器未设置响应头
**解决：** 确保服务器在初始化响应中设置 `MCP-Session-ID` 头

### 问题5: 官方 Inspector 工作但自定义客户端失败
**原因：** 对 MCP 协议的理解偏差
**解决：** 理解 MCP 协议的会话管理机制，确保 Adapter 保持透明

## 优势和改进

### 升级后的优势

1. **更好的会话管理**
   - 自动生成的 UUID 会话ID
   - 完整的传输生命周期管理
   - 自动清理断开的连接

2. **简化的 API**
   - 单一 `/mcp` 端点处理所有请求
   - 统一的错误处理
   - 更清晰的请求路由

3. **增强的错误处理**
   - 详细的错误状态码
   - 结构化的错误响应
   - 更好的调试信息

4. **更好的兼容性**
   - 支持多种 HTTP 方法
   - 混合响应格式处理
   - 向前兼容的架构

## 核心经验总结

### 1. MCP 协议理解

- **初始化唯一性**：`initialize` 请求在一个会话中只能发送一次
- **客户端主导**：会话初始化应该由客户端发起，而不是 Adapter
- **透明代理**：Adapter 应该透明地转发请求，不应该主动发起协议请求

### 2. 架构设计原则

- **单一职责**：Adapter 只负责协议转换，不负责会话管理
- **被动响应**：等待客户端请求，而不是主动初始化
- **状态管理**：基于客户端请求的状态变化，而不是预设状态

### 3. 调试方法论

- **日志对比**：对比工作和不工作的情况，找出差异
- **协议分析**：理解 MCP 协议的预期行为
- **逐步验证**：先修复架构问题，再验证测试代码

### 4. 测试策略

- **官方工具优先**：使用官方 MCP Inspector 验证基本功能
- **自定义测试补充**：用自定义测试验证特定场景
- **真实协议**：测试代码应该模拟真实的协议交互

## 最佳实践建议

### 1. Adapter 设计

```typescript
class StdioToStreamableHTTPAdapter {
  async start() {
    // ✅ 只设置处理器，不主动发起请求
    this.setupStdioHandlers();
  }

  private async forwardRequestToServer(request: any) {
    // ✅ 根据请求类型采取不同处理策略
    if (request.method === 'initialize' && !this.sessionId) {
      return this.handleInitializeRequest(request);
    }

    if (!this.sessionId) {
      throw new Error('No session ID available. Initialize must be called first.');
    }

    return this.handleRegularRequest(request);
  }
}
```

### 2. 测试客户端

```javascript
class TestClient {
  async runFullTest() {
    // ✅ 必须先发送真实的 initialize 请求
    await this.testInitialize();

    // ✅ 然后测试其他功能
    await this.testListTools();
    await this.testToolCalls();
  }
}
```

### 3. 错误处理

```typescript
// ✅ 详细的错误信息和状态检查
if (!this.sessionId) {
  throw new Error(`No session ID available. Initialize must be called first. Current state: ${this.getState()}`);
}
```

## 后续改进建议

1. **状态机模式**：考虑使用状态机来管理 Adapter 的生命周期
2. **错误恢复**：添加连接断开后的自动重连机制
3. **协议验证**：增加更严格的 MCP 协议合规性检查
4. **测试覆盖**：添加更多边界情况和错误场景的测试
5. **性能优化**：优化请求路由和响应处理
6. **监控支持**：添加性能指标和健康检查
7. **文档完善**：更新集成指南和最佳实践

## 总结

SSE 到 StreamableHTTP 的 adapter 升级成功完成，实现了：

- ✅ 完整的架构升级（SSE → StreamableHTTP）
- ✅ 增强的会话管理和错误处理
- ✅ 简化的端点架构（双端点 → 单端点）
- ✅ 向后兼容的 stdio 协议支持
- ✅ 全面的测试验证
- ✅ **重要**：解决了协议理解偏差导致的重复初始化问题

**关键教训：理解协议的预期行为比实现技术细节更重要。**

这次升级经历了两个阶段：
1. **技术升级**：成功完成 SSE 到 StreamableHTTP 的架构转换
2. **协议理解修正**：发现并修复了对 MCP 协议理解的偏差

最终的 adapter 不仅实现了架构升级，更重要的是符合了 MCP 协议的设计理念：**让客户端主导会话，让 Adapter 保持透明。**

升级后的 adapter 为 MCP 客户端提供了更可靠、更易维护的连接方式，与新的 StreamableHTTP 服务器架构完美集成。

## 相关文件

- **核心实现**：`src/mcp/stdio-adapter.ts`
- **CLI 集成**：`src/cli/tui-runner.ts`
- **测试客户端**：`src/examples/debug-mcp-client.js`
- **服务器升级文档**：`docs/250706-mcp-sse-to-streamable-upgrade.md`
- **调试经验记录**：`docs/mcp-stdio-adapter-debug-experience.md`

# 背景知识
## stdio，sse，streamble mcp的区别

1. Stdio (标准输入输出)

什么是 Stdio？
- Stdio 是 Standard Input/Output 的缩写
- 是进程间通信的基本方式，通过 stdin（标准输入）和 stdout（标准输出）进行数据交换
- 就像在终端中输入命令，程序从 stdin 读取，向 stdout 输出

在 MCP 中的作用：
客户端程序 <---> Stdio Adapter <---> MCP 服务器
      ↑                              ↑
    stdin/stdout                   HTTP/SSE

2. SSE (Server-Sent Events)

什么是 SSE？
- SSE 是一种 HTTP 技术，允许服务器向客户端持续推送数据
- 单向通信：只能服务器向客户端发送消息
- 基于 HTTP 长连接，格式简单

SSE 格式示例：
data: {"jsonrpc": "2.0", "result": "hello"}

data: {"jsonrpc": "2.0", "result": "world"}

在 MCP 中的架构：
客户端 --POST--> /messages (发送请求)
客户端 <--SSE--- /sse (接收响应)

3. StreamableHTTP

什么是 StreamableHTTP？
- 这是 MCP 项目自己设计的一种改进的 HTTP 通信方式
- 结合了 HTTP 请求/响应和 SSE 流式传输的优点
- 更好的会话管理和错误处理

StreamableHTTP 架构：
客户端 <--HTTP/SSE--> /mcp (单一端点处理所有通信)

实际的通信流程对比

SSE 模式的通信流程：

1. 客户端 GET /sse           -> 建立 SSE 连接
2. 客户端 POST /messages     -> 发送 JSON-RPC 请求
3. 服务器通过 SSE 推送响应   -> 客户端从 SSE 流接收

StreamableHTTP 模式的通信流程：

1. 客户端 POST /mcp          -> 发送 initialize 请求
2. 服务器返回 HTTP 响应      -> 包含 session-id
3. 客户端 GET /mcp           -> 使用 session-id 建立 SSE
4. 客户端 POST /mcp          -> 发送后续请求
5. 服务器可以：
    - 直接 HTTP 响应          -> 立即返回结果
    - 或通过 SSE 推送         -> 异步返回结果

为什么需要 Stdio Adapter？

很多程序（特别是命令行工具）期望通过 stdin/stdout 与 MCP 服务器通信，但 MCP 服务器使用HTTP。Stdio Adapter 就是一个"翻译器"：

程序 <--stdin/stdout--> Stdio Adapter <--HTTP/SSE--> MCP 服务器

升级的核心改进

1. 端点简化

- SSE: 需要两个端点 /sse + /messages
- StreamableHTTP: 只需一个端点 /mcp

2. 会话管理

- SSE: 没有会话概念，连接就是会话
- StreamableHTTP: 有明确的 session ID，可以管理多个会话

3. 响应方式

- SSE: 所有响应都通过 SSE 流
- StreamableHTTP: 可以选择直接 HTTP 响应或 SSE 流

4. 错误处理

- SSE: 错误处理相对简单
- StreamableHTTP: 更完善的错误状态码和错误恢复

类比理解

把这三个概念类比成通信方式：

- Stdio: 像对讲机，一对一直接通话
- SSE: 像广播电台，只能听不能说，需要额外的电话线打进去
- StreamableHTTP: 像现代的智能手机，可以打电话、发短信、视频通话，一个设备多种通信方式

升级就是从"广播电台+电话"的组合，升级到"智能手机"的统一通信方式。

## StreamableHTTP也要建立sse?

StreamableHTTP 中的 SSE 使用场景

StreamableHTTP 并不是总是需要建立 SSE，而是根据需要选择性使用：

1. 短响应 - 只用 HTTP

客户端 POST /mcp -> 服务器立即返回 JSON
比如简单的查询请求，服务器可以直接在 HTTP 响应中返回结果。

2. 长响应或流式响应 - 使用 SSE

客户端 POST /mcp -> 服务器返回 HTTP 202 (接受)
客户端 GET /mcp (with session-id) -> 建立 SSE 接收流式数据
比如大文件搜索、AI 生成内容等需要时间的操作。

具体的工作模式

SSE 架构（旧）：

必须同时使用两种连接：
客户端 GET /sse        (必须建立，用于接收所有响应)
客户端 POST /messages  (发送所有请求)

StreamableHTTP 架构（新）：

情况1 - 简单请求：
客户端 POST /mcp -> 服务器直接返回结果 (不需要 SSE)

情况2 - 复杂请求：
客户端 POST /mcp -> 服务器返回"处理中"
客户端 GET /mcp  -> 建立 SSE 接收流式结果

在代码中的体现

看升级文档中的这段代码：
```
private async forwardRequestToServer(request: any): Promise<any> {
  const response = await this.httpRequest('', 'POST', request);

  // 服务器可能返回三种情况：

  // 情况1：直接 JSON 响应（不需要 SSE）
  if (response.id === request.id) {
    return response; // 立即返回，无需 SSE
  }

  // 情况2：SSE 格式的数据（已经通过 HTTP 返回）
  if (response.data && response.data.includes('data: ')) {
    return this.parseSSEData(response.data);
  }

  // 情况3：需要等待 SSE 流（延迟响应）
  return new Promise((resolve) => {
    // 等待通过 SSE 连接接收数据
  });
}
```
为什么这样设计？

性能优化：
- 简单请求（如获取工具列表）-> 直接 HTTP 响应，快速
- 复杂请求（如搜索大文件）-> SSE 流式响应，可以显示进度

灵活性：
- 服务器可以根据请求的复杂程度选择响应方式
- 客户端不需要预先知道会用哪种方式响应

对比总结

| 架构             | SSE 使用     | 优缺点     |
|----------------|------------|---------|
| SSE            | 总是需要建立 SSE | 简单但不够灵活 |
| StreamableHTTP | 按需建立 SSE   | 灵活但实现复杂 |

所以 StreamableHTTP 的"聪明"之处在于：它可以选择最合适的响应方式，而不是强制使用一种方式。

这就像智能手机可以选择打电话、发短信或视频通话，而不是只能用一种通信方式。

## 为什么不使用websock呢？

为什么不使用 WebSocket

1. 协议兼容性考虑

- MCP 基于 JSON-RPC 2.0 协议设计
- HTTP + SSE 组合更符合 RESTful API 设计模式
- 与现有 Web 技术栈兼容性更好

2. 实现复杂度

// HTTP + SSE: 清晰的请求/响应模式
POST /mcp -> 立即响应 或 SSE 流式响应
GET /mcp -> SSE 连接（仅在需要时）

// WebSocket: 需要管理双向消息路由
connection.send(request) -> 需要匹配 response ID
connection.onmessage -> 需要路由到正确的 promise

3. 灵活的响应策略

StreamableHTTP 的核心优势是响应方式的灵活性：

- 简单请求: 直接 HTTP 响应，无需建立持久连接
- 复杂请求: SSE 流式响应，支持进度更新
- 混合模式: 服务器可根据请求复杂度动态选择

而 WebSocket 强制所有通信都走持久连接，失去了这种灵活性。

4. 基础设施友好

- HTTP/SSE 对代理、负载均衡器、CDN 支持更好
- 更容易调试（可用标准 HTTP 工具）
- 防火墙和企业网络环境兼容性更好

5. 渐进式升级路径

从文档可以看到升级路径：
Stdio -> SSE (双端点) -> StreamableHTTP (单端点) -> 未来可能支持更多传输方式

StreamableHTTP 设计为可扩展的传输层，未来可以在不破坏现有 API 的情况下添加 WebSocket支持。

6. 资源使用考虑

- WebSocket 需要保持持久连接，消耗更多服务器资源
- HTTP + 按需 SSE 只在必要时建立连接，更节省资源
- 对于大多数简单的 MCP 请求，WebSocket 的开销是不必要的

总结：StreamableHTTP 选择 HTTP + SSE
的组合是在简单性、灵活性、兼容性之间的平衡选择，而不是单纯的技术限制。这种设计更适合 MCP的实际使用场景。
