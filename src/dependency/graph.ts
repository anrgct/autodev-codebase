/**
 * Graph building and analysis functions
 */

import type { DependencyNode, DependencyEdge } from './models'

// ═══════════════════════════════════════════════════════════════
// ID 解析辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 提取简单名称（函数名/方法名）
 * 
 * 新 ID 格式: path/to/module.Class.method
 * 
 * @example
 *   extractSimpleName("src/users/service.formatDate") → "formatDate"
 *   extractSimpleName("src/users/service.UserService.getUser") → "getUser"
 */
export function extractSimpleName(nodeId: string): string {
  const lastDotIndex = nodeId.lastIndexOf('.')
  return lastDotIndex === -1 ? nodeId : nodeId.slice(lastDotIndex + 1)
}

/**
 * 提取模块路径（不含类名和方法名）
 * 
 * 新 ID 格式: path/to/module.Class.method
 * 返回: path/to/module
 * 
 * @example
 *   extractModulePath("src/users/service.formatDate") → "src/users/service"
 *   extractModulePath("src/users/service.UserService.getUser") → "src/users/service"
 */
export function extractModulePath(nodeId: string): string {
  // 找到最后一个路径分隔符
  const lastSlashIndex = nodeId.lastIndexOf('/')
  if (lastSlashIndex === -1) {
    // 没有路径分隔符，可能是根目录下的文件
    // 再尝试找第一个点（去掉类名.方法名）
    const firstDotIndex = nodeId.indexOf('.')
    return firstDotIndex === -1 ? nodeId : nodeId.slice(0, firstDotIndex)
  }
  
  // 找到路径部分之后的第一个点（区分路径和 Class.method）
  const afterSlash = nodeId.slice(lastSlashIndex + 1)
  const firstDotIndex = afterSlash.indexOf('.')
  
  if (firstDotIndex === -1) {
    // 没有 Class.method 部分，整个就是路径
    return nodeId
  }
  
  // 返回路径部分 + 第一个点之前的内容（模块名）
  return nodeId.slice(0, lastSlashIndex + 1 + firstDotIndex)
}

// ═══════════════════════════════════════════════════════════════
// 模块距离算法
// ═══════════════════════════════════════════════════════════════

/**
 * 计算两个模块之间的距离
 *
 * 距离越小，匹配优先级越高
 *
 * 示例（新 ID 格式）:
 *   moduleDistance("utils/date", "utils/time") = 2  (兄弟)
 *   moduleDistance("utils", "utils/date") = 1       (父子)
 *   moduleDistance("utils/date", "api/handler") = 4 (远亲)
 *   moduleDistance("a/b/c", "a/b/c") = 0            (同模块)
 *
 * 算法:
 *   距离 = (A非公共部分长度) + (B非公共部分长度)
 */
export function moduleDistance(modA: string, modB: string): number {
  const partsA = modA ? modA.split('/') : []
  const partsB = modB ? modB.split('/') : []

  // 找公共前缀长度
  let common = 0
  for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
    if (partsA[i] === partsB[i]) {
      common++
    } else {
      break
    }
  }

  return (partsA.length - common) + (partsB.length - common)
}

// ═══════════════════════════════════════════════════════════════
// 智能边解析
// ═══════════════════════════════════════════════════════════════

/**
 * Layer 2: BUILD - 智能解析调用关系
 *
 * 解析策略 (按优先级):
 * 1. import 声明: callee 已由 parse 阶段通过 importMap 解析为完整路径 (最准确)
 * 2. 完全匹配: callee 已经是完整 ID 且存在于 nodes 中
 * 3. 同模块匹配: caller 和 callee 在同一模块
 * 4. 最近模块匹配: 按模块距离排序，选最近的 (兜底启发式)
 *
 * 置信度规则:
 * - import 解析 / 唯一匹配: 1.0
 * - 多候选匹配: 0.6
 * - 无法解析: 保留原样，标记 isResolved=false
 */
export function resolveEdges(
  nodes: Map<string, DependencyNode>,
  edges: DependencyEdge[]
): DependencyEdge[] {
  // 构建查找表: 简单名称 → [所有可能的完整 ID]
  const nameToIds = new Map<string, string[]>()
  for (const nodeId of nodes.keys()) {
    const simpleName = extractSimpleName(nodeId)
    const existing = nameToIds.get(simpleName) ?? []
    existing.push(nodeId)
    nameToIds.set(simpleName, existing)
  }

  const resolved: DependencyEdge[] = []

  for (const edge of edges) {
    // 策略1: 已经是完整 ID
    if (nodes.has(edge.callee)) {
      resolved.push({
        ...edge,
        isResolved: true,
        confidence: 1.0,
      })
      continue
    }

    // 获取候选列表
    const simpleName = extractSimpleName(edge.callee)
    const candidates = nameToIds.get(simpleName) ?? []

    if (candidates.length === 0) {
      // 无法解析 (外部调用如 console.log, print 等)
      resolved.push(edge)
      continue
    }

    // 获取 caller 的模块路径
    const callerModule = extractModulePath(edge.caller)

    // 策略2: 同模块优先
    // 在新 ID 格式中，同模块意味着路径部分相同
    const sameModule = candidates.filter(c => {
      const calleeModule = extractModulePath(c)
      return calleeModule === callerModule || c.startsWith(callerModule + '.')
    })
    
    if (sameModule.length === 1) {
      resolved.push({
        ...edge,
        callee: sameModule[0],
        isResolved: true,
        confidence: 1.0,
      })
      continue
    }

    // 策略3: 按模块距离排序
    const ranked = [...candidates].sort((a, b) => {
      const modA = extractModulePath(a)
      const modB = extractModulePath(b)
      return moduleDistance(callerModule, modA) - moduleDistance(callerModule, modB)
    })

    resolved.push({
      ...edge,
      callee: ranked[0],
      isResolved: true,
      confidence: candidates.length === 1 ? 1.0 : 0.6,
    })
  }

  return resolved
}

