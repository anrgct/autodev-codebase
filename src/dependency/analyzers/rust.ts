/**
 * Rust analyzer
 * Supports Rust files (.rs)
 */

import Parser from 'web-tree-sitter'
import { BaseAnalyzer, NodeTypes } from './base'
import type { DependencyNode } from '../models'

export class RustAnalyzer extends BaseAnalyzer {

  private static readonly GLOBAL_BUILTINS = new Set([
    // Rust 宏调用（以 ! 结尾）通常不会匹配到 identifier
    // 这里主要过滤普通函数形式的内置函数
  ])

  protected getNodeTypes(): NodeTypes {
    return {
      functionTypes: new Set(['function_item']),
      classTypes: new Set([
        'struct_item',
        'enum_item',
        'trait_item',
        'impl_item',
      ]),
      methodTypes: new Set(['function_item']), // fn inside impl
      callTypes: new Set(['call_expression', 'macro_invocation']),
      importTypes: new Set(['use_declaration']),
      identifierType: 'identifier',
      extensions: new Set(['.rs']),
    }
  }

  protected extractFunctionName(node: Parser.SyntaxNode): string | null {
    const nameNode = this.findChildByType(node, 'identifier')
    return nameNode ? this.getNodeText(nameNode) : null
  }

  protected extractClassName(node: Parser.SyntaxNode): string | null {
    const nameNode = this.findChildByType(node, 'type_identifier')
    return nameNode ? this.getNodeText(nameNode) : null
  }

  protected extractCallName(node: Parser.SyntaxNode): string | null {
    if (node.children.length === 0) return null

    const callee = node.children[0]

    // Direct call
    if (callee.type === 'identifier') {
      return this.getNodeText(callee)
    }

    // Method call foo.bar()
    if (callee.type === 'field_expression') {
      const field = this.findChildByType(callee, 'field_identifier')
      return field ? this.getNodeText(field) : null
    }

    // Macro call println!
    if (node.type === 'macro_invocation') {
      const macroName = this.findChildByType(node, 'identifier')
      return macroName ? this.getNodeText(macroName) : null
    }

    return null
  }

  protected extractImports(root: Parser.SyntaxNode): void {
    this.traverseImports(root)
  }

  private traverseImports(node: Parser.SyntaxNode): void {
    /**
     * Process Rust use
     *
     * use std::collections::HashMap; → importMap["HashMap"] = "std::collections::HashMap"
     * use crate::utils::*;           → Skip wildcard
     */
    if (node.type === 'use_declaration') {
      const usePath = node.text
      // Simplified: extract last identifier
      const match = usePath.match(/::(\w+);?$/)
      if (match && match[1] !== '*') {
        const name = match[1]
        const fullPath = usePath.replace(/^use\s+/, '').replace(/;$/, '')
        this.importMap.set(name, fullPath)
      }
    }

    for (const child of node.children) {
      this.traverseImports(child)
    }
  }

  protected override getComponentType(
    node: Parser.SyntaxNode,
    inClass: boolean
  ): DependencyNode['componentType'] {
    const typeMap: Record<string, DependencyNode['componentType']> = {
      'struct_item': 'struct',
      'enum_item': 'enum',
      'trait_item': 'trait',
    }
    return typeMap[node.type] ?? super.getComponentType(node, inClass)
  }

  protected override getGlobalBuiltins(): Set<string> {
    return RustAnalyzer.GLOBAL_BUILTINS
  }
}
