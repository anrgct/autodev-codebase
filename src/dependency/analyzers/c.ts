/**
 * C language analyzer
 * Supports C files (.c, .h)
 */

import Parser from 'web-tree-sitter'
import { BaseAnalyzer, NodeTypes } from './base'
import type { DependencyNode } from '../models'

/**
 * C language analyzer
 */
export class CAnalyzer extends BaseAnalyzer {

  private static readonly GLOBAL_BUILTINS = new Set([
    // C 标准库函数（常用的）
    'printf', 'scanf', 'sprintf', 'sscanf', 'fprintf', 'fscanf',
    'malloc', 'calloc', 'realloc', 'free',
    'strlen', 'strcpy', 'strncpy', 'strcmp', 'strcat', 'strncat',
    'memcpy', 'memmove', 'memcmp', 'memset',
    'assert', 'exit', 'abort', 'atoi', 'atof', 'atol',
    'pow', 'sqrt', 'sin', 'cos', 'tan', 'abs',
  ])

  protected getNodeTypes(): NodeTypes {
    return {
      functionTypes: new Set(['function_definition']),
      classTypes: new Set(['struct_specifier']),
      methodTypes: new Set(), // C has no methods
      callTypes: new Set(['call_expression']),
      importTypes: new Set(['preproc_include']),
      identifierType: 'identifier',
      extensions: new Set(['.c', '.h']),
    }
  }

  protected extractFunctionName(node: Parser.SyntaxNode): string | null {
    const declarator = this.findChildByType(node, 'function_declarator')
    if (declarator) {
      const nameNode = this.findChildByType(declarator, 'identifier')
      return nameNode ? this.getNodeText(nameNode) : null
    }
    return null
  }

  protected extractClassName(node: Parser.SyntaxNode): string | null {
    const nameNode = this.findChildByType(node, 'type_identifier')
    return nameNode ? this.getNodeText(nameNode) : null
  }

  protected extractCallName(node: Parser.SyntaxNode): string | null {
    if (node.children.length === 0) return null

    const func = node.children[0]
    if (func.type === 'identifier') {
      return this.getNodeText(func)
    }

    // Function pointer call
    if (func.type === 'field_expression') {
      const field = this.findChildByType(func, 'field_identifier')
      return field ? this.getNodeText(field) : null
    }

    return null
  }

  protected extractImports(root: Parser.SyntaxNode): void {
    this.traverseImports(root)
  }

  private traverseImports(node: Parser.SyntaxNode): void {
    /**
     * Process C #include
     *
     * #include <stdio.h>    → importMap["stdio"] = "stdio.h"
     * #include "myheader.h" → importMap["myheader"] = "myheader.h"
     */
    if (node.type === 'preproc_include') {
      const pathNode =
        this.findChildByType(node, 'system_lib_string') ??
        this.findChildByType(node, 'string_literal')

      if (pathNode) {
        const path = this.getNodeText(pathNode).replace(/[<>"]/g, '')
        // Extract filename without extension
        let name = path.split('/').pop()!
        for (const ext of ['.h', '.hpp']) {
          if (name.endsWith(ext)) {
            name = name.slice(0, -ext.length)
            break
          }
        }
        this.importMap.set(name, path)
      }
    }

    for (const child of node.children) {
      this.traverseImports(child)
    }
  }

  protected override getComponentType(
    node: Parser.SyntaxNode,
    _inClass: boolean
  ): DependencyNode['componentType'] {
    if (node.type === 'struct_specifier') {
      return 'struct'
    }
    return 'function'
  }

  protected override getGlobalBuiltins(): Set<string> {
    return CAnalyzer.GLOBAL_BUILTINS
  }
}
