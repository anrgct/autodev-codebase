/**
 * Query utilities for dependency analysis
 *
 * Provides functionality to:
 * - Find nodes matching patterns (wildcards, comma-separated)
 * - Build bidirectional dependency trees
 * - Analyze connections between multiple functions
 */

import type { DependencyNode, DependencyEdge, DependencyResult } from './models'

// ═══════════════════════════════════════════════════════════════
// Type Definitions
// ═══════════════════════════════════════════════════════════════

/**
 * Query options
 */
export interface QueryOptions {
  /** Maximum traversal depth */
  depth: number
}

/**
 * Single node query result
 */
export interface NodeQueryResult {
  /** The matched node */
  node: DependencyNode
  /** Functions called by this node (callee tree) */
  callees: TreeNode[]
  /** Functions that call this node (caller tree) */
  callers: TreeNode[]
}

/**
 * Tree node for hierarchical dependency display
 */
export interface TreeNode {
  /** Node ID */
  id: string
  /** Node name */
  name: string
  /** File path */
  filePath: string
  /** Start line number */
  line: number
  /** End line number */
  endLine: number
  /** Depth level */
  depth: number
  /** Child nodes */
  children: TreeNode[]
}

/**
 * Multi-function connection analysis result
 */
export interface ConnectionAnalysisResult {
  /** Names being queried */
  queryNames: string[]
  /** Matched nodes */
  matchedNodes: DependencyNode[]
  /** Direct connections between queried functions */
  directConnections: DirectConnection[]
  /** Chains connecting queried functions */
  chains: Chain[]
  /** All nodes involved in connections */
  involvedNodes: DependencyNode[]
}

/**
 * Direct connection between two nodes
 */
export interface DirectConnection {
  /** Source node ID */
  from: string
  /** Target node ID */
  to: string
  /** Connection type */
  type: 'direct'
}

/**
 * Chain of connections
 */
export interface Chain {
  /** Ordered list of node IDs in the chain */
  path: string[]
  /** Chain length */
  length: number
}

// ═══════════════════════════════════════════════════════════════
// Pattern Matching
// ═══════════════════════════════════════════════════════════════

/**
 * Convert glob pattern to RegExp
 * Supports: * (any characters), ? (single character)
 */
function globToRegex(glob: string): RegExp {
  const regexString = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${regexString}$`, 'i')
}

/**
 * Test if a node matches a pattern (ID-only matching for simplicity)
 * 
 * All patterns match against node.id, which has the format:
 *   "{relativePath}.{className}.{methodName}"
 *   Examples:
 *     - "analyzers/base.BaseAnalyzer.getMemberBuiltins"
 *     - "parse.parseFile"
 *     - "parse.ParserCache.get"
 * 
 * @param node - Dependency node to match
 * @param pattern - Pattern string (supports wildcards)
 * @returns True if node ID matches the pattern
 */
function matchesPattern(node: DependencyNode, pattern: string): boolean {
  // Support wildcards - always match against ID
  if (pattern.includes('*') || pattern.includes('?')) {
    const regex = globToRegex(pattern)
    return regex.test(node.id)
  }

  // Case-insensitive exact match: try ID first, then name as fallback
  return node.id.toLowerCase() === pattern.toLowerCase() ||
         node.name.toLowerCase() === pattern.toLowerCase()
}

/**
 * Find nodes matching query patterns
 *
 * @param nodes - Node map to search
 * @param query - Comma-separated patterns or single pattern
 * @returns Array of matching nodes
 */
export function findMatchingNodes(
  nodes: Map<string, DependencyNode>,
  query: string
): DependencyNode[] {
  const patterns = query.split(',').map(p => p.trim()).filter(p => p.length > 0)
  const matched = new Set<DependencyNode>()

  for (const node of nodes.values()) {
    for (const pattern of patterns) {
      if (matchesPattern(node, pattern)) {
        matched.add(node)
        break
      }
    }
  }

  const results = Array.from(matched)
  
  // Smart hints for common wildcard mistakes
  if (results.length === 0) {
    for (const pattern of patterns) {
      // Check if it's a prefix wildcard (e.g., "get*", "parse*")
      if (pattern.match(/^\w+\*$/) && !pattern.includes('/') && pattern.split('.').length < 2) {
        const baseName = pattern.slice(0, -1)
        console.warn(`\n💡 No results found for "${pattern}"`)
        console.warn(`   Hint: "${pattern}" matches the START of IDs (e.g., "get" won't match "analyzers/...getUser")`)
        console.warn(`   Suggestions:`)
        console.warn(`     - Match method suffix:    "*${baseName}"`)
        console.warn(`     - Match class methods:   "*.*.${baseName}*"` )
        console.warn(`     - Match containing text: "*${baseName}*"\n`)
        break
      }
    }
  }

  return results
}

