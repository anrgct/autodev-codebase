/// <reference types="vitest" />
import Parser from 'web-tree-sitter'
import * as path from 'path'
import { TypeScriptAnalyzer } from '../analyzers/typescript'
import { PythonAnalyzer } from '../analyzers/python'
import { GoAnalyzer } from '../analyzers/go'
import { CAnalyzer } from '../analyzers/c'
import { ParseOutput } from '../models'

// Initialize tree-sitter before tests
async function initializeTreeSitter() {
  await Parser.init()
}

const testFilePath = '/mock-project/src/main.ts'
const testRepoPath = '/mock-project'

// Test helper function to analyze code
async function analyze(
  code: string,
  language: 'typescript' | 'javascript' | 'python' | 'go' | 'c' | 'cpp' | 'rust'
): Promise<ParseOutput> {
  let analyzer

  switch (language) {
    case 'typescript':
    case 'javascript': {
      const parser = new Parser()
      const wasmPath = path.join(process.cwd(), 'dist/tree-sitter/tree-sitter-javascript.wasm')
      const lang = await Parser.Language.load(wasmPath)
      parser.setLanguage(lang)
      analyzer = new TypeScriptAnalyzer(testFilePath, code, testRepoPath, parser)
      break
    }
    case 'python': {
      const parser = new Parser()
      const wasmPath = path.join(process.cwd(), 'dist/tree-sitter/tree-sitter-python.wasm')
      const lang = await Parser.Language.load(wasmPath)
      parser.setLanguage(lang)
      analyzer = new PythonAnalyzer(testFilePath, code, testRepoPath, parser)
      break
    }
    case 'go': {
      const parser = new Parser()
      const wasmPath = path.join(process.cwd(), 'dist/tree-sitter/tree-sitter-go.wasm')
      const lang = await Parser.Language.load(wasmPath)
      parser.setLanguage(lang)
      analyzer = new GoAnalyzer(testFilePath, code, testRepoPath, parser)
      break
    }
    case 'c':
    case 'cpp': {
      const parser = new Parser()
      const wasmPath = path.join(process.cwd(), 'dist/tree-sitter/tree-sitter-c.wasm')
      const lang = await Parser.Language.load(wasmPath)
      parser.setLanguage(lang)
      analyzer = new CAnalyzer(testFilePath, code, testRepoPath, parser)
      break
    }
    default:
      throw new Error(`Unsupported language: ${language}`)
  }

  return await analyzer.analyze()
}

// Helper function to check if edges contain a callee
expect.extend({
  toContainCallee(received: any[], calleeName: string) {
    const pass = received.some(edge => edge.callee === calleeName)
    if (pass) {
      return {
        message: () => `expected edges not to contain callee "${calleeName}"`,
        pass: true,
      }
    } else {
      return {
        message: () => `expected edges to contain callee "${calleeName}"`,
        pass: false,
      }
    }
  },
  notToContainCallee(received: any[], calleeName: string) {
    const pass = !received.some(edge => edge.callee === calleeName)
    if (pass) {
      return {
        message: () => `expected edges to not contain callee "${calleeName}"`,
        pass: true,
      }
    } else {
      return {
        message: () => `expected edges not to contain callee "${calleeName}"`,
        pass: false,
      }
    }
  },
})

