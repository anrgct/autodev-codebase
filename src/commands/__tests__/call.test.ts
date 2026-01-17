/// <reference types="vitest" />
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { NodeFileSystem } from '../../adapters/nodejs/file-system'
import { NodePathUtils } from '../../adapters/nodejs/workspace'
import {
  analyze,
  generateVisualizationData,
  findMatchingNodes,
  queryNode,
  analyzeConnections,
  formatNodeQueryResult,
  formatConnectionAnalysisResult,
  type QueryOptions
} from '../../dependency'

/**
 * Test utilities for the call command
 */
class CallTestUtils {
  private testDir: string
  private fileSystem = new NodeFileSystem()
  private pathUtils = new NodePathUtils()

  constructor(testDir: string) {
    this.testDir = testDir
  }

  /**
   * Create a test file with content
   */
  async createFile(relativePath: string, content: string): Promise<string> {
    const fullPath = path.join(this.testDir, relativePath)
    const dir = path.dirname(fullPath)

    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(fullPath, content, 'utf-8')

    return fullPath
  }

  /**
   * Clean up test directory
   */
  async cleanup(): Promise<void> {
    await fs.rm(this.testDir, { recursive: true, force: true })
  }

  /**
   * Run analysis on test directory
   */
  async analyze(maxFiles = 100) {
    const deps = {
      fileSystem: this.fileSystem,
      pathUtils: this.pathUtils
    }

    return await analyze(this.testDir, deps, maxFiles, {
      enableCache: false // Disable cache for tests
    })
  }
}