// ═══════════════════════════════════════════════════════════════
// Bidirectional Dependency Tree
// ═══════════════════════════════════════════════════════════════

/**
 * Build callee tree (functions called by target node)
 */
function buildCalleeTree(
  nodes: Map<string, DependencyNode>,
  rootNode: DependencyNode,
  visited: Set<string>,
  currentDepth: number,
  maxDepth: number
): TreeNode[] {
  if (currentDepth >= maxDepth || visited.has(rootNode.id)) {
    return []
  }

  visited.add(rootNode.id)
  const children: TreeNode[] = []

  for (const depId of rootNode.dependsOn) {
    const depNode = nodes.get(depId)
    if (!depNode) continue

    const treeNode: TreeNode = {
      id: depNode.id,
      name: depNode.name,
      filePath: depNode.filePath,
      line: depNode.startLine,
      endLine: depNode.endLine,
      depth: currentDepth,
      children: buildCalleeTree(nodes, depNode, visited, currentDepth + 1, maxDepth)
    }

    children.push(treeNode)
  }

  return children
}

/**
 * Build caller tree (functions that call target node)
 */
function buildCallerTree(
  nodes: Map<string, DependencyNode>,
  targetNodeId: string,
  visited: Set<string>,
  currentDepth: number,
  maxDepth: number
): TreeNode[] {
  if (currentDepth >= maxDepth || visited.has(targetNodeId)) {
    return []
  }

  visited.add(targetNodeId)
  const children: TreeNode[] = []

  // Find all nodes that depend on the target node
  for (const node of nodes.values()) {
    if (node.dependsOn.has(targetNodeId)) {
      const treeNode: TreeNode = {
        id: node.id,
        name: node.name,
        filePath: node.filePath,
        line: node.startLine,
        endLine: node.endLine,
        depth: currentDepth,
        children: buildCallerTree(nodes, node.id, visited, currentDepth + 1, maxDepth)
      }

      children.push(treeNode)
    }
  }

  return children
}

/**
 * Query a single node's dependencies (bidirectional tree)
 *
 * @param nodes - Node map
 * @param node - Node to query
 * @param options - Query options
 * @returns Query result with callee and caller trees
 */
export function queryNode(
  nodes: Map<string, DependencyNode>,
  node: DependencyNode,
  options: QueryOptions
): NodeQueryResult {
  // Build callee tree
  const calleeVisited = new Set<string>()
  const callees = buildCalleeTree(nodes, node, calleeVisited, 0, options.depth)

  // Build caller tree
  const callerVisited = new Set<string>()
  const callers = buildCallerTree(nodes, node.id, callerVisited, 0, options.depth)

  return {
    node,
    callees,
    callers
  }
}

// ═══════════════════════════════════════════════════════════════
// Multi-Function Connection Analysis
// ═══════════════════════════════════════════════════════════════

/**
 * Build adjacency list from nodes
 */
function buildAdjacency(nodes: Map<string, DependencyNode>): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()

  for (const [id, node] of nodes) {
    adj.set(id, new Set(node.dependsOn))
  }

  return adj
}

/**
 * Find direct connections between queried nodes
 */
