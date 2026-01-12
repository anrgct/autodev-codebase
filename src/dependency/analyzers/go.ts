/**
 * Go language analyzer
 * Supports Go files (.go)
 */

import Parser from 'web-tree-sitter'
import { BaseAnalyzer, NodeTypes } from './base'
import type { DependencyNode } from '../models'

export class GoAnalyzer extends BaseAnalyzer {

  private static readonly GLOBAL_BUILTINS = new Set([
    'append', 'cap', 'close', 'copy', 'delete', 'len', 'make', 'new',
    'panic', 'print', 'println', 'recover',
  ])

  protected getNodeTypes(): NodeTypes {
    return {
      functionTypes: new Set(['function_declaration']),
      classTypes: new Set(['type_declaration']), // struct/interface
      methodTypes: new Set(['method_declaration']),
      callTypes: new Set(['call_expression']),
      importTypes: new Set(['import_declaration']),
      identifierType: 'identifier',
      extensions: new Set(['.go']),
    }
  }

  protected extractFunctionName(node: Parser.SyntaxNode): string | null {
    const nameNode = this.findChildByType(node, 'identifier')
    return nameNode ? this.getNodeText(nameNode) : null
  }

  protected extractClassName(node: Parser.SyntaxNode): string | null {
    // Go's type declaration structure is different
    const spec = this.findChildByType(node, 'type_spec')
    if (spec) {
      const nameNode = this.findChildByType(spec, 'type_identifier')
      return nameNode ? this.getNodeText(nameNode) : null
    }
    return null
  }

  protected extractCallName(node: Parser.SyntaxNode): string | null {
    if (node.children.length === 0) return null

    const callee = node.children[0]

    // Direct call
    if (callee.type === 'identifier') {
      return this.getNodeText(callee)
    }

    // Method call obj.Method()
    if (callee.type === 'selector_expression') {
      const field = this.findChildByType(callee, 'field_identifier')
      return field ? this.getNodeText(field) : null
    }

    return null
  }

  protected extractImports(root: Parser.SyntaxNode): void {
    this.traverseImports(root)
  }

  private traverseImports(node: Parser.SyntaxNode): void {
    /**
     * Process Go import
     *
     * import "fmt"                    → importMap["fmt"] = "fmt"
     * import alias "package/path"    → importMap["alias"] = "package/path"
     */
    if (node.type === 'import_spec') {
      const pathNode = this.findChildByType(node, 'interpreted_string_literal')
      if (pathNode) {
        const path = this.getNodeText(pathNode).replace(/"/g, '')
        const aliasNode = this.findChildByType(node, 'package_identifier')
        if (aliasNode) {
          this.importMap.set(this.getNodeText(aliasNode), path)
        } else {
          // Use package name as key
          const pkgName = path.split('/').pop()!
          this.importMap.set(pkgName, path)
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
    // Go's type_declaration needs to check if it's struct or interface
    if (node.type === 'type_declaration') {
      const spec = this.findChildByType(node, 'type_spec')
      if (spec) {
        if (this.findChildByType(spec, 'struct_type')) {
          return 'struct'
        }
        if (this.findChildByType(spec, 'interface_type')) {
          return 'interface'
        }
      }
    }
    return super.getComponentType(node, inClass)
  }

  protected override getGlobalBuiltins(): Set<string> {
    return GoAnalyzer.GLOBAL_BUILTINS
  }
}
