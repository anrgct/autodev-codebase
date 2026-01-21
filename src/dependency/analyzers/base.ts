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
      // 0. Create module node for tracking top-level calls
      this.createModuleNode()

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

    // Extract calls - support top-level calls by using module node as caller
    if (nt.callTypes.has(node.type)) {
      const calleeInfo = this.extractCallInfo(node)
      if (calleeInfo) {
        // 使用 CallInfo 进行过滤判断
        if (!this.shouldFilterCall(node, calleeInfo)) {
          // Use currentFunc if inside a function, otherwise use module node ID
          const caller = currentFunc || this.getModuleNodeId()
          
          // 根据调用类型决定如何传递 callee 参数
          if (calleeInfo.isGlobalCall) {
            // 全局直接调用（如 setTimeout）：尝试用 importMap 解析
            this.addEdge(caller, calleeInfo.name, node.startPosition.row + 1)
          } else {
            // 成员调用（如 console.log, myModule.doSomething）：直接使用完整路径
            this.addEdge(caller, calleeInfo.fullPath, node.startPosition.row + 1)
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

  /**
   * Create a module node representing the file itself.
   * Used for tracking top-level calls that are not inside any function/class/method.
   */
  protected createModuleNode(): void {
    const moduleId = this.getModuleNodeId()
    
    // Get the file name without path
    const fileName = this.filePath.split('/').pop() || this.filePath
    
    // Remove file extension from name for consistency with other node types
    // (function/class/method names don't include extensions either)
    let moduleName = fileName
    for (const ext of this.getFileExtensions()) {
      if (fileName.endsWith(ext)) {
        moduleName = fileName.slice(0, -ext.length)
        break
      }
    }
    
    const moduleNode: DependencyNode = {
      id: moduleId,
      name: moduleName,
      componentType: 'module',
      filePath: this.filePath,
      relativePath: this.getRelativePath(),
      startLine: 1,
      endLine: this.lines.length,
      dependsOn: new Set(),
      language: this.getLanguageName(),
    }
    this.nodes.set(moduleId, moduleNode)
  }

  /**
   * Get the module node ID for this file.
   * Used when tracking top-level calls (where currentFunc is null).
   */
  protected getModuleNodeId(): string {
    return this.getModulePath()
  }

  protected addEdge(caller: string, calleeName: string, line: number): void {
    let resolved: string | undefined

    // 1. 尝试直接匹配（命名导入：import { foo } from './module'）
    const importPath = this.importMap.get(calleeName)
    if (importPath) {
      resolved = this.resolveModulePath(importPath)
    }

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
      // Remove repoPath prefix and skip the trailing separator
      const result = this.filePath.slice(this.repoPath.length + 1)
      return result.length > 0 ? result : this.filePath
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
   * 递归提取成员表达式的完整路径
   * 
   * @example
   *   api.client.fetch → "api.client.fetch"
   *   config.settings.get → "config.settings.get"
   *   console.log → "console.log"
   *   (utils.helper).process → "utils.helper.process"
   * 
   * @param node - member_expression, identifier, parenthesized_expression, 或 call_expression 节点
   * @returns 完整的点分隔路径
   * 
   * @remarks
   * **Tree-sitter 版本**: web-tree-sitter@0.23.0, tree-sitter-typescript
   * 
   * **关键行为说明**:
   * 
   * 1. **括号表达式的 AST 行为**（重要）:
   *    - 表达式 `(utils.helper).process()` 在 Tree-sitter TypeScript grammar 中：
   *      - `(utils.helper)` 被解析为 `call_expression`（而非 `parenthesized_expression`）
   *      - 这是 TypeScript grammar 的设计：任何 `(...)` 形式的表达式如果是"可调用"的，
   *        会被识别为 `call_expression`，即使括号内没有实际的调用
   *    - 因此我们处理 `call_expression` 类型时，提取其 `function` 字段（callee）
   * 
   * 2. **parenthesized_expression 分支的用途**:
   *    - 虽然当前 Tree-sitter 版本不触发此分支，但保留它以：
   *      a) 应对未来 Tree-sitter 版本可能的 AST 结构变化
   *      b) 支持其他可能使用 `parenthesized_expression` 的语言
   *      c) 处理多层括号 `((utils.helper)).process()` 的边界情况
   * 
   * 3. **API 使用策略**:
   *    - 使用 `childForFieldName('object')` 而非 `children[0]`
   *    - 原因：准确获取语义字段，避免获取到非语义节点（如括号、运算符）
   *    - 这在处理复杂表达式（如带括号的表达式）时更安全
   * 
   * **已知限制**:
   * - 不支持可选链 `api?.client?.fetch()`（需要单独处理 `chaining_expression`）
   * - 不支持动态属性访问 `obj[key]()`（静态分析限制）
   * - 不支持链式方法调用返回值 `getApi().client.fetch()`（需要类型推断）
   */
  private extractMemberPath(node: Parser.SyntaxNode): string {
    // 基础情况：直接是 identifier
    if (node.type === this.nodeTypes.identifierType) {
      return this.getNodeText(node)
    }
    
    // 处理 this 关键字
    if (node.type === 'this') {
      return 'this'
    }
    
    // 处理括号表达式：跳过括号，直接处理内部表达式
    if (node.type === 'parenthesized_expression') {
      // 使用 namedChildren 只获取语义上有意义的节点（跳过括号等标点符号）
      const namedChildren = node.namedChildren
      if (namedChildren.length > 0) {
        return this.extractMemberPath(namedChildren[0])
      }
      return ''
    }
    
    // 处理调用表达式：提取 callee（被调用的函数表达式）
    // 例如：(utils.helper).process() 中的 (utils.helper) 被识别为 call_expression
    // 例如：new TextDecoder().decode() 中的 new TextDecoder() 被识别为 new_expression
    if (node.type === 'call_expression' || node.type === 'new_expression') {
      // call_expression 使用 'function' 字段，new_expression 使用 'constructor' 字段
      const calleeFieldName = node.type === 'new_expression' ? 'constructor' : 'function'
      const callee = node.childForFieldName(calleeFieldName)
      if (callee) {
        return this.extractMemberPath(callee)
      }
      return ''
    }
    
    // 递归情况：member_expression
    if (node.type === 'member_expression') {
      // 使用 childForFieldName 获取语义字段（更安全）
      const object = node.childForFieldName('object')
      const property = node.childForFieldName('property')
      
      if (!object) return ''
      
      const objectPath = this.extractMemberPath(object)  // 递归提取对象路径
      const propertyText = property ? this.getNodeText(property) : ''
      
      return propertyText ? `${objectPath}.${propertyText}` : objectPath
    }
    
    return ''
  }

  /**
   * Extract call information from a call node
   * Supports both global calls (setTimeout) and member calls (console.log, api.client.fetch)
   * Also supports new expressions (new UserManager())
   */
  protected extractCallInfo(node: Parser.SyntaxNode): CallInfo | null {
    if (node.children.length === 0) return null

    // Handle new_expression: new UserManager()
    // In new_expression, the constructor is in the 'constructor' field
    let callee: Parser.SyntaxNode
    if (node.type === 'new_expression') {
      const constructorNode = node.childForFieldName('constructor')
      if (!constructorNode) return null
      callee = constructorNode
    } else {
      // For call_expression, the callee is the first child
      callee = node.children[0]
    }

    // 全局直接调用: setTimeout(), new UserManager()
    if (callee.type === this.nodeTypes.identifierType) {
      const name = this.getNodeText(callee)
      return {
        name,
        fullPath: name,
        isGlobalCall: true,
      }
    }

    // 成员调用（支持嵌套）: console.log(), api.client.fetch()
    if (callee.type === 'member_expression') {
      const fullPath = this.extractMemberPath(callee)  // 递归提取完整路径
      const parts = fullPath.split('.')
      const name = parts[parts.length - 1]  // 最后一段是方法名
      
      return {
        name,
        fullPath,
        isGlobalCall: false,
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
