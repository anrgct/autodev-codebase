/**
 * Base analyzer class for dependency analysis
 */

import Parser from 'web-tree-sitter'
import type { DependencyNode, DependencyEdge, ParseOutput } from '../models'

/**
 * Call information extracted from call expression nodes
 */
export interface CallInfo {
  name: string           // 方法名，如 "log"
  fullPath: string       // 完整路径，如 "console.log"
  isGlobalCall: boolean  // 是否全局直接调用
}

/**
 * Node types configuration for a language
 */
export interface NodeTypes {
  /** Function definition node types (e.g., function_definition) */
  functionTypes: Set<string>

  /** Class definition node types (e.g., class_definition) */
  classTypes: Set<string>

  /** Method definition node types (may be same as function) */
  methodTypes: Set<string>

  /** Call expression node types (e.g., call, call_expression) */
  callTypes: Set<string>

  /** Import statement node types */
  importTypes: Set<string>

  /** Identifier node type */
  identifierType: string

  /** File extensions */
  extensions: Set<string>
}

/**
 * Abstract base class for language-specific analyzers
 *
 * Subclasses must implement:
 * - getNodeTypes(): Return node type configuration for the language
 * - extractFunctionName(): Extract name from function/method nodes
 * - extractClassName(): Extract name from class nodes
 * - extractCallName(): Extract callee name from call nodes
 * - extractImports(): Extract import statements
 */
export abstract class BaseAnalyzer {
  protected filePath: string
  protected content: string
  protected repoPath: string
  protected lines: string[]
  protected parser: Parser
  protected nodeTypes: NodeTypes

  // Output
  protected nodes: Map<string, DependencyNode> = new Map()
  protected edges: DependencyEdge[] = []

  // Internal state
  protected importMap: Map<string, string> = new Map() // simpleName -> fullPath
  protected seenEdges: Set<string> = new Set()
  protected topLevelNodes: Map<string, DependencyNode> = new Map()

  constructor(
    filePath: string,
    content: string,
    repoPath: string,
    parser: Parser
  ) {
    this.filePath = filePath
    this.content = content
    this.repoPath = repoPath
    this.lines = content.split('\n')
    this.parser = parser
    this.nodeTypes = this.getNodeTypes()
  }

  // ═══════════════════════════════════════════════════════
  // Abstract methods - subclasses must implement
  // ═══════════════════════════════════════════════════════

  /** Return the node type configuration for this language */
  protected abstract getNodeTypes(): NodeTypes

  /** Extract function/method name from node */
  protected abstract extractFunctionName(node: Parser.SyntaxNode): string | null

  /** Extract class name from node */
  protected abstract extractClassName(node: Parser.SyntaxNode): string | null

  /** Extract callee name from call node */
  protected abstract extractCallName(node: Parser.SyntaxNode): string | null

  /** Extract import statements, populate this.importMap */
  protected abstract extractImports(root: Parser.SyntaxNode): void

  // ═══════════════════════════════════════════════════════
  // Optional override methods
  // ═══════════════════════════════════════════════════════

  /** Return language name for node.language field */
  protected getLanguageName(): string {
    return this.constructor.name.replace('Analyzer', '').toLowerCase()
  }

  /** Return file extensions for this language */
  protected getFileExtensions(): string[] {
    return Array.from(this.nodeTypes.extensions)
  }

  /** Whether to skip this node (e.g., private methods, test code) */
  protected shouldSkipNode(_node: Parser.SyntaxNode): boolean {
    return false
  }

  /** Get component type based on node type and context */
  protected getComponentType(
    node: Parser.SyntaxNode,
    inClass: boolean
  ): DependencyNode['componentType'] {
    if (this.nodeTypes.classTypes.has(node.type)) {
      return 'class'
    } else if (inClass) {
      return 'method'
    } else {
      return 'function'
    }
  }

  // ═══════════════════════════════════════════════════════
  // Main analysis entry point
  // ═══════════════════════════════════════════════════════

