# MCP StreamableHTTP Complete Guide

## 概述

本文档记录了将 MCP (Model Context Protocol) 服务器从 SSE (Server-Sent Events) 传输升级到 StreamableHTTP 传输的完整过程，以及调试和问题解决的详细经验。

## 背景

原始实现使用 `SSEServerTransport` 和双端点架构（`/sse` + `/messages`），升级后使用 `StreamableHTTPServerTransport` 和单一端点架构（`/mcp`），提供更好的会话管理、可恢复性和错误处理。

## 升级计划

### 主要差异对比

| 特性 | SSE 实现 | StreamableHTTP 实现 |
|------|----------|-------------------|
| 传输类 | `SSEServerTransport` | `StreamableHTTPServerTransport` |
| 端点结构 | `/sse` (GET) + `/messages` (POST) | `/mcp` (GET/POST/DELETE) |
| 会话管理 | 简单的传输映射 | 完整的会话生命周期 |
| 可恢复性 | 无 | InMemoryEventStore 支持 |
| HTTP方法 | GET + POST | GET/POST/DELETE |
| 错误处理 | 基础 | 增强的状态码和错误响应 |

### 升级步骤

1. **替换传输层** - 从 SSE 切换到 StreamableHTTP
2. **重构端点结构** - 合并为单个 `/mcp` 端点
3. **增强会话管理** - 添加传输生命周期管理
4. **添加可恢复性** - 集成 InMemoryEventStore
5. **扩展 HTTP 方法** - 支持 GET/POST/DELETE
6. **保留现有功能** - 确保 `search_codebase` 工具正常工作
7. **更新配置输出** - 修改CLI显示信息

## 具体实现

### 1. 依赖项更新

```typescript
// 原始导入
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

// 升级后导入
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
```

### 2. 类属性更新

```typescript
// 原始
private sseTransports: Map<string, SSEServerTransport> = new Map();

// 升级后
private transports: Map<string, StreamableHTTPServerTransport> = new Map();
```

### 3. 端点重构

#### 原始实现（双端点）
```typescript
// SSE 连接端点
app.get('/sse', async (_req: Request, res: Response) => {
    const sessionId = this.generateSessionId();
    transport = new SSEServerTransport('/messages', res);
    // ...
});

// 消息处理端点
app.post('/messages', async (req: Request, res: Response) => {
    await transport.handlePostMessage(req, res);
});
```

#### 升级后实现（单端点）
```typescript
// 统一 MCP 端点处理器
const mcpHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    
    let transport: StreamableHTTPServerTransport;
    if (sessionId && this.transports.has(sessionId)) {
        // 复用现有传输
        transport = this.transports.get(sessionId)!;
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
        // 新的初始化请求
        const eventStore = new InMemoryEventStore();
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore,
            onsessioninitialized: (sessionId) => {
                this.transports.set(sessionId, transport);
            }
        });
        
        await this.mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
    } else {
        // 无效请求
        res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' }
        });
        return;
    }
    
    await transport.handleRequest(req, res, req.body);
};

// 设置端点
app.post('/mcp', mcpHandler);
app.get('/mcp', mcpHandler);
app.delete('/mcp', mcpHandler);
```

### 4. 会话管理增强

```typescript
// 传输生命周期管理
transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && this.transports.has(sid)) {
        console.log(`Transport closed for session ${sid}`);
        this.transports.delete(sid);
    }
};
```

### 5. 可恢复性支持

```typescript
// 事件存储初始化
const eventStore = new InMemoryEventStore();
transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    eventStore, // 启用可恢复性
    onsessioninitialized: (sessionId) => {
        this.transports.set(sessionId, transport);
    }
});
```

### 6. 客户端适配

#### HTTP 请求头设置
```typescript
const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream', // 关键：两种类型都要接受
    'MCP-Session-ID': this.sessionId // 会话ID管理
};
```

#### SSE 连接
```typescript
const req = http.request({
    method: 'GET',
    path: '/mcp', // 使用新端点
    headers: {
        'Accept': 'text/event-stream',
        'MCP-Session-ID': this.sessionId // 必须包含会话ID
    }
});
```

### 7. 配置输出更新

