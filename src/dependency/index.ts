/**
 * Mini Dependency Analyzer
 *
 * 用最少的代码解决依赖分析问题
 * 独立管理 tree-sitter Parser，复用现有 WASM 文件
 */
import type { IFileSystem } from '../abstractions/core'
import type { IPathUtils } from '../abstractions/workspace'
import type {
  DependencyNode,
  DependencyEdge,
  DependencyResult,
  DependencySummary,
  FileParseResult,
} from './models'
import { parseDirectory, parseFile, loadLanguageParser } from './parse'
import { buildGraph, moduleDistance, detectCycles, topologicalSort, getLeafNodes } from './graph'

export type { DependencyNode, DependencyEdge, DependencyResult, DependencySummary }

export { parseDirectory } from './parse'
export { buildGraph, moduleDistance, detectCycles, topologicalSort, getLeafNodes } from './graph'
export * from './analyzers'

/**
 * 语言扩展名映射（从文件路径推断语言）
 */
export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  '.py': 'python',
  '.js': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.jsx': 'javascript',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.cs': 'csharp',
}

/**
 * 依赖注入接口
 */
export interface DependencyAnalyzerDeps {
  fileSystem: IFileSystem
  pathUtils: IPathUtils
}

/**
 * 主入口：分析代码依赖（自动支持文件和目录）
 *
 * 支持语言: TypeScript, JavaScript, Python, Java, C, C++, C#, Rust, Go
 *
 * @param targetPath 文件或目录路径
 * @param deps 依赖注入
 * @param maxFiles 最大分析文件数
 * @returns 依赖分析结果
 *
 * @example
 * ```typescript
 * const deps = { fileSystem, pathUtils }
 * // 分析目录
 * const dirResult = await analyze('/path/to/project', deps)
 * // 分析单个文件
 * const fileResult = await analyze('/path/to/file.ts', deps)
 * console.log(`发现 ${fileResult.summary.totalNodes} 个组件`)
 * ```
 */