  async analyze(): Promise<ParseOutput> {
    try {
      const tree = this.parser.parse(this.content)
      const root = tree.rootNode

      // 1. Extract imports first (for resolution)
      this.extractImports(root)

      // 2. Extract nodes
      this.traverseForNodes(root, null)

      // 3. Extract call relationships
      this.traverseForCalls(root, null)

      return {
        nodes: Array.from(this.nodes.values()),
        edges: this.edges,
      }
    } catch (error) {
      console.error(`Error analyzing ${this.filePath}:`, error)
      return { nodes: [], edges: [] }
    }
  }

  // ═══════════════════════════════════════════════════════
  // Node traversal methods
  // ═══════════════════════════════════════════════════════

  protected traverseForNodes(
    node: Parser.SyntaxNode,
    currentClass: string | null
  ): void {
    const nt = this.nodeTypes

    // Check for class definitions
    if (nt.classTypes.has(node.type)) {
      const className = this.extractClassName(node)
      if (className && !this.shouldSkipNode(node)) {
        this.addClassNode(node, className)
        // Recursively process class internals
        for (const child of node.children) {
          this.traverseForNodes(child, className)
        }
      }
      return
    }

    // Check for function/method definitions
    if (nt.functionTypes.has(node.type) || nt.methodTypes.has(node.type)) {
      const funcName = this.extractFunctionName(node)
      if (funcName && !this.shouldSkipNode(node)) {
        if (currentClass) {
          this.addMethodNode(node, funcName, currentClass)
        } else {
          this.addFunctionNode(node, funcName)
        }
      }
    }

    // Recurse to children
    for (const child of node.children) {
      this.traverseForNodes(child, currentClass)
    }
  }

  protected traverseForCalls(
    node: Parser.SyntaxNode,
    currentFunc: string | null
  ): void {
    const nt = this.nodeTypes

    // Update current function context
    if (nt.functionTypes.has(node.type) || nt.methodTypes.has(node.type)) {
      const funcName = this.extractFunctionName(node)
      if (funcName) {
        currentFunc = this.findNodeIdByLine(node.startPosition.row + 1)
      }
    }

    // Extract calls
    if (nt.callTypes.has(node.type) && currentFunc) {
      const calleeInfo = this.extractCallInfo(node)
      if (calleeInfo) {
        // 使用 CallInfo 进行过滤判断
        if (!this.shouldFilterCall(node, calleeInfo)) {
          // 根据调用类型决定如何传递 callee 参数
          if (calleeInfo.isGlobalCall) {
            // 全局直接调用（如 setTimeout）：尝试用 importMap 解析
            this.addEdge(currentFunc, calleeInfo.name, node.startPosition.row + 1)
          } else {
            // 成员调用（如 console.log, myModule.doSomething）：直接使用完整路径
            this.addEdge(currentFunc, calleeInfo.fullPath, node.startPosition.row + 1)
          }
        }
      }
    }

    // Recurse to children
    for (const child of node.children) {
      this.traverseForCalls(child, currentFunc)
    }
  }

  // ═══════════════════════════════════════════════════════
  // Node creation methods
  // ═══════════════════════════════════════════════════════

  protected addClassNode(node: Parser.SyntaxNode, className: string): void {
    const nodeId = this.makeNodeId(className)
    const nodeObj: DependencyNode = {
      id: nodeId,
      name: className,
      componentType: 'class',
      filePath: this.filePath,
      relativePath: this.getRelativePath(),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      sourceCode: this.getSourceSegment(node),
      language: this.getLanguageName(),
      dependsOn: new Set(),
    }
    this.nodes.set(nodeId, nodeObj)
    this.topLevelNodes.set(nodeId, nodeObj)
  }

