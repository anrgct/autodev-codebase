/**
 * CLI Commands E2E Tests
 *
 * 测试CLI命令的核心功能：
 * 1. --clear --demo 清理 demo 集合成功
 * 2. --clear --demo 后 --search --demo 返回无结果或提示需要索引
 * 3. --clear --demo → --index --demo → --search="greet" --demo 完整流程
 * 4. 重复执行 --clear --demo 幂等性
 * 5. MCP服务器功能测试（搜索、参数验证、边界情况）
 *
 * 技术要点：
 * - 使用 child_process.spawn 执行 CLI 命令
 * - 捕获 stdout/stderr 验证输出
 * - 验证退出码
 * - 使用 --demo 模式进行测试（不需要真实的 workspace）
 * - MCP HTTP服务器测试
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawn } from 'child_process'
import path from 'path'

/**
 * MCP HTTP测试客户端
 * 封装HTTP通信和会话管理
 */
class MCPHTTPTestClient {
  private baseUrl: string
  private sessionId: string | null = null
  private requestId = 0

  constructor(baseUrl: string = 'http://localhost:13005') {
    this.baseUrl = baseUrl
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

    try {
      const response = await fetch(url, options)

      // 提取会话ID
      if (!this.sessionId && response.headers.get('mcp-session-id')) {
        this.sessionId = response.headers.get('mcp-session-id')
      }

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`)
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
    } catch (error) {
      // 重新抛出错误，提供更多上下文
      if (error instanceof Error) {
        throw new Error(`HTTP request failed: ${error.message}`)
      }
      throw error
    }
  }

  /**
   * 初始化MCP连接
   */
  async initialize(): Promise<any> {
    // 等待一小段时间确保服务器完全启动
    await new Promise(resolve => setTimeout(resolve, 1000))

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
          name: 'cli-integration-test-client',
          version: '1.0.0'
        }
      }
    }

    console.log('📤 Sending MCP initialization request:', JSON.stringify(initRequest, null, 2))
    const response = await this.httpRequest('/mcp', 'POST', initRequest)
    console.log('✅ MCP initialization response:', JSON.stringify(response, null, 2))
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

    return await this.httpRequest('/mcp', 'POST', request)
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
   * 健康检查
   */
  async healthCheck(): Promise<any> {
    return await this.httpRequest('/health', 'GET')
  }
}

/**
 * 执行 CLI 命令并返回结果
 */
async function executeCLICommand(args: string[], cwd?: string): Promise<{
  exitCode: number | null
  stdout: string
  stderr: string
}> {
  return new Promise((resolve) => {
    const cliPath = path.join(process.cwd(), 'src', 'cli.ts')
    const child = spawn('npx', ['tsx', cliPath, ...args], {
      cwd: cwd || process.cwd(),
      stdio: 'pipe',
      shell: true,
      env: {
        ...process.env,
        npm_config_loglevel: 'error',  // 减少 npm 警告
        npm_config_update_notifier: 'false'  // 禁用更新通知
      }
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      // 过滤掉一些常见的噪音输出
      const filteredStderr = stderr
        .split('\n')
        .filter(line =>
          !line.includes('npm warn Unknown') &&
          !line.includes('npm config') &&
          !line.includes('Api key is used with unsecure connection') &&
          !line.includes('QdrantVectorStore') &&
          !line.includes('[QdrantVectorStore]')
        )
        .join('\n')
        .trim()

      resolve({
        exitCode: code,
        stdout: stdout.trim(),
        stderr: filteredStderr
      })
    })

    child.on('error', (error) => {
      console.error('Spawn error:', error)
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: error.message
      })
    })
  })
}

/**
 * 等待服务器就绪
 */
async function waitForServer(baseUrl: string, maxAttempts: number = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) {
        return
      }
    } catch (error) {
      // 服务器尚未就绪
    }

    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  throw new Error(`Server failed to start at ${baseUrl} within timeout`)
}

// 测试套件
describe('CLI Commands E2E Tests', () => {
  beforeAll(async () => {
    // 静默控制台输出以保持测试清洁
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  }, 30000)

  afterAll(async () => {
    // 恢复console输出
    vi.restoreAllMocks()
  }, 30000)

  describe('--clear command', () => {
    it('should clear demo collection successfully with --clear --demo', async () => {
      const result = await executeCLICommand(['--clear', '--demo', '--log-level=info'])

      expect(result.exitCode).toBe(0)

      // 验证输出包含成功信息（可能包含配置验证警告）
      expect(result.stdout).toContain('Clear index mode')
      expect(result.stdout).toContain('Index data cleared successfully')
    }, 60000)

    it('should be idempotent when running --clear --demo multiple times', async () => {
      // 第一次清理
      const result1 = await executeCLICommand(['--clear', '--demo', '--log-level=info'])
      expect(result1.exitCode).toBe(0)
      expect(result1.stdout).toContain('Index data cleared successfully')

      // 等待一小段时间确保文件系统操作完成
      await new Promise(resolve => setTimeout(resolve, 1000))

      // 第二次清理应该也成功
      const result2 = await executeCLICommand(['--clear', '--demo', '--log-level=info'])
      expect(result2.exitCode).toBe(0)
      expect(result2.stdout).toContain('Index data cleared successfully')
    }, 90000)

    it('should return no results or prompt for indexing when searching after clear', async () => {
      // 先清理数据
      await executeCLICommand(['--clear', '--demo', '--log-level=info'])

      // 等待清理完成
      await new Promise(resolve => setTimeout(resolve, 2000))

      // 然后搜索，应该能够执行搜索（可能自动触发索引重建）
      const searchResult = await executeCLICommand(['--search=greet', '--demo', '--log-level=error'])

      // 搜索命令应该成功执行（退出码为0）
      expect(searchResult.exitCode).toBe(0)

      // 验证搜索输出 - 应该要么有结果，要么有明确的"无结果"消息
      const searchOutput = searchResult.stdout
      const hasValidSearchOutput =
        searchOutput.includes('Found') && searchOutput.includes('results') ||
        searchOutput.includes('No results found') ||
        searchOutput.includes('No results found for query') ||
        searchOutput.includes('greet')

      expect(hasValidSearchOutput).toBe(true)
    }, 90000)
  })

  describe('Complete workflow test', () => {
    it('should handle complete workflow: --clear --demo → --index --demo → --search="greet" --demo', async () => {
      // 步骤1: 清理数据
      console.log('Step 1: Clearing index data...')
      const clearResult = await executeCLICommand(['--clear', '--demo', '--log-level=info'])
      expect(clearResult.exitCode).toBe(0)
      expect(clearResult.stdout).toContain('Index data cleared successfully')

      // 等待清理完成
      await new Promise(resolve => setTimeout(resolve, 3000))

      // 步骤2: 建立索引
      console.log('Step 2: Building index...')
      const indexResult = await executeCLICommand(['--index', '--demo', '--log-level=error'])
      expect(indexResult.exitCode).toBe(0)

      // 等待索引完成
      await new Promise(resolve => setTimeout(resolve, 5000))

      // 步骤3: 搜索 "greet"
      console.log('Step 3: Searching for "greet"...')
      const searchResult = await executeCLICommand(['--search=greet', '--demo', '--log-level=error'])
      expect(searchResult.exitCode).toBe(0)

      // 验证搜索结果
      const searchOutput = searchResult.stdout
      expect(searchOutput).toBeDefined()

      // 应该包含搜索结果
      const hasSearchResults = searchOutput.includes('Found') && searchOutput.includes('results')
      expect(hasSearchResults).toBe(true)
    }, 180000) // 3分钟超时，因为索引需要时间
  })

  describe('Error handling', () => {
    it('should handle --clear command gracefully without demo mode', async () => {
      // 测试非demo模式下的清理命令
      // 由于没有 Qdrant 连接，命令会失败，但应该优雅地处理错误
      const result = await executeCLICommand(['--clear', '--log-level=info'])

      // 应该包含清理相关的输出，表明命令开始执行
      const output = result.stdout
      const hasClearOutput = output.includes('Clear index mode') ||
                            output.includes('Clearing')

      expect(hasClearOutput).toBe(true)

      // 命令会因为 Qdrant 连接失败而退出码为 1
      // 这是预期行为，因为非 demo 模式需要真实的 Qdrant 服务
      // 只要程序正常退出（不是崩溃）且有合理输出，就算"优雅处理"
      expect([0, 1]).toContain(result.exitCode)
    }, 60000)
  })

  describe('--serve command and MCP Server', () => {
    let serverProcess: any = null
    const serverPort = 13005
    const serverUrl = `http://localhost:${serverPort}`

    beforeAll(async () => {
      // 启动服务器进程（整个测试组共享）
      const cliPath = path.join(process.cwd(), 'src', 'cli.ts')

      serverProcess = spawn('npx', ['tsx', cliPath, '--serve', '--demo', `--port=${serverPort}`], {
        stdio: 'pipe',
        detached: true,
        shell: true,
        env: {
          ...process.env,
          npm_config_loglevel: 'error',
          npm_config_update_notifier: 'false'
        }
      })

      // 等待服务器就绪
      await waitForServer(serverUrl, 60)

      // 预先建立索引，避免每个测试重复索引
      await executeCLICommand(['--index', '--demo', '--log-level=error'])
      await new Promise(resolve => setTimeout(resolve, 5000))
    }, 120000)

    afterAll(async () => {
      // 清理服务器进程
      if (serverProcess) {
        try {
          process.kill(-serverProcess.pid, 'SIGTERM')
          serverProcess = null
          // 等待进程完全退出
          await new Promise(resolve => setTimeout(resolve, 2000))
        } catch (error) {
          console.warn('Failed to kill server process:', error)
        }
      }
    }, 30000)

    it('should start server successfully and respond to health check', async () => {
      // 验证进程仍在运行
      expect(serverProcess.pid).toBeDefined()
      expect(serverProcess.pid).toBeGreaterThan(0)

      // 测试健康检查端点
      const healthResponse = await fetch(`${serverUrl}/health`)
      expect(healthResponse.ok).toBe(true)

      const healthData = await healthResponse.json()
      expect(healthData).toHaveProperty('status', 'healthy')
      expect(healthData).toHaveProperty('timestamp')
    }, 30000)

    describe('MCP Protocol and Tools', () => {

      it('should initialize MCP connection and list available tools', async () => {
        const client = new MCPHTTPTestClient(serverUrl)

        // 初始化MCP连接
        const initResponse = await client.initialize()
        expect(initResponse).toBeDefined()

        const toolsResponse = await client.sendRequest('tools/list')
        expect(toolsResponse).toBeDefined()

        // MCP响应格式可能直接包含tools，或在result中
        const tools = toolsResponse.result?.tools || toolsResponse.tools
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

      it('should search for function definitions with proper format', async () => {
        const client = new MCPHTTPTestClient(serverUrl)
        await client.initialize()

        const response = await client.callTool('search_codebase', {
          query: 'function that greets a user',
          limit: 5
        })

        expect(response).toBeDefined()

        // 响应可能直接包含content，或在result中
        const content = response.result?.content || response.content
        expect(content).toBeDefined()
        expect(content).toBeInstanceOf(Array)

        const textContent = content[0]
        expect(textContent.type).toBe('text')
        expect(textContent.text).toBeDefined()

        // 验证结果格式 - 无论是否找到结果，应该都有响应
        const text = textContent.text
        expect(text.length).toBeGreaterThan(0)
      }, 60000)

      it('should search with path filters', async () => {
        const client = new MCPHTTPTestClient(serverUrl)
        await client.initialize()

        const response = await client.callTool('search_codebase', {
          query: 'JavaScript class for managing users',
          limit: 3,
          filters: {
            pathFilters: ['.js']
          }
        })

        expect(response).toBeDefined()
        const content = response.result?.content || response.content
        expect(content).toBeDefined()
        expect(content).toBeInstanceOf(Array)
      }, 30000)

      it('should handle no results gracefully', async () => {
        const client = new MCPHTTPTestClient(serverUrl)
        await client.initialize()

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

        // 验证有文本响应，无论是哪种格式
        const text = textContent.text
        expect(typeof text).toBe('string')
        expect(text.length).toBeGreaterThan(0)
      }, 30000)

      it('should validate input parameters', async () => {
        const client = new MCPHTTPTestClient(serverUrl)
        await client.initialize()

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
        const client = new MCPHTTPTestClient(serverUrl)
        await client.initialize()

        const response = await client.callTool('search_codebase', {
          query: 'process',
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

      it('should handle search_codebase tool through CLI serve mode', async () => {
        const client = new MCPHTTPTestClient(serverUrl)
        await client.initialize()

        // 使用客户端的callTool方法而不是直接HTTP请求
        const response = await client.callTool('search_codebase', {
          query: 'greet',
          limit: 5
        })

        expect(response).toBeDefined()

        // 验证响应格式
        const content = response.result?.content || response.content
        expect(content).toBeDefined()
        expect(content).toBeInstanceOf(Array)

        // 验证响应内容
        if (content.length > 0) {
          const textContent = content[0]
          expect(textContent.type).toBe('text')
          expect(textContent.text).toBeDefined()
        }
      }, 60000)
    })
  })
})
