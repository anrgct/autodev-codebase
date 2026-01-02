import { describe, it, expect } from 'vitest'
import { generateBlockEmbeddingText } from '../block-text-generator'
import { CodeBlock } from '../../interfaces'

describe('generateBlockEmbeddingText', () => {
  it('should include file path', () => {
    const block: CodeBlock = {
      file_path: '/Users/test/project/src/auth/AuthService.ts',
      identifier: 'login',
      type: 'function_definition',
      parentChain: [],
      content: 'function login() {}',
      start_line: 1,
      end_line: 1,
      fileHash: 'abc123',
      segmentHash: 'def456',
      chunkSource: 'tree-sitter',
      hierarchyDisplay: null
    }

    const result = generateBlockEmbeddingText(block, '/Users/test/project')
    expect(result).toContain('File: src/auth/AuthService.ts')
    expect(result).toContain('Name: [function_definition]login')
  })

  it('should include parent container information', () => {
    const block: CodeBlock = {
      file_path: '/Users/test/project/src/auth/AuthService.ts',
      identifier: 'login',
      type: 'method_definition',
      parentChain: [
        { identifier: 'AuthService', type: 'class_declaration' }
      ],
      content: 'login() {}',
      start_line: 10,
      end_line: 10,
      fileHash: 'abc123',
      segmentHash: 'def456',
      chunkSource: 'tree-sitter',
      hierarchyDisplay: null
    }

    const result = generateBlockEmbeddingText(block, '/Users/test/project')
    expect(result).toContain('Parent: [class_declaration]AuthService')
  })

  it('should handle multi-level parent containers', () => {
    const block: CodeBlock = {
      file_path: '/Users/test/project/src/utils/database/helpers.ts',
      identifier: 'connect',
      type: 'function_definition',
      parentChain: [
        { identifier: 'DatabaseManager', type: 'class_declaration' },
        { identifier: 'ConnectionPool', type: 'class_declaration' }
      ],
      content: 'function connect() {}',
      start_line: 25,
      end_line: 25,
      fileHash: 'abc123',
      segmentHash: 'def456',
      chunkSource: 'tree-sitter',
      hierarchyDisplay: null
    }

    const result = generateBlockEmbeddingText(block, '/Users/test/project')
    expect(result).toContain('Parent: [class_declaration]DatabaseManager.[class_declaration]ConnectionPool')
  })

  it('should filter null identifiers in parent chain', () => {
    const block: CodeBlock = {
      file_path: '/Users/test/project/src/components/Button.tsx',
      identifier: 'render',
      type: 'function_definition',
      parentChain: [
        { identifier: 'Button', type: 'class_declaration' },
        { identifier: null, type: 'block' },
        { identifier: 'React', type: 'program' }
      ],
      content: 'render() { return <button /> }',
      start_line: 15,
      end_line: 15,
      fileHash: 'abc123',
      segmentHash: 'def456',
      chunkSource: 'tree-sitter',
      hierarchyDisplay: null
    }

    const result = generateBlockEmbeddingText(block, '/Users/test/project')
    expect(result).toContain('Parent: [class_declaration]Button.[program]React')
    expect(result).not.toContain('..')
  })

  it('should handle code blocks without identifier', () => {
    const block: CodeBlock = {
      file_path: '/Users/test/project/src/utils/index.ts',
      identifier: null,
      type: 'export_statement',
      parentChain: [],
      content: 'export { foo } from "./foo"',
      start_line: 1,
      end_line: 1,
      fileHash: 'abc123',
      segmentHash: 'def456',
      chunkSource: 'tree-sitter',
      hierarchyDisplay: null
    }

    const result = generateBlockEmbeddingText(block, '/Users/test/project')
    expect(result).toContain('File: src/utils/index.ts')
    expect(result).not.toContain('Name:')
  })

  it('should handle empty parent chain', () => {
    const block: CodeBlock = {
      file_path: '/Users/test/project/src/index.ts',
      identifier: 'main',
      type: 'function_definition',
      parentChain: [],
      content: 'function main() { console.log("Hello") }',
      start_line: 1,
      end_line: 1,
      fileHash: 'abc123',
      segmentHash: 'def456',
      chunkSource: 'tree-sitter',
      hierarchyDisplay: null
    }

    const result = generateBlockEmbeddingText(block, '/Users/test/project')
    expect(result).toContain('File: src/index.ts')
    expect(result).toContain('Name: [function_definition]main')
    expect(result).not.toContain('Parent:')
  })

  it('should correctly combine context and code content', () => {
    const block: CodeBlock = {
      file_path: '/Users/test/project/src/auth/AuthService.ts',
      identifier: 'login',
      type: 'function_definition',
      parentChain: [
        { identifier: 'AuthService', type: 'class_declaration' }
      ],
      content: 'function login(username, password) {\n  const user = await db.findUser(username)\n  return verifyPassword(user, password)\n}',
      start_line: 10,
      end_line: 13,
      fileHash: 'abc123',
      segmentHash: 'def456',
      chunkSource: 'tree-sitter',
      hierarchyDisplay: null
    }

    const result = generateBlockEmbeddingText(block, '/Users/test/project')

    // Check context part
    expect(result).toContain('File: src/auth/AuthService.ts')
    expect(result).toContain('Name: [function_definition]login')
    expect(result).toContain('Parent: [class_declaration]AuthService')

    // Check code content
    expect(result).toContain('function login(username, password)')
    expect(result).toContain('const user = await db.findUser(username)')

    // Check format (should have double newline between context and code)
    expect(result).toMatch(/Parent: \[class_declaration\]AuthService\n\nfunction login/)
  })
})
