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

const testFilePath = '/test/test.ts'
const testRepoPath = '/test'

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
})