function findDirectConnections(
  matchedNodes: DependencyNode[],
  adj: Map<string, Set<string>>
): DirectConnection[] {
  const matchedIds = new Set(matchedNodes.map(n => n.id))
  const connections: DirectConnection[] = []

  for (const node of matchedNodes) {
    for (const depId of node.dependsOn) {
      if (matchedIds.has(depId)) {
        connections.push({
          from: node.id,
          to: depId,
          type: 'direct'
        })
      }
    }
  }

  return connections
}

/**
 * BFS to find shortest path between two nodes
 */
function findShortestPath(
  adj: Map<string, Set<string>>,
  startId: string,
  endId: string,
  maxLength: number
): string[] | null {
  if (startId === endId) {
    return [startId]
  }

  const queue: Array<{ nodeId: string; path: string[] }> = [{ nodeId: startId, path: [startId] }]
  const visited = new Set<string>([startId])

  while (queue.length > 0) {
    const { nodeId, path } = queue.shift()!

    if (path.length > maxLength) {
      continue
    }

    const neighbors = adj.get(nodeId) || new Set()
    for (const neighbor of neighbors) {
      if (neighbor === endId) {
        return [...path, neighbor]
      }

      if (!visited.has(neighbor)) {
        visited.add(neighbor)
        queue.push({ nodeId: neighbor, path: [...path, neighbor] })
      }
    }
  }

  return null
}

/**
 * Find all chains connecting queried nodes
 */
function findChains(
  matchedNodes: DependencyNode[],
  adj: Map<string, Set<string>>,
  maxDepth: number
): Chain[] {
  const chains: Chain[] = []
  const n = matchedNodes.length

  // Find paths between all pairs
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const path = findShortestPath(adj, matchedNodes[i].id, matchedNodes[j].id, maxDepth)
      if (path && path.length > 1) {
        chains.push({
          path,
          length: path.length
        })
      }
    }
  }

  // Sort by length
  return chains.sort((a, b) => a.length - b.length)
}

/**
 * Analyze connections between multiple functions
 *
 * @param nodes - Node map
 * @param query - Comma-separated function names/patterns
 * @param maxDepth - Maximum depth for path finding
 * @returns Connection analysis result
 */
export function analyzeConnections(
  nodes: Map<string, DependencyNode>,
  query: string,
  maxDepth: number
): ConnectionAnalysisResult {
  // Find matching nodes
  const matchedNodes = findMatchingNodes(nodes, query)

  if (matchedNodes.length === 0) {
    return {
      queryNames: query.split(',').map(p => p.trim()),
      matchedNodes: [],
      directConnections: [],
      chains: [],
      involvedNodes: []
    }
  }

  // Build adjacency
  const adj = buildAdjacency(nodes)

  // Find direct connections
  const directConnections = findDirectConnections(matchedNodes, adj)

  // Find chains
  const chains = findChains(matchedNodes, adj, maxDepth)

  // Collect all involved nodes
  const involvedIds = new Set<string>()
  for (const conn of directConnections) {
    involvedIds.add(conn.from)
    involvedIds.add(conn.to)
  }
  for (const chain of chains) {
    for (const id of chain.path) {
      involvedIds.add(id)
    }
  }

  const involvedNodes = Array.from(involvedIds)
    .map(id => nodes.get(id))
    .filter((n): n is DependencyNode => n !== undefined)

  return {
    queryNames: query.split(',').map(p => p.trim()),
    matchedNodes,
    directConnections,
    chains,
    involvedNodes
  }
}

// ═══════════════════════════════════════════════════════════════
// Tree Formatting
// ═══════════════════════════════════════════════════════════════

/**
 * Format tree node with indentation
 */
function formatTreeNode(node: TreeNode, prefix: string, isLast: boolean, output: string[]): void {
  const connector = isLast ? '└──' : '├──'
  const lineRange = node.line === node.endLine 
    ? `L${node.line}` 
    : `L${node.line}-${node.endLine}`
  output.push(`${prefix}${connector} ${node.id}:${lineRange}`)

  const childPrefix = prefix + (isLast ? '    ' : '│   ')
  const children = node.children

  for (let i = 0; i < children.length; i++) {
    formatTreeNode(children[i], childPrefix, i === children.length - 1, output)
  }
}

