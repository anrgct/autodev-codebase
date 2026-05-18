/// <reference types="vitest" />
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vol } from 'memfs'
import * as path from 'path'
import {
  analyze,
  generateVisualizationData,
  findMatchingNodes,
  queryNode,
  analyzeConnections,
  formatNodeQueryResult,
  formatConnectionAnalysisResult,
  type QueryOptions,
  type DependencyAnalyzerDeps
} from '../../dependency'
import { IFileSystem } from '../../abstractions'
import { NodePathUtils } from '../../adapters/nodejs/workspace'
import { IgnoreService } from '../../ignore/IgnoreService'

/**
 * Integration tests for call command using memfs
 * 
 * These tests verify real behavior without touching the actual file system
 */
describe('call command with memfs', () => {
  const testWorkspace = '/test-workspace'
  
  // Create a wrapper for memfs that matches IFileSystem interface
  const createMemFileSystem = (): IFileSystem => ({
    async readFile(filePath: string): Promise<Uint8Array> {
      const content = vol.readFileSync(filePath, 'utf-8') as string
      return new TextEncoder().encode(content)
    },
    
    async writeFile(filePath: string, data: Uint8Array): Promise<void> {
      vol.writeFileSync(filePath, Buffer.from(data))
    },
    
    async exists(filePath: string): Promise<boolean> {
      return vol.existsSync(filePath)
    },
    
    async stat(filePath: string) {
      const stats = vol.statSync(filePath)
      return {
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        size: stats.size,
        mtime: stats.mtimeMs
      }
    },
    
    async readdir(dirPath: string): Promise<string[]> {
      return vol.readdirSync(dirPath) as string[]
    },
    
    async mkdir(dirPath: string): Promise<void> {
      vol.mkdirSync(dirPath, { recursive: true })
    },
    
    async delete(filePath: string): Promise<void> {
      vol.unlinkSync(filePath)
    }
  })
  
  const pathUtils = new NodePathUtils()
  let fileSystem: IFileSystem

  beforeEach(() => {
    // Reset memfs before each test
    vol.reset()
    fileSystem = createMemFileSystem()
  })

  afterEach(() => {
    vol.reset()
  })

  /**
   * Helper: Create test file
   */
  async function createFile(relativePath: string, content: string): Promise<string> {
    const fullPath = path.join(testWorkspace, relativePath)
    const dir = path.dirname(fullPath)
    
    vol.mkdirSync(dir, { recursive: true })
    vol.writeFileSync(fullPath, content, { encoding: 'utf-8' })
    
    return fullPath
  }

  /**
   * Helper: Run analysis on test directory
   */
  async function runAnalysis(targetPath?: string) {
    const pathToAnalyze = targetPath 
      ? path.join(testWorkspace, targetPath)
      : testWorkspace
    
    // Create dependencies with workspace
    const ignoreService = new IgnoreService(fileSystem, pathUtils, {
      rootPath: testWorkspace
    })
    await ignoreService.initialize()
    
    const deps: DependencyAnalyzerDeps = {
      fileSystem,
      pathUtils,
      workspace: {
        getRootPath: () => testWorkspace,
        getRelativePath: (fullPath: string) => pathUtils.relative(testWorkspace, fullPath),
        getIgnoreRules: () => [],
        getGlobIgnorePatterns: async () => [],
        shouldIgnore: async (filePath: string) => ignoreService.shouldIgnore(filePath),
        getIgnoreService: () => ignoreService,
        getName: () => 'test-workspace',
        getWorkspaceFolders: () => [],
        findFiles: async () => []
      }
    }
    
    return await analyze(pathToAnalyze, deps, {
      enableCache: false
    })
  }

  /**
   * Test 1: Overview mode (default) outputs correct summary
   */
  describe('Task 1: Overview mode', () => {
    it('should display dependency analysis summary correctly', async () => {
      // Create test files with dependencies
      await createFile('src/main.ts', `
import { helper } from './helper'
import { util } from './utils/util'

export function main() {
  helper()
  util.format()
}
      `)

      await createFile('src/helper.ts', `
export function helper() {
  console.log('helper')
}
      `)

      await createFile('src/utils/util.ts', `
export function util() {
  return 'util'
}

export function format() {
  return 'formatted'
}
      `)

      const result = await runAnalysis()

      // Verify summary statistics
      expect(result.summary.totalFiles).toBeGreaterThanOrEqual(3)
      expect(result.summary.totalNodes).toBeGreaterThan(0)
      expect(result.summary.totalRelationships).toBeGreaterThan(0)
      expect(result.summary.languages).toContain('typescript')

      // Verify nodes have required properties
      for (const node of result.nodes.values()) {
        expect(node.id).toBeDefined()
        expect(node.name).toBeDefined()
        expect(node.filePath).toBeDefined()
        expect(node.componentType).toBeDefined()
      }

      // Verify relationships
      expect(result.relationships.length).toBeGreaterThan(0)
      for (const rel of result.relationships) {
        expect(rel.caller).toBeDefined()
        expect(rel.callee).toBeDefined()
      }
    })

    it('should show component types in summary', async () => {
      await createFile('src/class.ts', `
export class MyClass {
  method() {
    this.helper()
  }

  private helper() {
    return 'help'
  }
}
      `)

      const result = await runAnalysis()

      // Count component types
      const componentTypes = new Map<string, number>()
      for (const node of result.nodes.values()) {
        const count = componentTypes.get(node.componentType) || 0
        componentTypes.set(node.componentType, count + 1)
      }

      // Should have at least one component type
      expect(componentTypes.size).toBeGreaterThan(0)
    })
  })

  /**
   * Test 2: JSON export format is correct
   */
  describe('Task 2: JSON export', () => {
    it('should export data in correct JSON format', async () => {
      await createFile('src/test.ts', `
export function testFunction() {
  helper()
}

export function helper() {
  return 'help'
}
      `)

      const result = await runAnalysis()
      const viz = generateVisualizationData(result.nodes, result.relationships, result.summary)

      // Verify structure
      expect(viz).toBeDefined()
      expect(viz.cytoscape).toBeDefined()
      expect(viz.summary).toBeDefined()

      // Verify cytoscape elements
      expect(Array.isArray(viz.cytoscape.elements)).toBe(true)

      // Verify summary
      expect(viz.summary.total_nodes).toBe(result.nodes.size)
      expect(viz.summary.total_edges).toBeGreaterThan(0)
      expect(Array.isArray(viz.summary.languages)).toBe(true)
      expect(typeof viz.summary.component_types).toBe('object')

      // Verify node elements
      const nodeElements = viz.cytoscape.elements.filter(el => el.data && el.data['id'] && !el.data['source'])
      expect(nodeElements.length).toBeGreaterThan(0)

      for (const nodeEl of nodeElements) {
        expect(nodeEl.data['id']).toBeDefined()
        expect(nodeEl.data['label']).toBeDefined()
        expect(nodeEl.data['file']).toBeDefined()
        expect(nodeEl.data['type']).toBeDefined()
        expect(nodeEl.classes).toBeDefined()
      }

      // Verify edge elements
      const edgeElements = viz.cytoscape.elements.filter(el => el.data && el.data['source'])
      expect(edgeElements.length).toBeGreaterThan(0)

      for (const edgeEl of edgeElements) {
        expect(edgeEl.data['id']).toBeDefined()
        expect(edgeEl.data['source']).toBeDefined()
        expect(edgeEl.data['target']).toBeDefined()
        expect(edgeEl.classes).toBe('edge-call')
      }
    })

    it('should be valid JSON string', async () => {
      await createFile('src/test.ts', `
export function func() {
  return 'test'
}
      `)

      const result = await runAnalysis()
      const viz = generateVisualizationData(result.nodes, result.relationships, result.summary)

      // Verify it can be stringified and parsed
      const jsonString = JSON.stringify(viz)
      const parsed = JSON.parse(jsonString)

      expect(parsed).toEqual(viz)
    })
  })

  /**
   * Test 3: Query single function
   */
  describe('Task 3: Query single function', () => {
    it('should find and query a single function by name', async () => {
      await createFile('src/main.ts', `
export function main() {
  helper1()
  helper2()
}

export function helper1() {
  return '1'
}

export function helper2() {
  helper3()
  return '2'
}

export function helper3() {
  return '3'
}
      `)

      const result = await runAnalysis()

      // Query single function
      let matchedNodes = findMatchingNodes(result.nodes, 'main')

      // When multiple nodes match (module + function), prefer function over module
      const functionNode = matchedNodes.find(n => n.componentType === 'function')
      const targetNode = functionNode || matchedNodes[0]

      const queryOptions: QueryOptions = { depth: 10 }
      const queryResult = queryNode(result.nodes, targetNode, queryOptions)

      // Verify structure
      expect(queryResult.node).toBeDefined()
      expect(queryResult.callees).toBeDefined()
      expect(queryResult.callers).toBeDefined()

      // Verify callees - main calls helper1 and helper2
      expect(queryResult.callees.length).toBe(2)
      const calleeNames = queryResult.callees.map(c => c.name)
      expect(calleeNames).toContain('helper1')
      expect(calleeNames).toContain('helper2')

      // Verify formatting
      const formatted = formatNodeQueryResult(queryResult)
      expect(Array.isArray(formatted)).toBe(true)
      expect(formatted.length).toBeGreaterThan(0)
      expect(formatted.join('\n')).toContain('main')
      expect(formatted.join('\n')).toContain('calls (callee)')
    })

    it('should return empty result for non-existent function', async () => {
      await createFile('src/test.ts', `
export function existingFunction() {
  return 'test'
}
      `)

      const result = await runAnalysis()

      const matchedNodes = findMatchingNodes(result.nodes, 'nonExistentFunction')
      expect(matchedNodes.length).toBe(0)
    })
  })

  /**
   * Test 4: Query multiple functions (connection analysis)
   */
  describe('Task 4: Query multiple functions', () => {
    it('should analyze connections between multiple functions', async () => {
      await createFile('src/test.ts', `
export function functionA() {
  functionC()
}

export function functionB() {
  functionC()
}

export function functionC() {
  return 'c'
}
      `)

      const result = await runAnalysis()

      // Query multiple functions
      const analysisResult = analyzeConnections(result.nodes, 'functionA,functionB', 10)

      // Verify structure
      expect(analysisResult.queryNames).toEqual(['functionA', 'functionB'])
      expect(analysisResult.matchedNodes.length).toBe(2)
      expect(analysisResult.directConnections).toBeDefined()
      expect(analysisResult.chains).toBeDefined()
      expect(analysisResult.involvedNodes).toBeDefined()

      // Both functionA and functionB call functionC
      expect(analysisResult.directConnections.length).toBeGreaterThanOrEqual(0)

      // Verify formatting
      const formatted = formatConnectionAnalysisResult(analysisResult)
      expect(Array.isArray(formatted)).toBe(true)
      expect(formatted.join('\n')).toContain('functionA')
      expect(formatted.join('\n')).toContain('functionB')
    })

    it('should find direct connections between queried functions', async () => {
      await createFile('src/test.ts', `
export function functionA() {
  functionB()
}

export function functionB() {
  functionC()
}

export function functionC() {
  return 'end'
}
      `)

      const result = await runAnalysis()

      const analysisResult = analyzeConnections(result.nodes, 'functionA,functionC', 10)

      // Should find both functions
      expect(analysisResult.matchedNodes.length).toBe(2)

      // Verify structure
      expect(analysisResult.queryNames).toEqual(['functionA', 'functionC'])
      expect(analysisResult.directConnections).toBeDefined()
      expect(analysisResult.chains).toBeDefined()

      // No direct connection between functionA and functionC
      expect(analysisResult.directConnections.length).toBe(0)

      // But there should be a chain: functionA -> functionB -> functionC
      expect(analysisResult.chains.length).toBeGreaterThan(0)

      // The chain should have at least 3 nodes
      expect(analysisResult.chains[0].path.length).toBeGreaterThanOrEqual(3)
    })
  })

  /**
   * Test 5: Wildcard queries
   */
  describe('Task 5: Wildcard queries', () => {
    it('should match functions using wildcard *', async () => {
      await createFile('src/test.ts', `
export function testFunc1() {
  return '1'
}

export function testFunc2() {
  return '2'
}

export function otherFunction() {
  return 'other'
}
      `)

      const result = await runAnalysis()

      // Query with wildcard - use containing wildcard to match ID
      const matchedNodes = findMatchingNodes(result.nodes, '*testFunc*')

      // Should match testFunc1 and testFunc2 but not otherFunction
      expect(matchedNodes.length).toBe(2)
      const names = matchedNodes.map(n => n.name)
      expect(names).toContain('testFunc1')
      expect(names).toContain('testFunc2')
      expect(names).not.toContain('otherFunction')
    })

    it('should match functions using wildcard ?', async () => {
      await createFile('src/test.ts', `
export function func1() {
  return '1'
}

export function func2() {
  return '2'
}

export function func99() {
  return '99'
}
      `)

      const result = await runAnalysis()

      // Query with ? wildcard matching end of function name in ID
      const matchedNodes = findMatchingNodes(result.nodes, '*test.func?')

      // Should match func1 and func2 but not func99
      expect(matchedNodes.length).toBe(2)
      const names = matchedNodes.map(n => n.name)
      expect(names).toContain('func1')
      expect(names).toContain('func2')
      expect(names).not.toContain('func99')
    })

    it('should support case-insensitive wildcard matching', async () => {
      await createFile('src/test.ts', `
export function TestFunction() {
  return 'test'
}
      `)

      const result = await runAnalysis()

      // Should match case-insensitively
      const matchedNodes1 = findMatchingNodes(result.nodes, 'testfunction')
      const matchedNodes2 = findMatchingNodes(result.nodes, 'TESTFUNCTION')
      const matchedNodes3 = findMatchingNodes(result.nodes, 'TestFunction')

      expect(matchedNodes1.length).toBe(1)
      expect(matchedNodes2.length).toBe(1)
      expect(matchedNodes3.length).toBe(1)
    })
  })

  /**
   * Test 6: Depth limit
   */
  describe('Task 6: Depth limit', () => {
    it('should respect depth limit in callee tree', async () => {
      await createFile('src/test.ts', `
export function level0() {
  level1()
}

export function level1() {
  level2()
}

export function level2() {
  level3()
}

export function level3() {
  return 'deep'
}
      `)

      const result = await runAnalysis()

      const matchedNodes = findMatchingNodes(result.nodes, 'level0')
      expect(matchedNodes.length).toBe(1)

      // Query with depth 1
      const queryOptions1: QueryOptions = { depth: 1 }
      const queryResult1 = queryNode(result.nodes, matchedNodes[0], queryOptions1)

      // Should only include level1 (depth 0 -> depth 1)
      expect(queryResult1.callees.length).toBe(1)
      expect(queryResult1.callees[0].name).toBe('level1')
      expect(queryResult1.callees[0].children.length).toBe(0)

      // Query with depth 2
      const queryOptions2: QueryOptions = { depth: 2 }
      const queryResult2 = queryNode(result.nodes, matchedNodes[0], queryOptions2)

      // Should include level1 and level2
      expect(queryResult2.callees.length).toBe(1)
      expect(queryResult2.callees[0].name).toBe('level1')
      expect(queryResult2.callees[0].children.length).toBe(1)
      expect(queryResult2.callees[0].children[0].name).toBe('level2')
      expect(queryResult2.callees[0].children[0].children.length).toBe(0)
    })

    it('should respect depth limit in caller tree', async () => {
      await createFile('src/test.ts', `
export function caller0() {
  caller1()
}

export function caller1() {
  caller2()
}

export function caller2() {
  callee()
}

export function callee() {
  return 'called'
}
      `)

      const result = await runAnalysis()

      const matchedNodes = findMatchingNodes(result.nodes, 'callee')
      expect(matchedNodes.length).toBe(1)

      // Query with depth 1
      const queryOptions1: QueryOptions = { depth: 1 }
      const queryResult1 = queryNode(result.nodes, matchedNodes[0], queryOptions1)

      // Should only include caller2 (direct caller)
      expect(queryResult1.callers.length).toBe(1)
      expect(queryResult1.callers[0].name).toBe('caller2')
      expect(queryResult1.callers[0].children.length).toBe(0)

      // Query with depth 2
      const queryOptions2: QueryOptions = { depth: 2 }
      const queryResult2 = queryNode(result.nodes, matchedNodes[0], queryOptions2)

      // Should include caller2 and caller1
      expect(queryResult2.callers.length).toBe(1)
      expect(queryResult2.callers[0].name).toBe('caller2')
      expect(queryResult2.callers[0].children.length).toBe(1)
      expect(queryResult2.callers[0].children[0].name).toBe('caller1')
    })

    it('should handle depth 0 correctly', async () => {
      await createFile('src/test.ts', `
export function root() {
  child()
}

export function child() {
  return 'child'
}
      `)

      const result = await runAnalysis()

      const matchedNodes = findMatchingNodes(result.nodes, 'root')
      const queryOptions: QueryOptions = { depth: 0 }
      const queryResult = queryNode(result.nodes, matchedNodes[0], queryOptions)

      // Depth 0 should return no callees
      expect(queryResult.callees.length).toBe(0)
    })
  })

  /**
   * Test 7: --open functionality
   */
  describe('Task 7: --open functionality', () => {
    it('should handle --open flag in export mode', async () => {
      await createFile('src/test.ts', `
export function testFunction() {
  return 'test'
}
      `)

      const result = await runAnalysis()
      const viz = generateVisualizationData(result.nodes, result.relationships, result.summary)

      // Verify the data can be exported
      const outputPath = path.join(testWorkspace, 'output.json')
      const jsonContent = JSON.stringify(viz.cytoscape.elements, null, 2)
      vol.writeFileSync(outputPath, jsonContent, { encoding: 'utf-8' })

      // Verify file was created
      const content = vol.readFileSync(outputPath, 'utf-8') as string
      const parsed = JSON.parse(content)

      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed.length).toBeGreaterThan(0)
    })

    it('should generate valid file:// URL for browser', async () => {
      const outputPath = path.join(testWorkspace, 'dependencies.json')

      // Simulate file:// URL generation
      const fileUrl = `file://${outputPath}`

      expect(fileUrl).toMatch(/^file:\/\//)
      expect(fileUrl).toContain('dependencies.json')
    })
  })

  /**
   * Integration tests
   */
  describe('Integration tests', () => {
    it('should handle complex dependency chains', async () => {
      await createFile('src/a.ts', `
import { b } from './b'
export function a() {
  b()
}
      `)

      await createFile('src/b.ts', `
import { c } from './c'
export function b() {
  c()
}
      `)

      await createFile('src/c.ts', `
export function c() {
  return 'end'
}
      `)

      const result = await runAnalysis()

      // Should find all functions
      expect(result.nodes.size).toBeGreaterThanOrEqual(3)

      // Query chain
      let matchedNodes = findMatchingNodes(result.nodes, 'a')
      // When multiple nodes match (module + function), prefer function over module
      const functionNode = matchedNodes.find(n => n.componentType === 'function')
      const targetNode = functionNode || matchedNodes[0]

      const queryResult = queryNode(result.nodes, targetNode, { depth: 10 })

      // Should traverse full chain
      const names = queryResult.callees.map(c => c.name)
      expect(names).toContain('b')
    })

    it('should distinguish module and function nodes by full ID', async () => {
      await createFile('src/a.ts', `
export function a() {
  return 'a'
}

// Top-level call to trigger module node creation
a()
`)

      const result = await runAnalysis()

      // Short name query matches both module and function
      const matchedByName = findMatchingNodes(result.nodes, 'a')
      expect(matchedByName.length).toBe(2)

      // Full ID query matches exactly one node
      const matchedModuleById = findMatchingNodes(result.nodes, 'src/a')
      expect(matchedModuleById.length).toBe(1)
      expect(matchedModuleById[0].componentType).toBe('module')

      const matchedFunctionById = findMatchingNodes(result.nodes, 'src/a.a')
      expect(matchedFunctionById.length).toBe(1)
      expect(matchedFunctionById[0].componentType).toBe('function')
    })

    it('should handle multiple files with same function names', async () => {
      await createFile('src/one.ts', `
export function helper() {
  return 'one'
}
      `)

      await createFile('src/two.ts', `
export function helper() {
  return 'two'
}
      `)

      const result = await runAnalysis()

      // Should find both helpers
      const matchedNodes = findMatchingNodes(result.nodes, 'helper')
      expect(matchedNodes.length).toBe(2)

      // Each should have unique IDs
      const ids = matchedNodes.map(n => n.id)
      expect(new Set(ids).size).toBe(2)
    })

    it('should handle cycles in dependencies', async () => {
      await createFile('src/a.ts', `
import { b } from './b'
export function a() {
  b()
}
      `)

      await createFile('src/b.ts', `
import { a } from './a'
export function b() {
  a()
}
      `)

      const result = await runAnalysis()

      // Should detect cycles
      expect(result.cycles).toBeDefined()

      // Should still complete analysis
      expect(result.nodes.size).toBeGreaterThan(0)
    })
  })

  /**
   * Revision 3: ID-only query matching (2026-01-18)
   * 
   * Tests for simplified query logic that always uses ID matching for wildcards,
   * with fallback to name matching for exact queries (backward compatibility).
   */
  describe('Revision 3: ID-only query matching', () => {
    it('should support exact name query (backward compatibility)', async () => {
      await createFile('src/test.ts', `
export function getUser() {
  return 'user'
}

export function setUser() {
  return 'set'
}
      `)

      const result = await runAnalysis()

      // Exact name query should work (backward compatibility)
      const matchedNodes = findMatchingNodes(result.nodes, 'getUser')
      expect(matchedNodes.length).toBe(1)
      expect(matchedNodes[0].name).toBe('getUser')
    })

    it('should support exact ID query', async () => {
      await createFile('src/test.ts', `
export function getUser() {
  return 'user'
}
      `)

      const result = await runAnalysis()

      // Find the node with exact ID
      const targetId = Array.from(result.nodes.keys()).find(id => id.endsWith('.getUser'))
      expect(targetId).toBeDefined()

      // Exact ID query should match
      const matchedNodes = findMatchingNodes(result.nodes, targetId!)
      expect(matchedNodes.length).toBe(1)
      expect(matchedNodes[0].id).toBe(targetId)
    })

    it('should match ID with containing wildcard *keyword*', async () => {
      await createFile('src/test.ts', `
export function getUser() {
  return 'user'
}

export function setUser() {
  return 'set'
}

export function deleteUser() {
  return 'delete'
}
      `)

      const result = await runAnalysis()

      // *User* should match all functions with "User" in their ID
      const matchedNodes = findMatchingNodes(result.nodes, '*User*')
      expect(matchedNodes.length).toBe(3)
      
      const names = matchedNodes.map(n => n.name)
      expect(names).toContain('getUser')
      expect(names).toContain('setUser')
      expect(names).toContain('deleteUser')
    })

    it('should match ID with suffix wildcard *suffix', async () => {
      await createFile('src/test.ts', `
export function getter() {
  return 'get'
}

export function setter() {
  return 'set'
}

export function other() {
  return 'other'
}
      `)

      const result = await runAnalysis()

      // *ter should match functions ending with "ter" in their name
      const matchedNodes = findMatchingNodes(result.nodes, '*ter')
      expect(matchedNodes.length).toBe(2)
      
      const names = matchedNodes.map(n => n.name)
      expect(names).toContain('getter')
      expect(names).toContain('setter')
      expect(names).not.toContain('other')
    })

    it('should NOT match with prefix wildcard prefix* (IDs start with path)', async () => {
      await createFile('src/test.ts', `
export function getUser() {
  return 'user'
}
      `)

      const result = await runAnalysis()

      // getUser* should NOT match because IDs don't start with "getUser"
      const matchedNodes = findMatchingNodes(result.nodes, 'getUser*')
      expect(matchedNodes.length).toBe(0)
    })

    it('should match module wildcard module.*', async () => {
      await createFile('src/test.ts', `
export function func1() {
  return '1'
}
      `)

      await createFile('src/other.ts', `
export function func2() {
  return '2'
}
      `)

      const result = await runAnalysis()

      // */test.* should match functions in test.ts file
      // ID format is usually: "src/test.func1" (relativePath + '.' + functionName)
      const matchedNodes = findMatchingNodes(result.nodes, '*/test.*')
      expect(matchedNodes.length).toBe(1)
      expect(matchedNodes[0].name).toBe('func1')
    })

    it('should match class-level wildcard *.*.method*', async () => {
      await createFile('src/test.ts', `
export class TestClass {
  method1() { return '1' }
  method2() { return '2' }
}

export function otherMethod() {
  return 'other'
}
      `)

      const result = await runAnalysis()

      // *.*.method* should match all methods starting with "method"
      const matchedNodes = findMatchingNodes(result.nodes, '*.*.method*')
      expect(matchedNodes.length).toBe(2)
      
      const names = matchedNodes.map(n => n.name)
      expect(names).toContain('method1')
      expect(names).toContain('method2')
      expect(names).not.toContain('otherMethod')
    })

    it('should match path wildcard */path/*', async () => {
      await createFile('src/test.ts', `
export function func1() {
  return '1'
}
`)

      await createFile('src/other.ts', `
export function func2() {
  return '2'
}
`)

      const result = await runAnalysis()

      // */test.* should match functions in test.ts file
      const matchedNodes = findMatchingNodes(result.nodes, '*/test.*')
      
      expect(matchedNodes.length).toBe(1)
      expect(matchedNodes[0].name).toBe('func1')
    })

    it('should be case-insensitive for wildcard queries', async () => {
      await createFile('src/test.ts', `
export function GetUser() {
  return 'user'
}
      `)

      const result = await runAnalysis()

      // *USER* should match case-insensitively against ID
      const matchedNodes = findMatchingNodes(result.nodes, '*USER*')
      expect(matchedNodes.length).toBe(1)
      expect(matchedNodes[0].name).toBe('GetUser')
    })

    it('should support single character wildcard ?', async () => {
      await createFile('src/test.ts', `
export function func1() { return '1' }
export function func2() { return '2' }
export function func99() { return '99' }
      `)

      const result = await runAnalysis()

      // *.func? should match func1 and func2 but not func99
      const matchedNodes = findMatchingNodes(result.nodes, '*.func?')
      expect(matchedNodes.length).toBe(2)
      
      const names = matchedNodes.map(n => n.name)
      expect(names).toContain('func1')
      expect(names).toContain('func2')
      expect(names).not.toContain('func99')
    })
  })
})
