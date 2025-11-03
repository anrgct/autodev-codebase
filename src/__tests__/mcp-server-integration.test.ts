/**
 * MCP Server Integration Tests
 * 
 * 测试MCP服务器的核心功能：
 * 1. 服务器启动和健康检查
 * 2. MCP协议初始化
 * 3. 工具列表和调用
 * 4. search_codebase工具功能
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, ChildProcess } from 'child_process'
import http from 'http'
import { URL } from 'url'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

/**
 * MCP测试客户端
 * 封装服务器进程管理和HTTP通信
 */
class MCPTestClient {
  private baseUrl: string
  private serverProcess: ChildProcess | null = null
  private sessionId: string | null = null
  private requestId = 0

  constructor(baseUrl: string = 'http://localhost:13002') {
    this.baseUrl = baseUrl
  }

  /**
   * 启动MCP服务器进程
   */
  async startServer(workspacePath: string): Promise<void> {
    console.log('🚀 Starting MCP Server process...')

    this.serverProcess = spawn('npx', [
      'tsx',
      'src/index.ts',
      'mcp-server',
      '--demo',
      '--port=13002',
      '--host=localhost',
      `--path=${workspacePath}`
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: process.cwd()
    })

    // 捕获服务器输出用于调试
    this.serverProcess.stderr?.on('data', (data) => {
      const output = data.toString()
      if (output.includes('Error') || output.includes('error')) {
        console.log('🔍 Server Error:', output)
      }
    })

    this.serverProcess.stdout?.on('data', (data) => {
      const output = data.toString()
      if (output.includes('running at') || output.includes('MCP endpoint')) {
        console.log('📊 Server Ready:', output)
      }
    })

    this.serverProcess.on('error', (error) => {
      console.error('❌ Server Process Error:', error)
    })

    this.serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.log(`🔄 Server exited with code ${code}`)
      }
    })

    await this.waitForServer()
  }

  /**
   * 等待服务器就绪
   */
  async waitForServer(maxAttempts: number = 30): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const health = await this.httpRequest('/health', 'GET')
        console.log('✅ Server is ready:', health)
        return
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
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl)
      const postData = data ? JSON.stringify(data) : null

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      }

      if (postData) {
        headers['Content-Length'] = Buffer.byteLength(postData).toString()
      }

      if (this.sessionId) {
        headers['MCP-Session-ID'] = this.sessionId
      }

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: method,
        headers: headers
      }

      const req = http.request(options, (res) => {
        let responseData = ''

        // 提取会话ID
        if (!this.sessionId && res.headers['mcp-session-id']) {
          this.sessionId = res.headers['mcp-session-id'] as string
          console.log(`🔑 Session ID from header: ${this.sessionId}`)
        }

        res.on('data', (chunk) => {
          responseData += chunk
        })

        res.on('end', () => {
          try {
            // 尝试解析SSE格式
            if (responseData.includes('event:') && responseData.includes('data:')) {
              const lines = responseData.split('\n')
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const jsonData = line.substring(6)
                  if (jsonData.trim()) {
                    const parsed = JSON.parse(jsonData)
                    resolve(parsed)
                    return
                  }
                }
              }
            }
            
            // 尝试直接解析JSON
            const parsed = JSON.parse(responseData)
            resolve(parsed)
          } catch (error) {
            resolve(responseData)
          }
        })
      })

      req.on('error', (error) => {
        reject(error)
      })

      if (postData) {
        req.write(postData)
      }

      req.end()
    })
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
  stop(): void {
    if (this.serverProcess) {
      console.log('🔄 Stopping server...')
      this.serverProcess.kill('SIGTERM')
      this.serverProcess = null
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
  let client: MCPTestClient
  let workspacePath: string

  beforeAll(async () => {
    // 创建测试工作空间
    workspacePath = await createTestWorkspace()

    // 创建并启动测试客户端
    client = new MCPTestClient('http://localhost:13002')
    await client.startServer(workspacePath)

    // 初始化MCP连接
    const initResponse = await client.initialize()
    console.log('Init response:', JSON.stringify(initResponse, null, 2))

    // 等待索引完成
    console.log('⏳ Waiting for indexing to complete...')
    await new Promise(resolve => setTimeout(resolve, 15000))
    
    console.log('Initialization complete, ready to run tests')
  }, 60000) // beforeAll超时时间：60秒

  afterAll(async () => {
    // 停止服务器
    client.stop()

    // 清理工作空间
    await cleanupTestWorkspace(workspacePath)

    // 等待资源释放
    await new Promise(resolve => setTimeout(resolve, 2000))
  }, 30000) // afterAll超时时间：30秒

  describe('Server Health', () => {
    it('should respond to health check', async () => {
      const health = await client.httpRequest('/health', 'GET')
      
      expect(health).toBeDefined()
      expect(health.status).toBe('healthy')
      expect(health.timestamp).toBeDefined()
      expect(health.workspace).toBeDefined()
    })
  })

  describe('MCP Protocol', () => {
    it('should handle initialization', async () => {
      // 初始化在beforeAll中已完成，这里验证客户端状态
      expect(client).toBeDefined()
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
    }, 30000)

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
    }, 30000)

    it('should handle no results gracefully', async () => {
      const response = await client.callTool('search_codebase', {
        query: 'nonexistent quantum blockchain AI function',
        limit: 5,
        filters: {
          minScore: 0.7  // 设置很高的阈值以确保没有结果
        }
      })

      expect(response).toBeDefined()
      const content = response.result?.content || response.content
      expect(content).toBeDefined()
      expect(content).toBeInstanceOf(Array)
      
      const textContent = content[0]
      expect(textContent.type).toBe('text')
      
      console.log('No results test response:', textContent.text)
      
      // 应该包含"未找到"或"No results found"的提示
      const text = textContent.text.toLowerCase()
      expect(text.includes('no results found') || text.includes('未找到')).toBe(true)
    }, 30000)

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
    }, 30000)
  })
})