```typescript
// 更新CLI显示信息
console.log('To connect your IDE to the HTTP Streamable MCP server, use the following configuration:');
console.log(JSON.stringify({
  "mcpServers": {
    "codebase": {
      "url": `http://localhost:3002/mcp` // 新端点
    }
  }
}, null, 2));
```

## 调试和问题解决

### 遇到的问题

在测试 MCP StreamableHTTP 客户端时，遇到了客户端超时问题：

```
❌ List tools error: Error: Request 2 timed out
❌ Search error: Error: Request 3 timed out  
❌ Stats error: Error: Request 4 timed out
```

客户端能够成功建立连接和初始化，但后续的工具调用请求都超时无响应。

### 问题分析过程

#### 1. 初步观察

通过日志分析发现：
- ✅ 服务器启动正常
- ✅ 健康检查正常
- ✅ 初始化请求成功
- ✅ SSE连接建立成功（200状态码）
- ❌ 后续请求（tools/list、tools/call）超时无响应

#### 2. 深入调试

创建了简单的测试脚本 `test-simple-request.js` 来调试HTTP请求响应：

```javascript
// 简单的HTTP POST测试
const response = await httpRequest('/mcp', 'POST', listRequest);
```

**关键发现**：
- 服务器实际上是正常工作的
- 响应是直接通过HTTP POST返回的
- 响应格式是SSE格式的文本：`event: message\nid: ...\ndata: {...}`

#### 3. 根本原因

客户端的设计逻辑有误：
- **期望流程**：通过HTTP POST发送请求 → 通过SSE流接收响应
- **实际情况**：通过HTTP POST发送请求 → **响应直接通过HTTP POST返回**（SSE格式文本）

### 解决方案

#### 1. 服务器端修复 - Session ID 传播

**问题**：Session ID 没有在响应头中返回给客户端

**解决方案** (`src/mcp/http-server.ts`)：
```typescript
// 原始代码
onsessioninitialized: (sessionId) => {
    console.log(`Session initialized with ID: ${sessionId}`);
    this.transports.set(sessionId, transport);
}

// 修复后
onsessioninitialized: (sessionId) => {
    console.log(`Session initialized with ID: ${sessionId}`);
    this.transports.set(sessionId, transport);
    // 设置响应头供客户端提取
    res.setHeader('MCP-Session-ID', sessionId);
}
```

#### 2. 客户端修复 - 响应处理逻辑

**问题**：客户端期望通过SSE流接收响应，但响应实际通过HTTP POST直接返回

**解决方案** (`src/examples/debug-mcp-streamable-client.js`)：

```javascript
// 原始逻辑 - 错误的异步等待
async sendRequest(method, params = {}) {
    // ... 构建请求
    return new Promise(async (resolve, reject) => {
        this.requests.set(id, { resolve, reject });
        
        try {
            await this.httpRequest('/mcp', 'POST', request);
            // 期望响应通过SSE到达 - 这是错误的！
        } catch (error) {
            // ...
        }
    });
}

// 修复后 - 直接处理HTTP响应
async sendRequest(method, params = {}) {
    // ... 构建请求
    
    try {
        const response = await this.httpRequest('/mcp', 'POST', request);
        
        // 解析SSE格式响应（如果是文本格式）
        if (typeof response === 'string' && response.includes('data: ')) {
            const lines = response.split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    try {
                        const jsonResponse = JSON.parse(data);
                        if (jsonResponse.id === id) {
                            console.log('📨 Parsed response:', JSON.stringify(jsonResponse, null, 2));
                            return jsonResponse;
                        }
                    } catch (e) {
                        console.log('Failed to parse SSE data:', data);
                    }
                }
            }
        } else if (response && response.id === id) {
            // 直接JSON响应
            console.log('📨 Direct response:', JSON.stringify(response, null, 2));
            return response;
        }
        
        throw new Error('No valid response received');
    } catch (error) {
        console.error('❌ Request error:', error);
        throw error;
    }
}
```

### 其他遇到的问题和解决方案

#### 问题1：Accept头不正确
**错误信息：** "Not Acceptable: Client must accept both application/json and text/event-stream"

**解决方案：** 在HTTP请求中添加正确的Accept头：
```typescript
'Accept': 'application/json, text/event-stream'
```

#### 问题2：会话ID管理
**问题：** 初始化请求需要正确获取和传递会话ID

**解决方案：** 
1. 初始化请求不需要会话ID
2. 从响应头提取会话ID
3. 后续请求都包含会话ID头

#### 问题3：端点统一
**问题：** 从双端点架构迁移到单端点架构

**解决方案：** 使用统一的处理器根据HTTP方法和请求内容进行路由

## 测试验证

### 创建测试客户端

基于原有的 SSE 测试客户端，创建了适配 StreamableHTTP 的新测试客户端：

```javascript
// src/examples/debug-mcp-streamable-client.js
class SimpleMCPStreamableClient {
    async initialize() {
        // 发送初始化请求获取会话ID
        const initRequest = {
            jsonrpc: '2.0',
            method: 'initialize',
            params: { /* ... */ }
        };
        
        const response = await this.httpRequest('/mcp', 'POST', initRequest);
        // 从响应头或响应体提取会话ID
        this.sessionId = response.headers['mcp-session-id'];
    }
    