/**
 * 构建邻接表: nodeId → Set<依赖的 nodeIds>
 */
export function buildAdjacency(
  nodes: Map<string, DependencyNode>,
  edges: DependencyEdge[]
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()

  // 初始化所有节点
  for (const nodeId of nodes.keys()) {
    adj.set(nodeId, new Set())
  }

  for (const edge of edges) {
    if (edge.isResolved && adj.has(edge.caller) && nodes.has(edge.callee)) {
      adj.get(edge.caller)!.add(edge.callee)
    }
  }

  return adj
}

// ═══════════════════════════════════════════════════════════════
// Tarjan 算法 - 环检测
// ═══════════════════════════════════════════════════════════════

/**
 * Tarjan 算法检测强连通分量 (环)
 *
 * 时间复杂度: O(V + E)
 * 空间复杂度: O(V)
 *
 * @returns 环列表，每个环是节点 ID 列表 (只返回 size > 1 的 SCC)
 */
export function detectCycles(adj: Map<string, Set<string>>): string[][] {
  let indexCounter = 0
  const stack: string[] = []
  const lowlink = new Map<string, number>()
  const index = new Map<string, number>()
  const onStack = new Set<string>()
  const sccs: string[][] = []

  function strongconnect(v: string): void {
    index.set(v, indexCounter)
    lowlink.set(v, indexCounter)
    indexCounter++
    stack.push(v)
    onStack.add(v)

    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w)
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!))
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!))
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = []
      while (true) {
        const w = stack.pop()!
        onStack.delete(w)
        scc.push(w)
        if (w === v) break
      }
      if (scc.length > 1) {
        sccs.push(scc)
      }
    }
  }

  for (const v of adj.keys()) {
    if (!index.has(v)) {
      strongconnect(v)
    }
  }

  return sccs
}

// ═══════════════════════════════════════════════════════════════
// Kahn 算法 - 拓扑排序
// ═══════════════════════════════════════════════════════════════

/**
 * Kahn 算法拓扑排序
 *
 * 时间复杂度: O(V + E)
 *
 * @returns 拓扑排序后的节点 ID 列表 (依赖在前，被依赖在后)
 */
export function topologicalSort(adj: Map<string, Set<string>>): string[] {
  // 计算入度
  const inDegree = new Map<string, number>()
  for (const v of adj.keys()) {
    inDegree.set(v, 0)
  }
  for (const deps of adj.values()) {
    for (const w of deps) {
      if (inDegree.has(w)) {
        inDegree.set(w, inDegree.get(w)! + 1)
      }
    }
  }

  // 入度为 0 的节点入队
  const queue: string[] = []
  for (const [v, d] of inDegree) {
    if (d === 0) {
      queue.push(v)
    }
  }

  const result: string[] = []
  while (queue.length > 0) {
    const v = queue.shift()!
    result.push(v)
    for (const w of adj.get(v) ?? []) {
      if (inDegree.has(w)) {
        const newDegree = inDegree.get(w)! - 1
        inDegree.set(w, newDegree)
        if (newDegree === 0) {
          queue.push(w)
        }
      }
    }
  }

  return result
}

/**
 * 获取叶子节点 (不被任何其他节点依赖)
 *
 * 用途: 识别入口点、底层实现
 */
export function getLeafNodes(adj: Map<string, Set<string>>): string[] {
  const allCallees = new Set<string>()
  for (const deps of adj.values()) {
    for (const callee of deps) {
      allCallees.add(callee)
    }
  }

  return [...adj.keys()].filter(v => !allCallees.has(v))
}

// ═══════════════════════════════════════════════════════════════
// 统一构建入口
// ═══════════════════════════════════════════════════════════════

/**
 * Layer 2 + 3: BUILD + ANALYZE
 *
 * 完整流程:
 * 1. 解析边 (智能匹配)
 * 2. 去重
 * 3. 构建邻接表
 * 4. 环检测
 * 5. 拓扑排序
 * 6. 更新节点依赖
 */
export function buildGraph(
  nodes: Map<string, DependencyNode>,
  edges: DependencyEdge[]
): {
  adj: Map<string, Set<string>>
  resolvedEdges: DependencyEdge[]
  cycles: string[][]
  topoOrder: string[]
} {
  // 解析边
  const resolvedEdges = resolveEdges(nodes, edges)

  // 去重
  const seen = new Set<string>()
  const uniqueEdges: DependencyEdge[] = []
  for (const e of resolvedEdges) {
    const key = `${e.caller}:${e.callee}`
    if (!seen.has(key)) {
      seen.add(key)
      uniqueEdges.push(e)
    }
  }

  // 构建邻接表
  const adj = buildAdjacency(nodes, uniqueEdges)

  // 图分析
  const cycles = detectCycles(adj)
  const topoOrder = topologicalSort(adj)

  // 更新节点的 dependsOn
  for (const [nodeId, deps] of adj) {
    const node = nodes.get(nodeId)
    if (node) {
      node.dependsOn = deps
    }
  }

  return {
    adj,
    resolvedEdges: uniqueEdges,
    cycles,
    topoOrder,
  }
}
