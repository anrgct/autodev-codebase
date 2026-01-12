/**
 * C++ analyzer
 * Supports C++ files (.cpp, .cc, .cxx, .hpp, .hxx)
 * Extends C analyzer with C++ specific features
 */

import Parser from 'web-tree-sitter'
import { CAnalyzer } from './c'
import { NodeTypes } from './base'
import type { DependencyNode } from '../models'

/**
 * C++ language analyzer
 *
 * Extends CAnalyzer, adding C++ specific node types
 */
export class CppAnalyzer extends CAnalyzer {

  protected override getNodeTypes(): NodeTypes {
    const base = super.getNodeTypes()
    return {
      ...base,
      classTypes: new Set([...base.classTypes, 'class_specifier', 'namespace_definition']),
      methodTypes: new Set(['function_definition']), // C++ class methods
      extensions: new Set(['.cpp', '.cc', '.cxx', '.hpp', '.hxx']),
    }
  }

  protected override extractClassName(node: Parser.SyntaxNode): string | null {
    const nameNode = this.findChildByType(node, 'type_identifier')
    if (nameNode) {
      return this.getNodeText(nameNode)
    }

    // namespace
    if (node.type === 'namespace_definition') {
      const identNode = this.findChildByType(node, 'identifier')
      return identNode ? this.getNodeText(identNode) : null
    }

    return super.extractClassName(node)
  }

  protected override getComponentType(
    node: Parser.SyntaxNode,
    inClass: boolean
  ): DependencyNode['componentType'] {
    if (node.type === 'class_specifier') {
      return 'class'
    }
    if (node.type === 'namespace_definition') {
      return 'module' // Use module to represent namespace
    }
    return super.getComponentType(node, inClass)
  }
}
