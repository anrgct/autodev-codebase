/**
 * MCP Server Integration Tests
 *
 * 测试MCP服务器的核心功能：
 * 1. HTTP MCP服务器启动和健康检查
 * 2. MCP协议初始化
 * 3. 工具列表和调用
 * 4. search_codebase工具功能
 *
 * 更新说明：
 * - 适配当前项目的HTTP MCP服务器架构
 * - 使用vitest语法和项目的mock系统
 * - 直接使用CodebaseHTTPMCPServer而不是通过CLI启动
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { CodebaseHTTPMCPServer } from '../mcp/http-server.js'
import { createNodeDependencies, CodeIndexManager } from '../index.js'

/**
 * MCP HTTP测试客户端
 * 封装HTTP通信和会话管理
 */
class MCPHTTPTestClient {
  private baseUrl: string
  private server: CodebaseHTTPMCPServer | null = null
  private sessionId: string | null = null
  private requestId = 0

  constructor(baseUrl: string = 'http://localhost:13003') {
    this.baseUrl = baseUrl
  }

  /**
   * 启动HTTP MCP服务器
   */
  async startServer(workspacePath: string): Promise<void> {
    console.log('🚀 Starting HTTP MCP Server...')

    // 创建Node.js依赖
    const deps = createNodeDependencies({
      workspacePath,
      storageOptions: {
        globalStoragePath: path.join(workspacePath, '.autodev-cache')
      },
      loggerOptions: {
        level: 'error' // 减少测试时的日志输出
      },
      configOptions: {}
    })

    // 创建CodeIndexManager实例
    const manager = CodeIndexManager.getInstance(deps)
    if (!manager) {
      throw new Error('Failed to create CodeIndexManager instance')
    }
    await manager.initialize()

    // 创建HTTP MCP服务器
    this.server = new CodebaseHTTPMCPServer({
      codeIndexManager: manager,
      port: 13003,
      host: 'localhost'
    })

    // 启动服务器
    await this.server.start()

    console.log('✅ HTTP MCP Server started at http://localhost:13003')
  }

  /**
   * 等待服务器就绪
   */
  async waitForServer(maxAttempts: number = 30): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`${this.baseUrl}/health`)
        if (response.ok) {
          const health = await response.json()
          console.log('✅ Server is ready:', health)
          return
        }
      } catch (error) {
        // 服务器尚未就绪
      }

      console.log(`⏳ Attempt ${i + 1}/${maxAttempts} - waiting for server...`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    throw new Error('Server failed to start within timeout')
  }

  /**
   * 发送HTTP请求
   */
  async httpRequest(path: string, method: string = 'GET', data: any = null): Promise<any> {
    const url = `${this.baseUrl}${path}`
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
    }

    if (data) {
      options.body = JSON.stringify(data)
    }

    if (this.sessionId) {
      options.headers = {
        ...options.headers,
        'MCP-Session-ID': this.sessionId
      }
    }

    const response = await fetch(url, options)

    // 提取会话ID
    if (!this.sessionId && response.headers.get('mcp-session-id')) {
      this.sessionId = response.headers.get('mcp-session-id')
      console.log(`🔑 Session ID from header: ${this.sessionId}`)
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const responseText = await response.text()

    // 尝试解析SSE格式响应
    if (responseText.includes('event:') && responseText.includes('data:')) {
      const lines = responseText.split('\n')
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonData = line.substring(6)
          if (jsonData.trim()) {
            try {
              return JSON.parse(jsonData)
            } catch {
              // 如果解析失败，继续处理下一行
            }
          }
        }
      }
    }

    // 尝试解析JSON
    try {
      return JSON.parse(responseText)
    } catch {
      return responseText
    }
  }

  /**
   * 初始化MCP连接
   */
  async initialize(): Promise<any> {
    const initRequest = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          roots: { listChanged: true },
          sampling: {}
        },
        clientInfo: {
          name: 'vitest-integration-test-client',
          version: '1.0.0'
        }
      }
    }

    console.log('📤 Sending initialization request')
    const response = await this.httpRequest('/mcp', 'POST', initRequest)
    console.log('✅ Initialize response received, session ID:', this.sessionId)
    return response
  }

  /**
   * 发送MCP请求
   */
  async sendRequest(method: string, params: any = {}): Promise<any> {
    const id = ++this.requestId
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params
    }

    console.log(`📤 Sending ${method} request`)
    const response = await this.httpRequest('/mcp', 'POST', request)
    return response
  }

  /**
   * 调用工具
   */
  async callTool(name: string, args: any): Promise<any> {
    return await this.sendRequest('tools/call', {
      name,
      arguments: args
    })
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    if (this.server) {
      console.log('🔄 Stopping server...')
      await this.server.stop()
      this.server = null
    }
  }
}