/**
 * Format node query result as text
 */
export function formatNodeQueryResult(result: NodeQueryResult): string[] {
  const output: string[] = []

  // Header - show ID with line range
  const lineRange = result.node.startLine === result.node.endLine
    ? `L${result.node.startLine}`
    : `L${result.node.startLine}-${result.node.endLine}`
  output.push(`${result.node.id}:${lineRange}`)
  output.push('')

  // Callees
  if (result.callees.length > 0) {
    output.push('  ↓ calls (callee)')
    for (let i = 0; i < result.callees.length; i++) {
      formatTreeNode(result.callees[i], '  ', i === result.callees.length - 1, output)
    }
    output.push('')
  } else {
    output.push('  ↓ calls (callee)')
    output.push('    (none)')
    output.push('')
  }

  // Callers
  if (result.callers.length > 0) {
    output.push('  ↑ called by (caller)')
    for (let i = 0; i < result.callers.length; i++) {
      formatTreeNode(result.callers[i], '  ', i === result.callers.length - 1, output)
    }
  } else {
    output.push('  ↑ called by (caller)')
    output.push('    (none)')
  }

  return output
}

/**
 * Format connection analysis result as text
 */
export function formatConnectionAnalysisResult(result: ConnectionAnalysisResult): string[] {
  const output: string[] = []

  // Header
  output.push(`Connections between ${result.queryNames.join(', ')}:`)
  output.push('')

  // Matched nodes - show ID with line range
  if (result.matchedNodes.length > 0) {
    output.push(`Found ${result.matchedNodes.length} matching node(s):`)
    for (const node of result.matchedNodes) {
      const lineRange = node.startLine === node.endLine
        ? `L${node.startLine}`
        : `L${node.startLine}-${node.endLine}`
      output.push(`  - ${node.id}:${lineRange}`)
    }
    output.push('')
  } else {
    output.push('No matching nodes found.')
    return output
  }

  // Direct connections - use ID with line range
  if (result.directConnections.length > 0) {
    output.push('Direct connections:')
    const nodeMap = new Map(result.involvedNodes.map(n => [n.id, n]))
    for (const conn of result.directConnections) {
      const fromNode = nodeMap.get(conn.from)
      const toNode = nodeMap.get(conn.to)
      const fromRange = fromNode 
        ? (fromNode.startLine === fromNode.endLine ? `L${fromNode.startLine}` : `L${fromNode.startLine}-${fromNode.endLine}`)
        : 'L0'
      const toRange = toNode
        ? (toNode.startLine === toNode.endLine ? `L${toNode.startLine}` : `L${toNode.startLine}-${toNode.endLine}`)
        : 'L0'
      output.push(`  - ${conn.from}:${fromRange} → ${conn.to}:${toRange}`)
    }
    output.push('')
  } else {
    output.push('Direct connections:')
    output.push('  (none)')
    output.push('')
  }

  // Chains - use ID with line range
  if (result.chains.length > 0) {
    output.push('Chains found:')
    const nodeMap = new Map(result.involvedNodes.map(n => [n.id, n]))
    for (const chain of result.chains.slice(0, 10)) { // Limit to 10 chains
      const pathWithRanges = chain.path.map(id => {
        const node = nodeMap.get(id)
        const range = node
          ? (node.startLine === node.endLine ? `L${node.startLine}` : `L${node.startLine}-${node.endLine}`)
          : 'L0'
        return `${id}:${range}`
      })
      output.push(`  - ${pathWithRanges.join(' → ')}`)
    }
    if (result.chains.length > 10) {
      output.push(`  ... and ${result.chains.length - 10} more`)
    }
  } else {
    output.push('Chains found:')
    output.push('  (none)')
  }

  return output
}
