/**
 * Java analyzer
 * Supports Java files (.java)
 */

import Parser from 'web-tree-sitter'
import { BaseAnalyzer, NodeTypes } from './base'
import type { DependencyNode } from '../models'

export class JavaAnalyzer extends BaseAnalyzer {
  protected getNodeTypes(): NodeTypes {
    return {
      functionTypes: new Set(), // Java has no standalone functions
      classTypes: new Set([
        'class_declaration',
        'interface_declaration',
        'enum_declaration',
        'record_declaration',
        'annotation_type_declaration',
      ]),
      methodTypes: new Set(['method_declaration', 'constructor_declaration']),
      callTypes: new Set(['method_invocation', 'object_creation_expression']),
      importTypes: new Set(['import_declaration']),
      identifierType: 'identifier',
      extensions: new Set(['.java']),
    }
  }

  protected extractFunctionName(node: Parser.SyntaxNode): string | null {
    const nameNode = this.findChildByType(node, 'identifier')
    return nameNode ? this.getNodeText(nameNode) : null
  }

  protected extractClassName(node: Parser.SyntaxNode): string | null {
    const nameNode = this.findChildByType(node, 'identifier')
    return nameNode ? this.getNodeText(nameNode) : null
  }

  protected extractCallName(node: Parser.SyntaxNode): string | null {
    /**
     * Extract call name
     *
     * foo()           → "foo"
     * obj.method()    → "method"
     * new Foo()       → "Foo"
     */
    if (node.type === 'object_creation_expression') {
      // new ClassName()
      const typeNode = this.findChildByType(node, 'type_identifier')
      return typeNode ? this.getNodeText(typeNode) : null
    }

    // Method invocation
    const nameNode = this.findChildByType(node, 'identifier')
    return nameNode ? this.getNodeText(nameNode) : null
  }

  protected extractImports(root: Parser.SyntaxNode): void {
    this.traverseImports(root)
  }

  private traverseImports(node: Parser.SyntaxNode): void {
    /**
     * Process Java import
     *
     * import com.example.Foo;       → importMap["Foo"] = "com.example.Foo"
     * import com.example.*;         → Skip wildcard
     * import static com.example.X;  → importMap["X"] = "com.example.X"
     */
    if (node.type === 'import_declaration') {
      const scoped = this.findChildByType(node, 'scoped_identifier')
      if (scoped) {
        const fullPath = this.getNodeText(scoped)
        if (!fullPath.endsWith('*')) {
          const simpleName = fullPath.split('.').pop()!
          this.importMap.set(simpleName, fullPath)
        }
      }
    }

    // Recurse
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
      'enum_declaration': 'enum',
    }
    return typeMap[node.type] ?? super.getComponentType(node, inClass)
  }
}