    async connectSSE() {
        // 使用会话ID建立SSE连接
        const req = http.request({
            path: '/mcp',
            method: 'GET',
            headers: {
                'Accept': 'text/event-stream',
                'MCP-Session-ID': this.sessionId
            }
        });
    }
}
```

### 测试结果

修复后所有测试都通过：

```
📊 Test Results Summary:
✅ Passed: 4
❌ Failed: 0
📝 Total: 4

🎉 All tests passed successfully!
```

**具体测试项目：**

1. **Health Check** ✅ - 服务器健康检查正常
2. **List Tools** ✅ - 成功获取工具列表（`search_codebase` 工具）
3. **Search Codebase** ✅ - 成功执行代码搜索
4. **Get Stats** ✅ - 正确返回"工具不存在"错误（该工具被禁用）

✅ **成功验证的功能：**
- 服务器启动和端口监听
- 健康检查端点 (`/health`)
- 初始化请求和会话ID生成
- SSE连接建立 (200状态码)
- 会话管理和请求路由
- 搜索工具功能保持正常

## 关键经验总结

### 1. StreamableHTTP 工作原理理解

- **初始化请求**：HTTP POST `/mcp` 不带session ID → 获取session ID
- **后续请求**：HTTP POST `/mcp` 带session ID → 直接返回响应
- **SSE连接**：用于通知和流式数据，不是所有响应的通道

### 2. 调试技巧

1. **分步测试**：创建简单的测试脚本验证基本功能
2. **日志分析**：仔细分析服务器和客户端日志的对应关系
3. **响应格式检查**：检查实际响应格式vs期望格式

### 3. 常见误区

- ❌ 认为所有响应都通过SSE流返回
- ❌ 忽略HTTP响应中的SSE格式数据
- ❌ Session ID传播问题被忽视

### 4. 最佳实践

1. **服务器端**：确保在初始化响应中设置session ID头
2. **客户端端**：正确处理HTTP响应和SSE格式数据
3. **调试工具**：创建简单的测试脚本快速验证基本功能

## 优势和改进

### 主要优势

1. **更好的会话管理**
   - 自动生成的UUID会话ID
   - 完整的传输生命周期管理
   - 自动清理断开的连接

2. **可恢复性支持**
   - InMemoryEventStore 事件存储
   - Last-Event-ID 断线重连机制
   - 客户端状态恢复

3. **简化的API**
   - 单一 `/mcp` 端点处理所有请求
   - 统一的错误处理
   - 更清晰的请求路由

4. **增强的错误处理**
   - 详细的错误状态码
   - 结构化的错误响应
   - 更好的调试信息

5. **扩展性**
   - 支持多种HTTP方法
   - 为未来功能预留接口
   - 更好的架构基础

### 性能改进

- 减少了连接开销
- 更高效的消息路由
- 更好的内存管理

## 相关文件

- **服务器实现**：`src/mcp/http-server.ts`
- **客户端实现**：`src/examples/debug-mcp-streamable-client.js`
- **测试脚本**：`test-simple-request.js`

## 未来考虑

1. **持久化事件存储**：将 InMemoryEventStore 替换为持久化存储以支持服务器重启后的恢复

2. **负载均衡**：为多实例部署添加会话亲和性支持

3. **监控和指标**：添加会话统计和性能监控

4. **安全增强**：考虑添加认证和授权机制

## 后续改进建议

1. **文档完善**：更新客户端集成指南，明确响应处理逻辑
2. **错误处理**：增强客户端的错误处理和重试机制
3. **测试覆盖**：添加自动化测试覆盖StreamableHTTP工作流程
4. **类型安全**：考虑添加TypeScript类型定义改善开发体验

## 总结

SSE 到 StreamableHTTP 的升级显著提升了 MCP 服务器的可靠性、可扩展性和用户体验。新架构提供了更好的会话管理、错误处理和可恢复性，为未来的功能扩展奠定了坚实的基础。

升级过程中保持了所有现有功能的兼容性，特别是核心的代码搜索功能，确保了平滑的迁移体验。通过详细的调试过程和问题解决，我们不仅成功完成了升级，还积累了宝贵的实践经验，为后续的开发和维护提供了重要参考。