  protected addFunctionNode(node: Parser.SyntaxNode, funcName: string): void {
    const nodeId = this.makeNodeId(funcName)
    const nodeObj: DependencyNode = {
      id: nodeId,
      name: funcName,
      componentType: 'function',
      filePath: this.filePath,
      relativePath: this.getRelativePath(),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      sourceCode: this.getSourceSegment(node),
      parameters: this.extractParameters(node),
      language: this.getLanguageName(),
      dependsOn: new Set(),
    }
    this.nodes.set(nodeId, nodeObj)
    this.topLevelNodes.set(nodeId, nodeObj)
  }

  protected addMethodNode(
    node: Parser.SyntaxNode,
    methodName: string,
    className: string
  ): void {
    const nodeId = this.makeNodeId(methodName, className)
    const nodeObj: DependencyNode = {
      id: nodeId,
      name: methodName,
      componentType: 'method',
      filePath: this.filePath,
      relativePath: this.getRelativePath(),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      sourceCode: this.getSourceSegment(node),
      parameters: this.extractParameters(node),
      className,
      language: this.getLanguageName(),
      dependsOn: new Set(),
    }
    this.nodes.set(nodeId, nodeObj)
    this.topLevelNodes.set(nodeId, nodeObj)
  }

  protected addEdge(caller: string, calleeName: string, line: number): void {
    let resolved: string | undefined

    // 1. 尝试直接匹配（命名导入：import { foo } from './module'）
    resolved = this.importMap.get(calleeName)

    // 2. 尝试解析成员调用（通用处理所有 prefix.member 格式）
    if (!resolved) {
      const firstDot = calleeName.indexOf('.')
      if (firstDot !== -1) {
        const prefix = calleeName.slice(0, firstDot)
        const member = calleeName.slice(firstDot + 1)

        const modulePath = this.importMap.get(prefix)
        if (modulePath) {
          resolved = `${this.resolveModulePath(modulePath)}.${member}`
        }
      }
    }

    // 3. 回退：保持原样（交给 resolveEdges 处理）
    const finalCallee = resolved ?? calleeName

    const key = `${caller}:${finalCallee}:${line}`
    if (!this.seenEdges.has(key)) {
      this.seenEdges.add(key)
      this.edges.push({
        caller,
        callee: finalCallee,
        callLine: line,
        isResolved: false, // Will be resolved by graph.ts
        confidence: 1.0,
      })
    }
  }

  /**
   * 解析模块路径为相对于 repo 根目录的路径
   *
   * @example
   *   当前文件: src/main.ts
   *   modulePath: './utils/helper' → 'src/utils/helper'
   *   modulePath: '../lib/core'    → 'lib/core'
   */
  private resolveModulePath(modulePath: string): string {
    if (!modulePath.startsWith('.')) {
      // 非相对路径（npm 包等），保持原样
      return modulePath
    }

    // 获取当前文件所在目录
    const currentDir = this.getRelativePath().split('/').slice(0, -1)
    const parts = modulePath.split('/')

    const result: string[] = [...currentDir]

    for (const part of parts) {
      if (part === '.') continue
      if (part === '..') {
        result.pop()
      } else {
        result.push(part)
      }
    }

    return result.join('/')
  }

  // ═══════════════════════════════════════════════════════
  // Utility methods
  // ═══════════════════════════════════════════════════════

  protected getNodeText(node: Parser.SyntaxNode): string {
    return node.text
  }

  protected findChildByType(
    node: Parser.SyntaxNode,
    typeName: string
  ): Parser.SyntaxNode | null {
    for (const child of node.children) {
      if (child.type === typeName) {
        return child
      }
    }
    return null
  }

  protected findChildrenByType(
    node: Parser.SyntaxNode,
    typeName: string
  ): Parser.SyntaxNode[] {
    return node.children.filter(c => c.type === typeName)
  }

  /** Calculate module path (remove extension, normalize path separators to forward slashes) */
  protected getModulePath(): string {
    let relPath = this.getRelativePath()

    // Remove extension
    for (const ext of this.getFileExtensions()) {
      if (relPath.endsWith(ext)) {
        relPath = relPath.slice(0, -ext.length)
        break
      }
    }

    // Normalize path separators to forward slashes for cross-platform consistency
    return relPath.replace(/\\/g, '/')
  }

