/**
 * Python analyzer
 * Supports Python files (.py)
 */

import Parser from 'web-tree-sitter'
import { BaseAnalyzer, NodeTypes } from './base'

export class PythonAnalyzer extends BaseAnalyzer {

  private static readonly GLOBAL_BUILTINS = new Set([
    'print', 'input', 'open',
    'str', 'int', 'float', 'bool', 'list', 'dict', 'tuple', 'set',
    'frozenset', 'bytes', 'bytearray', 'complex', 'bin', 'oct', 'hex',
    'range', 'enumerate', 'zip', 'reversed', 'sorted', 'filter', 'map',
    'len', 'max', 'min', 'sum', 'abs', 'round', 'pow', 'divmod',
    'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr', 'delattr',
    'type', 'callable', 'dir', 'vars', 'id', 'hash', 'repr', 'ascii',
    'next', 'iter', 'any', 'all',
    'chr', 'ord', 'format', 'eval', 'exec', 'compile',
    'staticmethod', 'classmethod', 'property', 'super',
    'object', 'slice', 'help',
  ])

  protected getNodeTypes(): NodeTypes {
    return {
      functionTypes: new Set(['function_definition', 'async_function_definition']),
      classTypes: new Set(['class_definition']),
      methodTypes: new Set(['function_definition', 'async_function_definition']),
      callTypes: new Set(['call']),
      importTypes: new Set(['import_statement', 'import_from_statement']),
      identifierType: 'identifier',
      extensions: new Set(['.py']),
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
     * self.foo()      → "foo"
     * obj.bar.baz()   → "baz"
     */
    if (node.children.length === 0) return null

    const funcNode = node.children[0]

    // Direct call: foo()
    if (funcNode.type === 'identifier') {
      return this.getNodeText(funcNode)
    }

    // Attribute call: obj.method()
    if (funcNode.type === 'attribute') {
      const identifiers = this.findChildrenByType(funcNode, 'identifier')
      if (identifiers.length > 0) {
        // Return the last identifier
        return this.getNodeText(identifiers[identifiers.length - 1])
      }
    }

    return null
  }

  protected extractImports(root: Parser.SyntaxNode): void {
    this.traverseImports(root)
  }

  private traverseImports(node: Parser.SyntaxNode): void {
    const module = this.getModulePath()

    // import xxx / import xxx as yyy
    if (node.type === 'import_statement') {
      for (const child of node.children) {
        if (child.type === 'dotted_name') {
          const fullName = this.getNodeText(child)
          const simpleName = fullName.split('.').pop()!
          this.importMap.set(simpleName, fullName)
        } else if (child.type === 'aliased_import') {
          const nameNode = this.findChildByType(child, 'dotted_name')
          const aliasNode = this.findChildByType(child, 'identifier')
          if (nameNode && aliasNode) {
            this.importMap.set(
              this.getNodeText(aliasNode),
              this.getNodeText(nameNode)
            )
          }
        }
      }
    }

    // from xxx import yyy
    else if (node.type === 'import_from_statement') {
      // Get base module
      const moduleNode = this.findChildByType(node, 'dotted_name')
      let baseModule = moduleNode ? this.getNodeText(moduleNode) : ''

      // Handle relative imports
      const relativeImport = this.findChildByType(node, 'relative_import')
      if (relativeImport) {
        const dots = this.getNodeText(relativeImport)
        const level = dots.length
        const moduleParts = module.split('.')
        if (level <= moduleParts.length) {
          const prefix = moduleParts.slice(0, -level).join('.')
          baseModule = prefix ? `${prefix}.${baseModule}` : prefix
        }
      }

      // Extract imported names
      for (const child of node.children) {
        if (child.type === 'dotted_name' && child !== moduleNode) {
          const name = this.getNodeText(child)
          const fullPath = baseModule ? `${baseModule}.${name}` : name
          this.importMap.set(name, fullPath)
        } else if (child.type === 'aliased_import') {
          const identifiers = this.findChildrenByType(child, 'identifier')
          const dotted = this.findChildByType(child, 'dotted_name')
          if (dotted && identifiers.length >= 1) {
            const name = this.getNodeText(dotted)
            const alias = this.getNodeText(identifiers[identifiers.length - 1])
            const fullPath = baseModule ? `${baseModule}.${name}` : name
            this.importMap.set(alias, fullPath)
          }
        }
      }
    }

    // Recurse
    for (const child of node.children) {
      this.traverseImports(child)
    }
  }

  protected override getGlobalBuiltins(): Set<string> {
    return PythonAnalyzer.GLOBAL_BUILTINS
  }
}
