/// <reference types="vitest" />
import { describe, it, expect, beforeAll } from 'vitest'
import Parser from 'web-tree-sitter'
import * as path from 'path'
import { TypeScriptAnalyzer } from '../analyzers/typescript'
import { ParseOutput } from '../models'

// Initialize tree-sitter before tests
async function initializeTreeSitter() {
  await Parser.init()
}

const testFilePath = '/mock-project/src/adapters/nodejs/config.ts'
const testRepoPath = '/mock-project'

async function analyzeTypeScript(code: string): Promise<ParseOutput> {
  const parser = new Parser()
  const wasmPath = path.join(process.cwd(), 'dist/tree-sitter/tree-sitter-javascript.wasm')
  const lang = await Parser.Language.load(wasmPath)
  parser.setLanguage(lang)
  
  const analyzer = new TypeScriptAnalyzer(testFilePath, code, testRepoPath, parser)
  return analyzer.analyze()
}

beforeAll(async () => {
  await initializeTreeSitter()
})

describe('Module Path Resolution', () => {
  it('should resolve relative import paths to repo-relative paths', async () => {
    const code = `
import { saveJsonc } from '../../utils/jsonc-helpers'

export class ConfigProvider {
  async saveConfig() {
    saveJsonc()
  }
}
`
    const result = await analyzeTypeScript(code)
    
    // 查找 saveJsonc 的调用
    const saveJsoncCall = result.edges.find(
      rel => rel.callee.includes('saveJsonc')
    )
    
    expect(saveJsoncCall).toBeDefined()
    
    // 验证路径已被解析（不应包含 ../..）
    expect(saveJsoncCall?.callee).not.toContain('../..')
    
    // 应该是 repo 相对路径
    expect(saveJsoncCall?.callee).toContain('utils/jsonc-helpers')
  })

  it('should handle member calls with import resolution', async () => {
    const code = `
import * as fs from 'fs'

export class FileHandler {
  async readFile() {
    const data = fs.readFile('test.txt')
    return data
  }
}
`
    const result = await analyzeTypeScript(code)
    
    // 查找 fs.readFile 的调用
    const fsCall = result.edges.find(
      rel => rel.callee.includes('readFile')
    )
    
    expect(fsCall).toBeDefined()
    
    // fs 是 npm 包，应该保持为 fs.readFile
    expect(fsCall?.callee).toBe('fs.readFile')
  })

  it('should handle new expression chaining', async () => {
    const code = `
export class DataProcessor {
  async processData() {
    const text = new TextDecoder().decode(buffer)
    return text
  }
}
`
    const result = await analyzeTypeScript(code)
    
    // 查找 decode 的调用
    const decodeCall = result.edges.find(
      rel => rel.callee.includes('decode')
    )
    
    expect(decodeCall).toBeDefined()
    
    // 应该是 TextDecoder.decode，不应该以 . 开头
    expect(decodeCall?.callee).not.toMatch(/^\./)
    expect(decodeCall?.callee).toContain('TextDecoder')
  })
})
