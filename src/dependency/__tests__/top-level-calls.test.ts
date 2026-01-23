/// <reference types="vitest" />
import Parser from 'web-tree-sitter'
import * as path from 'path'
import { TypeScriptAnalyzer } from '../analyzers/typescript'
import { ParseOutput } from '../models'
import { resolveWasmPath } from '../../tree-sitter/wasm-loader'

// Initialize tree-sitter before tests
async function initializeTreeSitter() {
  await Parser.init()
}

const testFilePath = '/mock-project/src/app.js'
const testRepoPath = '/mock-project'

// Test helper function to analyze JavaScript/TypeScript code
async function analyze(code: string): Promise<ParseOutput> {
  const parser = new Parser()
  const wasmPath = resolveWasmPath('tree-sitter-javascript.wasm')
  const lang = await Parser.Language.load(wasmPath)
  parser.setLanguage(lang)
  const analyzer = new TypeScriptAnalyzer(testFilePath, code, testRepoPath, parser)
  return await analyzer.analyze()
}

describe('Top-level calls tracking', () => {
  beforeAll(async () => {
    await initializeTreeSitter()
  })

  describe('Module node creation', () => {
    it('should create module node WITH edges when there are top-level calls', async () => {
      const code = `
        const { greetUser } = require('./hello');
        greetUser('Alice');  // Top-level call
      `
      const result = await analyze(code)

      // Verify module node exists
      const moduleNode = result.nodes.find(node => node.componentType === 'module')
      expect(moduleNode).toBeDefined()
      expect(moduleNode?.componentType).toBe('module')
      expect(moduleNode?.name).toBe('app')  // Name without extension for consistency
      expect(moduleNode?.id).toBe('src/app')
      expect(moduleNode?.startLine).toBe(1)
      
      // Verify module node has edges (has dependencies)
      const moduleEdges = result.edges.filter(edge => edge.caller === moduleNode?.id)
      expect(moduleEdges.length).toBeGreaterThan(0)
      
      // Verify the edge points to greetUser
      const greetUserEdge = moduleEdges.find(edge => edge.callee.includes('greetUser'))
      expect(greetUserEdge).toBeDefined()
    })

    it('should NOT create module node when there are no top-level calls', async () => {
      const code = `
        function main() {
          console.log('test');
        }
      `
      const result = await analyze(code)

      // Module node should NOT be created (no top-level calls)
      const moduleNode = result.nodes.find(node => node.componentType === 'module')
      expect(moduleNode).toBeUndefined()
      
      // Only the function node should exist
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0].componentType).toBe('function')
      expect(result.nodes[0].name).toBe('main')
      
      // No edges at all (console.log is filtered)
      expect(result.edges.length).toBe(0)
    })

    it('should NOT create module node for files with no calls at all', async () => {
      const code = `
        const x = 1;
        const y = 2;
      `
      const result = await analyze(code)

      // Module node should NOT be created (no calls at all)
      const moduleNode = result.nodes.find(node => node.componentType === 'module')
      expect(moduleNode).toBeUndefined()

      // Should have no nodes and no edges
      expect(result.nodes.length).toBe(0)
      expect(result.edges.length).toBe(0)
    })
  })

  describe('Top-level function calls', () => {
    it('should track top-level function calls', async () => {
      const code = `
        const { greetUser } = require('./hello');
        greetUser('Alice');  // Top-level call
      `
      const result = await analyze(code)

      // Find the module node
      const moduleNode = result.nodes.find(node => node.componentType === 'module')
      expect(moduleNode).toBeDefined()

      // Find edges from module node
      const moduleEdges = result.edges.filter(edge => edge.caller === moduleNode?.id)
      expect(moduleEdges.length).toBeGreaterThan(0)

      // Verify the edge points to greetUser
      const greetUserEdge = moduleEdges.find(edge => edge.callee.includes('greetUser'))
      expect(greetUserEdge).toBeDefined()
    })

    it('should track multiple top-level calls', async () => {
      const code = `
        const { greetUser, UserManager } = require('./hello');
        
        const userManager = new UserManager();
        const greeting = greetUser('Alice');
        userManager.addUser({ name: 'Alice', email: 'alice@example.com' });
        const allUsers = userManager.getUsers();
      `
      const result = await analyze(code)

      const moduleNode = result.nodes.find(node => node.componentType === 'module')
      expect(moduleNode).toBeDefined()

      const moduleEdges = result.edges.filter(edge => edge.caller === moduleNode?.id)
      
      // Should track UserManager, greetUser, addUser, getUsers
      expect(moduleEdges.length).toBeGreaterThanOrEqual(4)

      // Verify specific calls
      const hasGreetUser = moduleEdges.some(e => e.callee.includes('greetUser'))
      const hasUserManager = moduleEdges.some(e => e.callee.includes('UserManager'))
      const hasAddUser = moduleEdges.some(e => e.callee.includes('addUser'))
      const hasGetUsers = moduleEdges.some(e => e.callee.includes('getUsers'))

      expect(hasGreetUser).toBe(true)
      expect(hasUserManager).toBe(true)
      expect(hasAddUser).toBe(true)
      expect(hasGetUsers).toBe(true)
    })

    it('should differentiate between top-level calls and function calls', async () => {
      const code = `
        const { greetUser } = require('./hello');
        
        greetUser('Alice');  // Top-level call
        
        function main() {
          greetUser('Bob');  // Function call
        }
      `
      const result = await analyze(code)

      const moduleNode = result.nodes.find(node => node.componentType === 'module')
      const mainNode = result.nodes.find(node => node.name === 'main')

      expect(moduleNode).toBeDefined()
      expect(mainNode).toBeDefined()

      // Should have one edge from module node
      const moduleEdges = result.edges.filter(edge => edge.caller === moduleNode?.id)
      expect(moduleEdges.length).toBeGreaterThan(0)

      // Should have one edge from main function
      const mainEdges = result.edges.filter(edge => edge.caller === mainNode?.id)
      expect(mainEdges.length).toBeGreaterThan(0)
    })
  })

  describe('Builtin filtering at top-level', () => {
    it('should still filter builtin calls at top-level', async () => {
      const code = `
        console.log('test');  // Should be filtered
        setTimeout(() => {}, 100);  // Should be filtered
        
        const { myFunction } = require('./utils');
        myFunction();  // Should NOT be filtered
      `
      const result = await analyze(code)

      const moduleNode = result.nodes.find(node => node.componentType === 'module')
      const moduleEdges = result.edges.filter(edge => edge.caller === moduleNode?.id)

      // Should NOT have edges to console.log or setTimeout
      const hasConsoleLog = moduleEdges.some(e => e.callee === 'console.log')
      const hasSetTimeout = moduleEdges.some(e => e.callee === 'setTimeout')
      expect(hasConsoleLog).toBe(false)
      expect(hasSetTimeout).toBe(false)

      // Should have edge to myFunction
      const hasMyFunction = moduleEdges.some(e => e.callee.includes('myFunction'))
      expect(hasMyFunction).toBe(true)
    })

    it('should filter member builtin calls at top-level', async () => {
      const code = `
        console.log('start');
        JSON.parse('{}');
        Math.floor(1.5);
        Object.keys({});
        
        const { myLogger } = require('./logger');
        myLogger.log('message');
      `
      const result = await analyze(code)

      const moduleNode = result.nodes.find(node => node.componentType === 'module')
      const moduleEdges = result.edges.filter(edge => edge.caller === moduleNode?.id)

      // Verify member builtins are filtered
      const hasConsoleLog = moduleEdges.some(e => e.callee === 'console.log')
      const hasJSONParse = moduleEdges.some(e => e.callee === 'JSON.parse')
      const hasMathFloor = moduleEdges.some(e => e.callee === 'Math.floor')
      const hasObjectKeys = moduleEdges.some(e => e.callee === 'Object.keys')
      
      expect(hasConsoleLog).toBe(false)
      expect(hasJSONParse).toBe(false)
      expect(hasMathFloor).toBe(false)
      expect(hasObjectKeys).toBe(false)

      // Verify business function is NOT filtered
      const hasMyLogger = moduleEdges.some(e => e.callee.includes('myLogger.log'))
      expect(hasMyLogger).toBe(true)
    })
  })

  describe('TypeScript top-level calls', () => {
    it('should track TypeScript top-level calls', async () => {
      const code = `
        import { greetUser, UserManager } from './hello';
        
        const userManager = new UserManager();
        greetUser('Alice');
      `
      const result = await analyze(code)

      const moduleNode = result.nodes.find(node => node.componentType === 'module')
      expect(moduleNode).toBeDefined()

      const moduleEdges = result.edges.filter(edge => edge.caller === moduleNode?.id)
      expect(moduleEdges.length).toBeGreaterThan(0)

      // Verify calls are tracked
      const hasGreetUser = moduleEdges.some(e => e.callee.includes('greetUser'))
      const hasUserManager = moduleEdges.some(e => e.callee.includes('UserManager'))
      expect(hasGreetUser).toBe(true)
      expect(hasUserManager).toBe(true)
    })
  })

  describe('Edge cases', () => {
    it('should handle files with only top-level calls (no functions)', async () => {
      const code = `
        const { init } = require('./setup');
        init();
      `
      const result = await analyze(code)

      const moduleNode = result.nodes.find(node => node.componentType === 'module')
      expect(moduleNode).toBeDefined()

      // Should have module node even without function definitions
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0].componentType).toBe('module')

      // Should track the init call
      const moduleEdges = result.edges.filter(edge => edge.caller === moduleNode?.id)
      expect(moduleEdges.length).toBeGreaterThan(0)
    })

    it('should handle mixed top-level and function-level calls', async () => {
      const code = `
        const { setupDatabase, runMigrations } = require('./db');
        
        // Top-level initialization
        setupDatabase();
        runMigrations();
        
        function startServer() {
          const { createServer } = require('./server');
          createServer();
        }
        
        function handleRequest() {
          const { validateRequest } = require('./validation');
          validateRequest();
        }
      `
      const result = await analyze(code)

      const moduleNode = result.nodes.find(node => node.componentType === 'module')
      const startServerNode = result.nodes.find(node => node.name === 'startServer')
      const handleRequestNode = result.nodes.find(node => node.name === 'handleRequest')

      expect(moduleNode).toBeDefined()
      expect(startServerNode).toBeDefined()
      expect(handleRequestNode).toBeDefined()

      // Module should have 2 edges (setupDatabase, runMigrations)
      const moduleEdges = result.edges.filter(edge => edge.caller === moduleNode?.id)
      expect(moduleEdges.length).toBeGreaterThanOrEqual(2)

      // Each function should have 1 edge
      const startServerEdges = result.edges.filter(edge => edge.caller === startServerNode?.id)
      const handleRequestEdges = result.edges.filter(edge => edge.caller === handleRequestNode?.id)
      
      expect(startServerEdges.length).toBeGreaterThan(0)
      expect(handleRequestEdges.length).toBeGreaterThan(0)
    })
  })

  describe('Real-world scenario: demo/app.js', () => {
    it('should reproduce the demo/app.js issue when main function is commented', async () => {
      // This test reproduces the exact scenario from the plan
      const code = `
        const { greetUser, UserManager } = require('./hello');

        // Scenario: main function commented out
        // function main() {
          const userManager = new UserManager();
          const greeting = greetUser('Alice');
          userManager.addUser({ name: 'Alice', email: 'alice@example.com' });
          const allUsers = userManager.getUsers();
        // }
      `
      const result = await analyze(code)

      // Verify module node exists
      const moduleNode = result.nodes.find(node => node.componentType === 'module')
      expect(moduleNode).toBeDefined()

      // Verify all calls are tracked
      const moduleEdges = result.edges.filter(edge => edge.caller === moduleNode?.id)
      
      // Should have at least 4 edges (UserManager, greetUser, addUser, getUsers)
      expect(moduleEdges.length).toBeGreaterThanOrEqual(4)

      // Verify specific dependencies
      const hasGreetUser = moduleEdges.some(e => e.callee.includes('greetUser'))
      const hasUserManager = moduleEdges.some(e => e.callee.includes('UserManager'))
      const hasAddUser = moduleEdges.some(e => e.callee.includes('addUser'))
      const hasGetUsers = moduleEdges.some(e => e.callee.includes('getUsers'))

      expect(hasGreetUser).toBe(true)
      expect(hasUserManager).toBe(true)
      expect(hasAddUser).toBe(true)
      expect(hasGetUsers).toBe(true)
    })
  })
})