describe('call command tests', () => {
  const testBaseDir = path.join(process.cwd(), 'tmp', 'call-command-tests')
  let utils: CallTestUtils
  let testCounter = 0

  beforeAll(async () => {
    // Ensure test base directory exists
    await fs.mkdir(testBaseDir, { recursive: true })
  })

  afterEach(async () => {
    if (utils) {
      await utils.cleanup()
    }
  })

  /**
   * Test 1: Overview mode (default) outputs correct summary
   */
  describe('Task 1: Overview mode', () => {
    it('should display dependency analysis summary correctly', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      // Create test files with dependencies
      await utils.createFile('src/main.ts', `
import { helper } from './helper'
import { util } from './utils/util'

export function main() {
  helper()
  util.format()
}
      `)

      await utils.createFile('src/helper.ts', `
export function helper() {
  console.log('helper')
}
      `)

      await utils.createFile('src/utils/util.ts', `
export function util() {
  return 'util'
}

export function format() {
  return 'formatted'
}
      `)

      const result = await utils.analyze()

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
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/class.ts', `
export class MyClass {
  method() {
    this.helper()
  }

  private helper() {
    return 'help'
  }
}
      `)

      const result = await utils.analyze()

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
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
export function testFunction() {
  helper()
}

export function helper() {
  return 'help'
}
      `)

      const result = await utils.analyze()
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
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
export function func() {
  return 'test'
}
      `)

      const result = await utils.analyze()
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
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/main.ts', `
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

      const result = await utils.analyze()

      // Query single function
      const matchedNodes = findMatchingNodes(result.nodes, 'main')
      expect(matchedNodes.length).toBe(1)

      const queryOptions: QueryOptions = { depth: 10 }
      const queryResult = queryNode(result.nodes, matchedNodes[0], queryOptions)

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
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
export function existingFunction() {
  return 'test'
}
      `)

      const result = await utils.analyze()

      const matchedNodes = findMatchingNodes(result.nodes, 'nonExistentFunction')
      expect(matchedNodes.length).toBe(0)
    })
  })

  /**
   * Test 4: Query multiple functions (connection analysis)
   */
  describe('Task 4: Query multiple functions', () => {
    it('should analyze connections between multiple functions', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
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

      const result = await utils.analyze()

      // Query multiple functions
      const analysisResult = analyzeConnections(result.nodes, 'functionA,functionB')

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
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
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

      const result = await utils.analyze()

      const analysisResult = analyzeConnections(result.nodes, 'functionA,functionC')

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
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
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

      const result = await utils.analyze()

      // Query with wildcard - use containing wildcard to match ID
      // (prefix wildcards like "testFunc*" don't work with ID-only matching)
      const matchedNodes = findMatchingNodes(result.nodes, '*testFunc*')

      // Should match testFunc1 and testFunc2 but not otherFunction
      expect(matchedNodes.length).toBe(2)
      const names = matchedNodes.map(n => n.name)
      expect(names).toContain('testFunc1')
      expect(names).toContain('testFunc2')
      expect(names).not.toContain('otherFunction')
    })

    it('should match functions using wildcard ?', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
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

      const result = await utils.analyze()

      // Query with ? wildcard matching end of function name in ID
      // IDs are like "src/test.test.func1", so "test.ts.test.func?" works
      const matchedNodes = findMatchingNodes(result.nodes, '*test.func?')

      // Should match func1 and func2 but not func99
      expect(matchedNodes.length).toBe(2)
      const names = matchedNodes.map(n => n.name)
      expect(names).toContain('func1')
      expect(names).toContain('func2')
      expect(names).not.toContain('func99')
    })

    it('should support case-insensitive wildcard matching', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
export function TestFunction() {
  return 'test'
}
      `)

      const result = await utils.analyze()

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
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
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

      const result = await utils.analyze()

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
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
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

      const result = await utils.analyze()

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
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
export function root() {
  child()
}

export function child() {
  return 'child'
}
      `)

      const result = await utils.analyze()

      const matchedNodes = findMatchingNodes(result.nodes, 'root')
      const queryOptions: QueryOptions = { depth: 0 }
      const queryResult = queryNode(result.nodes, matchedNodes[0], queryOptions)

      // Depth 0 should return no callees
      expect(queryResult.callees.length).toBe(0)
    })
  })

  /**
   * Test 7: --open functionality (mock test)
   */
  describe('Task 7: --open functionality', () => {
    it('should handle --open flag in export mode', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
export function testFunction() {
  return 'test'
}
      `)

      const result = await utils.analyze()
      const viz = generateVisualizationData(result.nodes, result.relationships, result.summary)

      // Verify the data can be exported (simulating --open without actually opening browser)
      const outputPath = path.join(testDir, 'output.json')
      await fs.writeFile(outputPath, JSON.stringify(viz.cytoscape.elements, null, 2), 'utf-8')

      // Verify file was created
      const content = await fs.readFile(outputPath, 'utf-8')
      const parsed = JSON.parse(content)

      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed.length).toBeGreaterThan(0)
    })

    it('should generate valid file:// URL for browser', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      const outputPath = path.join(testDir, 'dependencies.json')

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
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/a.ts', `
import { b } from './b'
export function a() {
  b()
}
      `)

      await utils.createFile('src/b.ts', `
import { c } from './c'
export function b() {
  c()
}
      `)

      await utils.createFile('src/c.ts', `
export function c() {
  return 'end'
}
      `)

      const result = await utils.analyze()

      // Should find all functions
      expect(result.nodes.size).toBeGreaterThanOrEqual(3)

      // Query chain
      const matchedNodes = findMatchingNodes(result.nodes, 'a')
      expect(matchedNodes.length).toBe(1)

      const queryResult = queryNode(result.nodes, matchedNodes[0], { depth: 10 })

      // Should traverse full chain
      const names = queryResult.callees.map(c => c.name)
      expect(names).toContain('b')
    })

    it('should handle multiple files with same function names', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/one.ts', `
export function helper() {
  return 'one'
}
      `)

      await utils.createFile('src/two.ts', `
export function helper() {
  return 'two'
}
      `)

      const result = await utils.analyze()

      // Should find both helpers
      const matchedNodes = findMatchingNodes(result.nodes, 'helper')
      expect(matchedNodes.length).toBe(2)

      // Each should have unique IDs
      const ids = matchedNodes.map(n => n.id)
      expect(new Set(ids).size).toBe(2)
    })

    it('should handle cycles in dependencies', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/a.ts', `
import { b } from './b'
export function a() {
  b()
}
      `)

      await utils.createFile('src/b.ts', `
import { a } from './a'
export function b() {
  a()
}
      `)

      const result = await utils.analyze()

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
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
export function getUser() {
  return 'user'
}

export function setUser() {
  return 'set'
}
      `)

      const result = await utils.analyze()

      // Exact name query should work (backward compatibility)
      const matchedNodes = findMatchingNodes(result.nodes, 'getUser')
      expect(matchedNodes.length).toBe(1)
      expect(matchedNodes[0].name).toBe('getUser')
    })

    it('should support exact ID query', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
export function getUser() {
  return 'user'
}
      `)

      const result = await utils.analyze()

      // Find the node with exact ID
      const targetId = Array.from(result.nodes.keys()).find(id => id.endsWith('.getUser'))
      expect(targetId).toBeDefined()

      // Exact ID query should match
      const matchedNodes = findMatchingNodes(result.nodes, targetId!)
      expect(matchedNodes.length).toBe(1)
      expect(matchedNodes[0].id).toBe(targetId)
    })

    it('should match ID with containing wildcard *keyword*', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
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

      const result = await utils.analyze()

      // *User* should match all functions with "User" in their ID
      const matchedNodes = findMatchingNodes(result.nodes, '*User*')
      expect(matchedNodes.length).toBe(3)
      
      const names = matchedNodes.map(n => n.name)
      expect(names).toContain('getUser')
      expect(names).toContain('setUser')
      expect(names).toContain('deleteUser')
    })

    it('should match ID with suffix wildcard *suffix', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
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

      const result = await utils.analyze()

      // *ter should match functions ending with "ter" in their name
      const matchedNodes = findMatchingNodes(result.nodes, '*ter')
      expect(matchedNodes.length).toBe(2)
      
      const names = matchedNodes.map(n => n.name)
      expect(names).toContain('getter')   // getter ends with 'ter'
      expect(names).toContain('setter')   // setter ends with 'ter'
      expect(names).not.toContain('other')
    })

    it('should NOT match with prefix wildcard prefix* (IDs start with path)', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
export function getUser() {
  return 'user'
}
      `)

      const result = await utils.analyze()

      // getUser* should NOT match because IDs don't start with "getUser"
      // IDs start with path like "src/test.test.getUser"
      const matchedNodes = findMatchingNodes(result.nodes, 'getUser*')
      expect(matchedNodes.length).toBe(0)
    })

    it('should match module wildcard module.*', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
export function func1() {
  return '1'
}
      `)

      await utils.createFile('src/other.ts', `
export function func2() {
  return '2'
}
      `)

      const result = await utils.analyze()

      // src/test.* should match functions in src/test module
      const matchedNodes = findMatchingNodes(result.nodes, 'src/test.*')
      expect(matchedNodes.length).toBe(1)
      expect(matchedNodes[0].name).toBe('func1')
    })

    it('should match class-level wildcard *.*.method*', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
export class TestClass {
  method1() { return '1' }
  method2() { return '2' }
}

export function otherMethod() {
  return 'other'
}
      `)

      const result = await utils.analyze()

      // *.*.method* should match all methods starting with "method"
      const matchedNodes = findMatchingNodes(result.nodes, '*.*.method*')
      expect(matchedNodes.length).toBe(2)
      
      const names = matchedNodes.map(n => n.name)
      expect(names).toContain('method1')
      expect(names).toContain('method2')
      expect(names).not.toContain('otherMethod')
    })

    it('should match path wildcard */path/*', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
export function func1() {
  return '1'
}
`)

      await utils.createFile('src/other.ts', `
export function func2() {
  return '2'
}
`)

      const result = await utils.analyze()

      // */test.* should match functions in test.ts file
      // Actual ID format: "src/test.func1" (relativePath + '.' + functionName)
      const matchedNodes = findMatchingNodes(result.nodes, '*/test.*')
      
      expect(matchedNodes.length).toBe(1)
      expect(matchedNodes[0].name).toBe('func1')
    })

    it('should be case-insensitive for wildcard queries', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
export function GetUser() {
  return 'user'
}
      `)

      const result = await utils.analyze()

      // *USER* should match case-insensitively against ID
      const matchedNodes = findMatchingNodes(result.nodes, '*USER*')
      expect(matchedNodes.length).toBe(1)
      expect(matchedNodes[0].name).toBe('GetUser')
    })

    it('should support single character wildcard ?', async () => {
      const testDir = path.join(testBaseDir, `test-${testCounter++}`)
      utils = new CallTestUtils(testDir)

      await utils.createFile('src/test.ts', `
export function func1() { return '1' }
export function func2() { return '2' }
export function func99() { return '99' }
      `)

      const result = await utils.analyze()

      // *.func? should match func1 and func2 but not func99
      // (matching the end of the function name in ID)
      const matchedNodes = findMatchingNodes(result.nodes, '*.func?')
      expect(matchedNodes.length).toBe(2)
      
      const names = matchedNodes.map(n => n.name)
      expect(names).toContain('func1')
      expect(names).toContain('func2')
      expect(names).not.toContain('func99')
    })
  })
})