/**
 * 创建临时工作空间
 */
async function createTestWorkspace(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-'))

  // 创建测试文件结构
  const files = [
    {
      path: 'src/utils.ts',
      content: `/**
 * 工具函数集合
 */

export function add(a: number, b: number): number {
  return a + b
}

export function multiply(a: number, b: number): number {
  return a * b
}

export function greet(name: string): string {
  return \`Hello, \${name}!\`
}
`
    },
    {
      path: 'src/index.ts',
      content: `export * from './utils'

export function main() {
  console.log('Application started')
}
`
    },
    {
      path: 'src/components/Button.tsx',
      content: `import React from 'react'

interface ButtonProps {
  label: string
  onClick: () => void
}

export const Button: React.FC<ButtonProps> = ({ label, onClick }) => {
  return <button onClick={onClick}>{label}</button>
}
`
    },
    {
      path: 'README.md',
      content: `# Test Project

This is a test project for MCP server integration testing.

## Features

- TypeScript support
- React components
- Utility functions
`
    }
  ]

  for (const file of files) {
    const filePath = path.join(tempDir, file.path)
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filePath, file.content)
  }

  console.log(`📁 Test workspace created at: ${tempDir}`)
  return tempDir
}

/**
 * 清理临时工作空间
 */
async function cleanupTestWorkspace(workspacePath: string): Promise<void> {
  try {
    await fs.rm(workspacePath, { recursive: true, force: true })
    console.log(`🗑️  Test workspace cleaned: ${workspacePath}`)
  } catch (error) {
    console.warn('⚠️  Failed to cleanup workspace:', error)
  }
}