  /** Get relative path from repo root */
  protected getRelativePath(): string {
    if (this.repoPath && this.filePath.startsWith(this.repoPath)) {
      return this.filePath.slice(this.repoPath.length + 1)
    }
    return this.filePath
  }

  /** Generate node ID */
  protected makeNodeId(name: string, className?: string): string {
    const module = this.getModulePath()
    if (className) {
      return `${module}.${className}.${name}`
    }
    return `${module}.${name}`
  }

  /** Get source code segment for a node */
  protected getSourceSegment(node: Parser.SyntaxNode): string {
    const startLine = node.startPosition.row
    const endLine = node.endPosition.row + 1
    return this.lines.slice(startLine, endLine).join('\n')
  }

  /** Find node ID by line number */
  protected findNodeIdByLine(line: number): string | null {
    for (const [nodeId, node] of this.topLevelNodes) {
      if (node.startLine <= line && line <= node.endLine) {
        return nodeId
      }
    }
    return null
  }

  /** Extract function parameters (subclass can override) */
  protected extractParameters(node: Parser.SyntaxNode): string[] | undefined {
    const paramsNode =
      this.findChildByType(node, 'formal_parameters') ??
      this.findChildByType(node, 'parameters') ??
      this.findChildByType(node, 'parameter_list')

    if (!paramsNode) {
      return undefined
    }

    const params: string[] = []
    const identType = this.nodeTypes.identifierType

    for (const child of paramsNode.children) {
      if (child.type === identType) {
        params.push(this.getNodeText(child))
      } else if (['parameter', 'required_parameter', 'optional_parameter'].includes(child.type)) {
        const ident = this.findChildByType(child, identType)
        if (ident) {
          params.push(this.getNodeText(ident))
        }
      }
    }

    return params.length > 0 ? params : undefined
  }

  // ═══════════════════════════════════════════════════════
  // Builtin filtering methods
  // ═══════════════════════════════════════════════════════

  /** Return the set of global builtin functions for this language (subclass can override) */
  protected getGlobalBuiltins(): Set<string> {
    return new Set()
  }

  /** Return the set of member builtin calls for this language (subclass can override) */
  protected getMemberBuiltins(): Set<string> {
    return new Set()
  }

  /**
   * Extract call information from a call node
   * Supports both global calls (setTimeout) and member calls (console.log)
   */
  protected extractCallInfo(node: Parser.SyntaxNode): CallInfo | null {
    if (node.children.length === 0) return null

    const callee = node.children[0]

    // 全局直接调用: setTimeout()
    if (callee.type === this.nodeTypes.identifierType) {
      const name = this.getNodeText(callee)
      return {
        name,
        fullPath: name,
        isGlobalCall: true,
      }
    }

    // 成员调用: console.log(), JSON.parse()
    if (callee.type === 'member_expression') {
      const obj = this.findChildByType(callee, 'identifier')
      const prop = this.findChildByType(callee, 'property_identifier')

      if (prop) {
        const propName = this.getNodeText(prop)
        const objName = obj ? this.getNodeText(obj) : propName
        return {
          name: propName,
          fullPath: objName ? `${objName}.${propName}` : propName,
          isGlobalCall: false,
        }
      }
    }

    return null
  }

  /** Determine if a call should be filtered (is a global or member builtin) */
  protected shouldFilterCall(
    node: Parser.SyntaxNode,
    calleeInfo: CallInfo
  ): boolean {
    // 全局直接调用 - 使用 getGlobalBuiltins()
    if (calleeInfo.isGlobalCall) {
      return this.getGlobalBuiltins().has(calleeInfo.name)
    }

    // 成员调用 - 使用 getMemberBuiltins()，匹配完整路径
    return this.getMemberBuiltins().has(calleeInfo.fullPath)
  }
}
