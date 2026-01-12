/**
 * C# analyzer
 * Supports C# files (.cs)
 */

import Parser from 'web-tree-sitter'
import { BaseAnalyzer, NodeTypes } from './base'
import type { DependencyNode } from '../models'

/**
 * C# language analyzer
 */
export class CSharpAnalyzer extends BaseAnalyzer {

  protected getNodeTypes(): NodeTypes {
    return {
      functionTypes: new Set(), // C# has no standalone functions
      classTypes: new Set([
        'class_declaration',
        'interface_declaration',
        'struct_declaration',
        'enum_declaration',
        'record_declaration',
        'delegate_declaration',
      ]),
      methodTypes: new Set(['method_declaration', 'constructor_declaration']),
      callTypes: new Set(['invocation_expression', 'object_creation_expression']),
      importTypes: new Set(['using_directive']),
      identifierType: 'identifier',
      extensions: new Set(['.cs']),
    }
  }

  protected extractFunctionName(node: Parser.SyntaxNode): string | null {
    const nameNode = this.findChildByType(node, 'identifier')
    return nameNode ? this.getNodeText(nameNode) : null
  }

  protected extractClassName(node: Parser.SyntaxNode): string | null {
    // C# class name comes after keyword
    const keywords = new Set(['class', 'interface', 'struct', 'enum', 'record', 'delegate'])
    let foundKeyword = false

    for (const child of node.children) {
      if (keywords.has(child.type)) {
        foundKeyword = true
      } else if (foundKeyword && child.type === 'identifier') {
        return this.getNodeText(child)
      }
    }

    return null
  }

  protected extractCallName(node: Parser.SyntaxNode): string | null {
    if (node.type === 'object_creation_expression') {
      // new ClassName()
      const typeNode = this.findChildByType(node, 'identifier')
      return typeNode ? this.getNodeText(typeNode) : null
    }

    if (node.children.length === 0) return null

    const callee = node.children[0]

    // Direct call
    if (callee.type === 'identifier') {
      return this.getNodeText(callee)
    }

    // Member call
    if (callee.type === 'member_access_expression') {
      const identifiers = this.findChildrenByType(callee, 'identifier')
      if (identifiers.length > 0) {
        return this.getNodeText(identifiers[identifiers.length - 1])
      }
    }

    return null
  }

  protected extractImports(root: Parser.SyntaxNode): void {
    this.traverseImports(root)
  }

  private traverseImports(node: Parser.SyntaxNode): void {
    /**
     * Process C# using
     *
     * using System;                    → importMap["System"] = "System"
     * using System.Collections.Generic → importMap["Generic"] = "System.Collections.Generic"
     * using Foo = System.Bar;          → importMap["Foo"] = "System.Bar"
     */
    if (node.type === 'using_directive') {
      // Check for alias
      const aliasNode = this.findChildByType(node, 'name_equals')
      if (aliasNode) {
        const alias = this.findChildByType(aliasNode, 'identifier')
        const qualified = this.findChildByType(node, 'qualified_name')
        if (alias && qualified) {
          this.importMap.set(
            this.getNodeText(alias),
            this.getNodeText(qualified)
          )
        }
      } else {
        // Normal using
        const qualified = this.findChildByType(node, 'qualified_name')
        if (qualified) {
          const fullPath = this.getNodeText(qualified)
          const simpleName = fullPath.split('.').pop()!
          this.importMap.set(simpleName, fullPath)
        }
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
      'interface_declaration': 'interface',
      'struct_declaration': 'struct',
      'enum_declaration': 'enum',
    }
    return typeMap[node.type] ?? super.getComponentType(node, inClass)
  }
}