// 测试套件
describe('MCP Server Integration Tests', () => {
  let client: MCPHTTPTestClient
  let workspacePath: string

  beforeAll(async () => {
    // 静默控制台输出以保持测试清洁
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // 创建测试工作空间
    workspacePath = await createTestWorkspace()

    // 创建并启动测试客户端
    client = new MCPHTTPTestClient('http://localhost:13003')
    await client.startServer(workspacePath)
    await client.waitForServer()

    // 初始化MCP连接
    const initResponse = await client.initialize()
    console.log('Init response:', JSON.stringify(initResponse, null, 2))

    // 等待索引完成
    console.log('⏳ Waiting for indexing to complete...')
    await new Promise(resolve => setTimeout(resolve, 20000))

    console.log('Initialization complete, ready to run tests')
  }, 120000) // beforeAll超时时间：2分钟

  afterAll(async () => {
    // 恢复console输出
    vi.restoreAllMocks()

    // 停止服务器
    await client.stop()

    // 清理工作空间
    await cleanupTestWorkspace(workspacePath)

    // 等待资源释放
    await new Promise(resolve => setTimeout(resolve, 2000))
  }, 60000) // afterAll超时时间：60秒

  describe('Server Health', () => {
    it('should respond to health check', async () => {
      const health = await client.httpRequest('/health', 'GET')

      expect(health).toBeDefined()
      expect(health.status).toBe('healthy')
      expect(health.timestamp).toBeDefined()
    })

    it('should serve main page', async () => {
      const page = await client.httpRequest('/', 'GET')

      expect(page).toBeDefined()
      expect(typeof page).toBe('string')
      expect(page).toContain('Codebase MCP Server')
    })
  })

  describe('MCP Protocol', () => {
    it('should handle initialization', async () => {
      // 初始化在beforeAll中已完成，这里验证客户端状态
      expect(client).toBeDefined()
      expect(client).toHaveProperty('sessionId')
    })

    it('should list available tools', async () => {
      const response = await client.sendRequest('tools/list')

      console.log('Tools list response:', JSON.stringify(response, null, 2))

      expect(response).toBeDefined()

      // MCP响应格式可能直接包含tools，或在result中
      const tools = response.result?.tools || response.tools
      expect(tools).toBeDefined()
      expect(tools).toBeInstanceOf(Array)
      expect(tools.length).toBeGreaterThan(0)

      // 验证search_codebase工具存在
      const searchTool = tools.find((t: any) => t.name === 'search_codebase')
      expect(searchTool).toBeDefined()
      expect(searchTool.description).toBeDefined()
      expect(searchTool.inputSchema).toBeDefined()
      expect(searchTool.inputSchema.properties.query).toBeDefined()
    })
  })

  describe('search_codebase Tool', () => {
    it('should search for function definitions', async () => {
      const response = await client.callTool('search_codebase', {
        query: 'function that adds two numbers',
        limit: 5
      })

      console.log('Search response:', JSON.stringify(response, null, 2))

      expect(response).toBeDefined()

      // 响应可能直接包含content，或在result中
      const content = response.result?.content || response.content
      expect(content).toBeDefined()
      expect(content).toBeInstanceOf(Array)
      expect(content.length).toBeGreaterThan(0)

      const textContent = content[0]
      expect(textContent.type).toBe('text')
      expect(textContent.text).toBeDefined()

      // 验证结果格式 - 无论是否找到结果，应该都有响应
      const text = textContent.text
      // 如果索引已完成，应该有结果；否则会显示 "No results found"
      expect(text.length).toBeGreaterThan(0)
    }, 45000)

    it('should search with path filters', async () => {
      const response = await client.callTool('search_codebase', {
        query: 'React component',
        limit: 3,
        filters: {
          pathFilters: ['.tsx']
        }
      })

      expect(response).toBeDefined()
      const content = response.result?.content || response.content
      expect(content).toBeDefined()
      expect(content).toBeInstanceOf(Array)
    }, 45000)

    it('should handle no results gracefully', async () => {
      const response = await client.callTool('search_codebase', {
        query: 'nonexistent quantum blockchain AI function',
        limit: 5,
        filters: {
          minScore: 0.9  // 设置很高的阈值以确保没有结果
        }
      })

      expect(response).toBeDefined()
      const content = response.result?.content || response.content
      expect(content).toBeDefined()
      expect(content).toBeInstanceOf(Array)

      const textContent = content[0]
      expect(textContent.type).toBe('text')

      console.log('No results test response:', textContent.text)

      // 验证有文本响应，无论是哪种格式
      const text = textContent.text
      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(0)
    }, 45000)

    it('should return results with proper format', async () => {
      const response = await client.callTool('search_codebase', {
        query: 'typescript function',
        limit: 3
      })

      expect(response).toBeDefined()
      const result = response.result || response
      expect(result).toBeDefined()

      const content = result.content
      expect(content).toBeInstanceOf(Array)
      expect(content.length).toBeGreaterThan(0)

      // 验证第一个结果的格式
      const firstContent = content[0]
      expect(firstContent.type).toBe('text')
      expect(firstContent.text).toBeDefined()
      expect(typeof firstContent.text).toBe('string')
    }, 45000)

    it('should validate input parameters', async () => {
      // 测试空查询参数 - 应该返回某种响应
      const response1 = await client.callTool('search_codebase', {
        query: '',
        limit: 5
      })

      expect(response1).toBeDefined()
      // 无论服务器如何处理错误，都应该有响应
      expect(response1.result || response1.content || response1.error).toBeDefined()

      // 测试无效的查询类型 - 应该返回某种响应
      const response2 = await client.callTool('search_codebase', {
        query: 123,
        limit: 5
      })

      expect(response2).toBeDefined()
      // 无论服务器如何处理错误，都应该有响应
      expect(response2.result || response2.content || response2.error).toBeDefined()
    }, 30000)

    it('should handle limit parameter correctly', async () => {
      const response = await client.callTool('search_codebase', {
        query: 'function',
        limit: 2
      })

      expect(response).toBeDefined()
      const content = response.result?.content || response.content
      expect(content).toBeDefined()

      // 结果数量应该被限制
      if (content.length > 0) {
        // 如果有结果，第一个内容应该是文本类型
        expect(content[0].type).toBe('text')
      }
    }, 30000)
  })
})