describe('Built-in filtering', () => {
  beforeAll(async () => {
    await initializeTreeSitter()
  })

  describe('TypeScriptAnalyzer builtin filtering', () => {
    it('should filter global builtin calls', async () => {
      const code = `
        function testFunction() {
          setTimeout(() => {}, 1000)
          parseInt("123")
          fetch("/api")
          isNaN(value)
          myCustomFunction()
        }
      `
      const result = await analyze(code, 'typescript')

      // Verify builtins are filtered
      expect(result.edges).notToContainCallee('setTimeout')
      expect(result.edges).notToContainCallee('parseInt')
      expect(result.edges).notToContainCallee('fetch')
      expect(result.edges).notToContainCallee('isNaN')

      // Verify business function is NOT filtered
      expect(result.edges).toContainCallee('myCustomFunction')
    })

    it('should resolve namespace member calls correctly', async () => {
      // Test that namespace.member() calls are resolved to full paths
      const code = `
        import * as myModule from './utils/myModule'
        import * as helper from './utils/helper'

        export function main() {
          myModule.formatDate(new Date())
          helper.formatDate(new Date())
        }
      `
      const result = await analyze(code, 'typescript')

      // Verify namespace member calls are resolved to full paths
      // The edges should contain the resolved full paths, not just "myModule.formatDate"
      const myModuleEdge = result.edges.find(e =>
        e.callee && e.callee.includes('myModule.formatDate')
      )
      const helperEdge = result.edges.find(e =>
        e.callee && e.callee.includes('helper.formatDate')
      )

      // At minimum, the callee should NOT be the raw namespace format
      // It should be either resolved to full path or have confidence < 1.0
      if (myModuleEdge) {
        expect(myModuleEdge.callee).not.toBe('myModule.formatDate')
      }
      if (helperEdge) {
        expect(helperEdge.callee).not.toBe('helper.formatDate')
      }
    })

    it('should filter member builtin calls', async () => {
      const code = `
        function testFunction() {
          console.log("hello")
          JSON.parse(str)
          Math.floor(1.5)
          Object.keys(obj)
          myLogger.log("msg")
        }
      `
      const result = await analyze(code, 'typescript')
      // Verify member builtins are filtered
      expect(result.edges).notToContainCallee('console.log')
      expect(result.edges).notToContainCallee('JSON.parse')
      expect(result.edges).notToContainCallee('Math.floor')
      expect(result.edges).notToContainCallee('Object.keys')

      // Verify business function is NOT filtered
      expect(result.edges).toContainCallee('myLogger.log')
    })

    it('should NOT filter instance methods', async () => {
      const code = `
        function testFunction() {
          users.map(fn)
          promise.then(fn)
          str.split(',')
        }
      `
      const result = await analyze(code, 'typescript')

      // Instance methods should NOT be filtered (they are stored with full path)
      expect(result.edges).toContainCallee('users.map')
      expect(result.edges).toContainCallee('promise.then')
      expect(result.edges).toContainCallee('str.split')
    })

    it('should filter constructor calls', async () => {
      const code = `
        function testFunction() {
          new Promise((resolve) => {})
          new Map()
          new Error("test")
          myCustomClass()
        }
      `
      const result = await analyze(code, 'typescript')

      // Constructor builtins should be filtered
      expect(result.edges).notToContainCallee('Promise')
      expect(result.edges).notToContainCallee('Map')
      expect(result.edges).notToContainCallee('Error')

      // Custom constructor should NOT be filtered
      expect(result.edges).toContainCallee('myCustomClass')
    })
  })

  describe('PythonAnalyzer builtin filtering', () => {
    it('should filter Python builtins', async () => {
      const code = `
        def test_function():
          print(value)
          len(items)
          range(10)
          isinstance(x, str)
          my_func()
      `
      const result = await analyze(code, 'python')

      // Verify builtins are filtered
      expect(result.edges).notToContainCallee('print')
      expect(result.edges).notToContainCallee('len')
      expect(result.edges).notToContainCallee('range')
      expect(result.edges).notToContainCallee('isinstance')

      // Verify business function is NOT filtered
      expect(result.edges).toContainCallee('my_func')
    })

    it('should filter Python type constructors', async () => {
      const code = `
        def test_function():
          str(123)
          int("456")
          list([1, 2, 3])
          dict(a=1)
          MyClass()
      `
      const result = await analyze(code, 'python')

      // Verify type constructors are filtered
      expect(result.edges).notToContainCallee('str')
      expect(result.edges).notToContainCallee('int')
      expect(result.edges).notToContainCallee('list')
      expect(result.edges).notToContainCallee('dict')

      // Verify custom class is NOT filtered
      expect(result.edges).toContainCallee('MyClass')
    })

    it('should filter Python functional builtins', async () => {
      const code = `
        def test_function():
          map(lambda x: x * 2, items)
          filter(lambda x: x > 0, items)
          sorted(items)
          max(items)
          my_map_func()
      `
      const result = await analyze(code, 'python')

      // Verify functional builtins are filtered
      expect(result.edges).notToContainCallee('map')
      expect(result.edges).notToContainCallee('filter')
      expect(result.edges).notToContainCallee('sorted')
      expect(result.edges).notToContainCallee('max')

      // Verify business function is NOT filtered
      expect(result.edges).toContainCallee('my_map_func')
    })
  })

  describe('GoAnalyzer builtin filtering', () => {
    it('should filter Go builtins', async () => {
      const code = `
        func testFunction() {
          append(slice, element)
          len(slice)
          make(chan int)
          myFunction()
        }
      `
      const result = await analyze(code, 'go')

      // Verify builtins are filtered
      expect(result.edges).notToContainCallee('append')
      expect(result.edges).notToContainCallee('len')
      expect(result.edges).notToContainCallee('make')

      // Verify business function is NOT filtered
      expect(result.edges).toContainCallee('myFunction')
    })

    it('should filter Go panic/recover builtins', async () => {
      const code = `
        func testFunction() {
          panic("error")
          recover()
          myCustomFunc()
        }
      `
      const result = await analyze(code, 'go')

      // Verify panic/recover are filtered
      expect(result.edges).notToContainCallee('panic')
      expect(result.edges).notToContainCallee('recover')

      // Verify business function is NOT filtered
      expect(result.edges).toContainCallee('myCustomFunc')
    })
  })

  describe('CAnalyzer builtin filtering', () => {
    it('should filter C standard library functions', async () => {
      const code = `
        void test_function() {
          printf("hello");
          malloc(size);
          strlen(str);
          my_function();
        }
      `
      const result = await analyze(code, 'c')

      // Verify standard library functions are filtered
      expect(result.edges).notToContainCallee('printf')
      expect(result.edges).notToContainCallee('malloc')
      expect(result.edges).notToContainCallee('strlen')

      // Verify business function is NOT filtered
      expect(result.edges).toContainCallee('my_function')
    })

    it('should filter C string and memory functions', async () => {
      const code = `
        void test_function() {
          strcpy(dest, src);
          strcmp(str1, str2);
          memcpy(dest, src, n);
          my_str_func();
        }
      `
      const result = await analyze(code, 'c')

      // Verify string/memory functions are filtered
      expect(result.edges).notToContainCallee('strcpy')
      expect(result.edges).notToContainCallee('strcmp')
      expect(result.edges).notToContainCallee('memcpy')

      // Verify business function is NOT filtered
      expect(result.edges).toContainCallee('my_str_func')
    })

    it('should filter C math functions', async () => {
      const code = `
        void test_function() {
          pow(2, 3);
          sqrt(4);
          sin(angle);
          my_math_func();
        }
      `
      const result = await analyze(code, 'c')

      // Verify math functions are filtered
      expect(result.edges).notToContainCallee('pow')
      expect(result.edges).notToContainCallee('sqrt')
      expect(result.edges).notToContainCallee('sin')

      // Verify business function is NOT filtered
      expect(result.edges).toContainCallee('my_math_func')
    })
  })

  describe('Mixed builtin and business functions', () => {
    it('should correctly filter only builtins in complex code', async () => {
      const code = `
        function complexFunction() {
          console.log("start")
          fetch("/api")
            .then(response => response.json())
            .then(data => {
              JSON.parse(data)
              myCustomParser(data)
            })
          console.error("end")
        }
      `
      const result = await analyze(code, 'typescript')

      // Verify builtins are filtered
      expect(result.edges).notToContainCallee('console.log')
      expect(result.edges).notToContainCallee('console.error')
      expect(result.edges).notToContainCallee('fetch')
      expect(result.edges).notToContainCallee('JSON.parse')

      // Verify business functions are NOT filtered
      expect(result.edges).toContainCallee('myCustomParser')
    })
  })

  /**
   * Namespace Member Call Resolution Test Suite
   *
   * This test suite reproduces and documents the namespace member call resolution issue
   * described in tasks/260112-namespace-member-call-resolution.md
   *
   * **Problem Scenario:**
   * When code uses namespace imports (import * as ns from './module'), calls to namespace
   * members (ns.memberFunction()) may not be resolved correctly when multiple functions
   * with the same name exist across different modules.
   *
   * **Example Issue:**
   * ```typescript
   * // src/main.ts
   * import * as myModule from './utils/myModule'
   *
   * myModule.formatDate(new Date())  // Should resolve to src/utils/myModule.formatDate
   *
   * // But when there's also:
   * // src/utils/helper.ts
   * export function formatDate(date: Date) { ... }
   *
   * // Current implementation may incorrectly resolve due to heuristic distance matching
   * ```
   *
   * **Current Implementation Status:**
   * - ✅ Single-level namespace calls (utils.formatDate) are correctly preserved
   * - ⚠️  Multi-level nested calls (api.client.fetch) only capture last level
   * - ⚠️  Resolution relies on heuristic module distance when multiple candidates exist
   *
   * **See Also:**
   * - tasks/260112-namespace-member-call-resolution.md for detailed analysis
   * - Proposed Solution 1: Enhanced importMap with namespace member tracking
   */
  describe('Namespace member call resolution', () => {
    it('should correctly resolve myModule.formatDate() to src/utils/myModule.formatDate (canonical scenario)', async () => {
      /**
       * Namespace member call resolution - 典型场景测试
       *
       * 测试文档 tasks/260112-namespace-member-call-resolution.md 中的典型场景：
       *
       * 典型场景：
       * ```typescript
       * // src/main.ts
       * import * as myModule from './utils/myModule'
       *
       * export function main() {
       *   myModule.formatDate(new Date())  // ← 成员调用
       * }
       *
       * // src/utils/myModule.ts
       * export function formatDate(date: Date) {
       *   return date.toISOString()
       * }
       *
       * // src/utils/helper.ts
       * export function formatDate(date: Date) {  // ← 同名函数
       *   return date.toLocaleDateString()
       * }
       * ```
       *
       * 问题：如何确保 `myModule.formatDate()` 被正确解析为 `src/utils/myModule.formatDate`，
       * 而不是 `src/utils/helper.formatDate`？
       */
      const code = `
        import * as myModule from './utils/myModule'

        export function main() {
          myModule.formatDate(new Date())
        }
      `
      const result = await analyze(code, 'typescript')

      // 查找包含 myModule.formatDate 的边
      const edge = result.edges.find(e =>
        e.callee?.includes('myModule') && e.callee?.includes('formatDate')
      )

      // 验证：应该被精确解析为 src/utils/myModule.formatDate
      expect(edge).toBeDefined()
      expect(edge?.callee).toBe('src/utils/myModule.formatDate')

      // 验证：confidence 应该是 1.0（表示精确解析，不是模糊匹配）
      expect(edge?.confidence).toBe(1.0)

      // 验证：不应该被解析为 src/utils/helper.formatDate
      expect(edge?.callee).not.toBe('src/utils/helper.formatDate')
    })

    it('should resolve namespace member calls to full paths', async () => {
      const code = `
        import * as myModule from './utils/myModule'
        import * as helper from './utils/helper'

        export function main() {
          // Namespace member calls - should resolve to full paths
          myModule.formatDate(new Date())
          helper.formatDate(new Date())

          // Regular calls
          directFunction()
        }

        function directFunction() {
          console.log('direct')
        }
      `
      const result = await analyze(code, 'typescript')
      // Verify namespace member calls are resolved to full paths
      // The resolved path depends on the current file's relative path
      const myModuleEdge = result.edges.find(e => e.callee && e.callee.includes('myModule.formatDate'))
      const helperEdge = result.edges.find(e => e.callee && e.callee.includes('helper.formatDate'))

      // Should NOT contain the raw namespace format anymore
      expect(myModuleEdge).toBeDefined()
      expect(myModuleEdge?.callee).not.toBe('myModule.formatDate')
      expect(helperEdge).toBeDefined()
      expect(helperEdge?.callee).not.toBe('helper.formatDate')

      // Verify regular calls are not affected
      expect(result.edges).toContainCallee('directFunction')
    })

    it('should distinguish between different namespace members with same name', async () => {
      const code = `
        import * as utils from './utils/test/fun'
        import * as helpers from './helpers'
        import * as services from './services'

        export function process() {
          // Multiple namespaces with same member name
          utils.formatDate(new Date())
          helpers.formatDate(new Date())
          services.formatDate(new Date())

          // Different members from same namespace
          utils.parseData(str)
          utils.validateInput(obj)
        }
      `
      const result = await analyze(code, 'typescript')
      // Each namespace.member combination should be resolved to full module paths
      expect(result.edges).toContainCallee('src/utils/test/fun.formatDate')
      expect(result.edges).toContainCallee('src/helpers.formatDate')
      expect(result.edges).toContainCallee('src/services.formatDate')
      expect(result.edges).toContainCallee('src/utils/test/fun.parseData')
      expect(result.edges).toContainCallee('src/utils/test/fun.validateInput')
    })

    it('should correctly extract full path from nested member access', async () => {
      const code = `
        import * as api from './api'
        import * as config from './config'

        export function initialize() {
          // Nested member access (3+ levels)
          api.client.fetch('/data')
          api.client.post('/submit')
          config.settings.get('timeout')
          config.logger.info('starting')

          // Single-level member access (works correctly)
          api.init()

          // Regular calls
          setup()
        }

        function setup() {
          api.init()
        }
      `
      const result = await analyze(code, 'typescript')

      // Nested member calls now correctly extract full paths
      expect(result.edges).toContainCallee('src/api.client.fetch')
      expect(result.edges).toContainCallee('src/api.client.post')
      expect(result.edges).toContainCallee('src/config.settings.get')
      expect(result.edges).toContainCallee('src/config.logger.info')

      // Single-level namespace calls are still fully resolved
      expect(result.edges).toContainCallee('src/api.init')

      // Regular calls work normally
      expect(result.edges).toContainCallee('setup')
    })

    it('should handle edge cases for member expression', async () => {
      const code = `
        import * as utils from './utils'
        
        export function testDeepNesting() {
          // Edge case: deep nesting (4 levels)
          utils.a.b.c.d()
        }
        
        export function testParenthesized() {
          // Edge case: parenthesized expression
          (utils.helper).process()
        }
        
        export function testMixed() {
          // Mixed scenario
          utils.config.get('key')
        }
      `
      const result = await analyze(code, 'typescript')
      
      // Deep nesting should be correctly extracted
      expect(result.edges).toContainCallee('src/utils.a.b.c.d')
      
      // Parenthesized expressions should be handled correctly
      expect(result.edges).toContainCallee('src/utils.helper.process')
      
      // Mixed scenario works normally
      expect(result.edges).toContainCallee('src/utils.config.get')
    })

    it('should handle nested parentheses and complex edge cases', async () => {
      const code = `
        import * as utils from './utils'
        
        export function testNestedParentheses() {
          // Edge case: multiple levels of parentheses
          ((utils.helper)).process()
        }
      
        export function testNestedInParens() {
          // Edge case: nested member access inside parentheses
          (utils.a.b).c.d()
        }
        `
        const result = await analyze(code, 'typescript')
      
        // Multiple parentheses should be handled correctly
        expect(result.edges).toContainCallee('src/utils.helper.process')
      
        // Nested access inside parentheses
        expect(result.edges).toContainCallee('src/utils.a.b.c.d')
      
        // KNOWN LIMITATION: The following pattern is not yet supported:
        // ((utils.config).get)('key') - parentheses around the entire member expression before call
        // This is because Tree-sitter parses it differently when the entire expression is wrapped in parentheses
        // before the function call. This could be addressed in future enhancements if needed.
      })

    it('should document current behavior: direct imports get module prefix', async () => {
      // Current behavior: Direct named imports are resolved with repo-relative module path
      // This happens because importMap stores the module path and resolveModulePath() normalizes it
      //
      // Actual behavior:
      // - import { directFunction } from './direct'
      // - directFunction() → callee: 'src/direct.directFunction' (repo-relative path)
      //
      // Note: This ensures consistent path resolution across all import types

      const code = `
        import * as utils from './utils'
        import { directFunction } from './direct'

        export function main() {
          // Namespace import (resolved to full module path)
          utils.helper()

          // Direct named import (gets module prefix from importMap)
          directFunction()

          // Both calling same-named functions from different sources
          utils.formatDate(new Date())
          formatDate(new Date()) // Assume this is imported elsewhere
        }
      `
      const result = await analyze(code, 'typescript')

      // Namespace member calls are now resolved to full module paths
      expect(result.edges).toContainCallee('src/utils.helper')
      expect(result.edges).toContainCallee('src/utils.formatDate')

      // Direct named import behavior (resolved to repo-relative path)
      expect(result.edges).toContainCallee('src/direct.directFunction')

      // Unresolved calls preserve simple name
      expect(result.edges).toContainCallee('formatDate')
    })
  })
})