export async function analyze(
  targetPath: string,
  deps: DependencyAnalyzerDeps,
  maxFiles: number = 100
): Promise<DependencyResult> {
  const { fileSystem, pathUtils } = deps

  // 判断是文件还是目录
  const stat = await fileSystem.stat(targetPath)
  const isTargetFile = stat?.isFile ?? false

  // Layer 1: PARSE
  let parseResults: FileParseResult[]
  let repoPath: string

  if (isTargetFile) {
    // 单文件模式
    const fileResult = await parseFile(targetPath, fileSystem, pathUtils)
    parseResults = [fileResult]
    repoPath = pathUtils.dirname(targetPath)
  } else {
    // 目录模式
    parseResults = await parseDirectory(
      targetPath,
      fileSystem,
      pathUtils,
      { includeNodeModules: false, includeTests: false, maxDepth: 10, followSymlinks: true } as any
    )
    repoPath = targetPath
  }

  // 统一的后处理流程
  const nodesMap = new Map<string, DependencyNode>()
  const edges: DependencyEdge[] = []
  const errors: string[] = []
  const files = new Set<string>()
  const languages = new Set<string>()

  for (const parseResult of parseResults) {
    // 收集文件路径和语言统计
    files.add(parseResult.filePath)
    if (parseResult.language) {
      languages.add(parseResult.language)
    }

    if (!parseResult.success && parseResult.error) {
      errors.push(`${parseResult.filePath}: ${parseResult.error}`)
      continue
    }

    // 获取对应语言的分析器
    const { getAnalyzer } = await import('./analyzers')
    const AnalyzerClass = getAnalyzer(parseResult.filePath)

    if (!AnalyzerClass) {
      // 无分析器时创建文件节点作为后备
      const fileNode: DependencyNode = {
        id: parseResult.filePath,
        name: pathUtils.basename(parseResult.filePath),
        componentType: 'module',
        filePath: parseResult.filePath,
        relativePath: parseResult.filePath.replace(repoPath, '').replace(/^\//, ''),
        startLine: 1,
        endLine: parseResult.content.split('\n').length,
        dependsOn: new Set(),
        language: parseResult.language,
      }
      nodesMap.set(fileNode.id, fileNode)
      continue
    }

    try {
      // 加载语言解析器
      const parserResult = await loadLanguageParser(
        parseResult.filePath,
        fileSystem,
        pathUtils
      )

      if (!parserResult) {
        continue
      }

      // 创建分析器并提取节点和边
      const analyzer = new AnalyzerClass!(
        parseResult.filePath,
        parseResult.content,
        repoPath,
        parserResult.parser
      )

      const analyzeOutput = await analyzer!.analyze()

      // 收集节点和边
      for (const node of analyzeOutput.nodes) {
        nodesMap.set(node.id, node)
      }
      for (const edge of analyzeOutput.edges) {
        edges.push(edge)
      }
    } catch (error) {
      // 忽略解析失败的文件
    }
  }

  // Layer 2+3: BUILD + ANALYZE
  const { resolvedEdges, cycles, topoOrder } = buildGraph(nodesMap, edges)

  // 统计
  const summary: DependencySummary = {
    totalFiles: files.size,
    totalNodes: nodesMap.size,
    totalRelationships: resolvedEdges.length,
    languages: Array.from(languages),
  }

  return {
    nodes: nodesMap,
    relationships: resolvedEdges,
    summary,
    cycles,
    topoOrder,
    errors: errors.length > 0 ? errors : undefined,
  }
}

/**
 * 便捷方法：分析单个文件（向后兼容）
 *
 * @deprecated 使用 analyze() 代替，analyze() 已自动支持文件和目录
 */
export async function analyzeFile(
  filePath: string,
  deps: DependencyAnalyzerDeps
): Promise<DependencyResult> {
  return analyze(filePath, deps)
}

// ═══════════════════════════════════════════════════════════════
// 纯函数：生成可视化数据
// ═══════════════════════════════════════════════════════════════

/**
 * Cytoscape.js 可视化数据接口
 */
export interface VisualizationData {
  cytoscape: {
    elements: Array<{
      data: Record<string, any>
      classes?: string
    }>
  }
  summary: {
    total_nodes: number
    total_edges: number
    unresolved_edges: number
    languages: string[]
    component_types: Record<string, number>
  }
}

/**
 * 生成 Cytoscape.js 可视化数据
 *
 * 将依赖分析结果转换为 Cytoscape.js 兼容的图数据格式
 *
 * @param nodes 节点映射
 * @param relationships 关系列表
 * @param summary 统计摘要（可选，用于补充信息）
 * @returns Cytoscape.js 兼容的图数据
 *
 * @example
 * ```typescript
 * import { analyze, generateVisualizationData } from './dependency'
 *
 * const result = await analyze('/path/to/project', deps)
 * const viz = generateVisualizationData(result.nodes, result.relationships)
 *
 * // 在前端使用
 * cytoscape(viz.cytoscape)
 * ```
 */
export function generateVisualizationData(
  nodes: Map<string, DependencyNode>,
  relationships: DependencyEdge[],
  summary?: DependencySummary
): VisualizationData {
  const cytoscape_elements: Array<{ data: Record<string, any>; classes?: string }> = []

  // 统计信息
  const languagesSet = new Set<string>()
  const componentTypesMap = new Map<string, number>()
  let unresolvedEdges = 0

  // ─────────────────────────────────────
  // 1. 生成节点
  // ─────────────────────────────────────
  for (const [nodeId, node] of nodes.entries()) {
    const nodeClasses: string[] = []

    // 组件类型样式
    nodeClasses.push(`node-${node.componentType}`)

    // 语言样式（从文件扩展名推断）
    const fileExt = node.filePath ? '.' + node.filePath.split('.').pop() : ''
    const language = LANGUAGE_EXTENSIONS[fileExt] || node.language || 'unknown'
    nodeClasses.push(`lang-${language}`)

    // 统计
    if (node.language) {
      languagesSet.add(node.language)
    }
    componentTypesMap.set(
      node.componentType,
      (componentTypesMap.get(node.componentType) || 0) + 1
    )

    cytoscape_elements.push({
      data: {
        id: nodeId,
        label: node.name,
        file: node.filePath,
        type: node.componentType,
        language: language,
        startLine: node.startLine,
        endLine: node.endLine,
        className: node.className,
      },
      classes: nodeClasses.join(' '),
    })
  }

  // ─────────────────────────────────────
  // 2. 生成边
  // ─────────────────────────────────────
  for (const rel of relationships) {
    if (!rel.isResolved) {
      unresolvedEdges++
      continue  // 跳过未解析的边
    }

    cytoscape_elements.push({
      data: {
        id: `${rel.caller}->${rel.callee}`,
        source: rel.caller,
        target: rel.callee,
        line: rel.callLine,
        confidence: rel.confidence,
      },
      classes: 'edge-call',
    })
  }

  // ─────────────────────────────────────
  // 3. 生成摘要
  // ─────────────────────────────────────
  const componentTypes: Record<string, number> = {}
  for (const [type, count] of componentTypesMap.entries()) {
    componentTypes[type] = count
  }

  return {
    cytoscape: { elements: cytoscape_elements },
    summary: {
      total_nodes: nodes.size,
      total_edges: cytoscape_elements.filter(el => el.classes === 'edge-call').length,
      unresolved_edges: unresolvedEdges,
      languages: Array.from(languagesSet),
      component_types: componentTypes,
    },
  }
}

// ═══════════════════════════════════════════════════════════════
// 兼容层：Service 风格 API
// ═══════════════════════════════════════════════════════════════

/**
 * 依赖分析服务
 *
 * 提供 Service 风格的 API，方便集成
 */
export class DependencyAnalysisService {
  constructor(private deps: DependencyAnalyzerDeps) {}

  /**
   * 分析本地仓库
   */
  async analyzeLocalRepository(
    repoPath: string,
    options: {
      maxFiles?: number
      languages?: string[] // 未来扩展：按语言过滤
    } = {}
  ): Promise<{
    nodes: Record<string, DependencyNode>
    relationships: DependencyEdge[]
    summary: DependencySummary
  }> {
    const result = await analyze(repoPath, this.deps, options.maxFiles)

    // 转换为 Record 格式（兼容旧 API）
    const nodesRecord: Record<string, DependencyNode> = {}
    for (const [id, node] of Array.from(result.nodes.entries())) {
      nodesRecord[node.componentId ?? id] = node
    }

    return {
      nodes: nodesRecord,
      relationships: result.relationships,
      summary: result.summary,
    }
  }
}