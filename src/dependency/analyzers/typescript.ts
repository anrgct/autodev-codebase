/**
 * TypeScript/JavaScript analyzer
 * Supports TypeScript, JavaScript, TSX files
 */

import Parser from 'web-tree-sitter'
import { BaseAnalyzer, NodeTypes } from './base'

export class TypeScriptAnalyzer extends BaseAnalyzer {

  private static readonly GLOBAL_BUILTINS = new Set([
    // 定时器
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'setImmediate', 'clearImmediate', 'queueMicrotask',

    // 类型转换和检查
    'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'String', 'Number', 'Boolean', 'BigInt', 'Symbol',

    // 编码
    'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
    'btoa', 'atob',

    // 其他全局函数
    'eval', 'fetch', 'alert', 'confirm', 'prompt',
    'requestAnimationFrame', 'cancelAnimationFrame',
    'requestIdleCallback', 'cancelIdleCallback',

    // 构造函数（作为函数调用时）
    'Array', 'Object', 'Map', 'Set', 'WeakMap', 'WeakSet',
    'Promise', 'Proxy', 'Reflect',
    'Error', 'TypeError', 'RangeError', 'SyntaxError',
    'Date', 'RegExp',

    // Node.js 全局
    'require',
  ])

  private static readonly MEMBER_BUILTINS = new Set([
    // console
    'console.log', 'console.error', 'console.warn', 'console.info',
    'console.debug', 'console.trace', 'console.table',
    'console.time', 'console.timeEnd', 'console.assert',

    // JSON
    'JSON.parse', 'JSON.stringify',

    // Math
    'Math.abs', 'Math.floor', 'Math.ceil', 'Math.round', 'Math.trunc',
    'Math.max', 'Math.min', 'Math.random', 'Math.sqrt', 'Math.pow',

    // Object 静态方法
    'Object.keys', 'Object.values', 'Object.entries', 'Object.assign',
    'Object.fromEntries', 'Object.create', 'Object.freeze',

    // Array 静态方法
    'Array.from', 'Array.isArray', 'Array.of',

    // Promise 静态方法
    'Promise.resolve', 'Promise.reject', 'Promise.all', 'Promise.race',
    'Promise.allSettled', 'Promise.any',

    // Number 静态方法
    'Number.isNaN', 'Number.isFinite', 'Number.isInteger',
    'Number.parseFloat', 'Number.parseInt',
  ])

  protected getNodeTypes(): NodeTypes {
    return {
      functionTypes: new Set([
        'function_declaration',
        'generator_function_declaration',
        'arrow_function',
      ]),
      classTypes: new Set([
        'class_declaration',
        'abstract_class_declaration',
        'interface_declaration',
      ]),
      methodTypes: new Set(['method_definition']),
      callTypes: new Set(['call_expression', 'new_expression']),
      importTypes: new Set(['import_statement']),
      identifierType: 'identifier',
      extensions: new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']),
    }
  }

  protected extractFunctionName(node: Parser.SyntaxNode): string | null {
    // Regular function declaration
    const nameNode = this.findChildByType(node, 'identifier')
    if (nameNode) {
      return this.getNodeText(nameNode)
    }

    // Method definition
    if (node.type === 'method_definition') {
      const propNode = this.findChildByType(node, 'property_identifier')
      if (propNode) {
        return this.getNodeText(propNode)
      }
    }

    return null
  }

  protected extractClassName(node: Parser.SyntaxNode): string | null {
    // TypeScript uses type_identifier for class names
    const nameNode =
      this.findChildByType(node, 'type_identifier') ??
      this.findChildByType(node, 'identifier')
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
    if (node.children.length === 0) return null

    const callee = node.children[0]

    // Direct call
    if (callee.type === 'identifier') {
      return this.getNodeText(callee)
    }

    // Member call
    if (callee.type === 'member_expression') {
      const propNode = this.findChildByType(callee, 'property_identifier')
      if (propNode) {
        return this.getNodeText(propNode)
      }
    }

    return null
  }

  protected extractImports(root: Parser.SyntaxNode): void {
    this.traverseImports(root)
  }

  private traverseImports(node: Parser.SyntaxNode): void {
    /**
     * Process ES6 imports
     *
     * import foo from 'module'          → importMap["foo"] = "module"
     * import { bar } from 'module'      → importMap["bar"] = "module.bar"
     * import { bar as b } from 'module' → importMap["b"] = "module.bar"
     * import * as m from 'module'       → importMap["m"] = "module"
     */
    if (node.type === 'import_statement') {
      // Get module path
      const sourceNode = this.findChildByType(node, 'string')
      if (!sourceNode) return

      const modulePath = this.getNodeText(sourceNode).replace(/['"]/g, '')

      // Process import clauses
      for (const child of node.children) {
        // import foo from ...
        if (child.type === 'identifier') {
          this.importMap.set(this.getNodeText(child), modulePath)
        }

        // import { a, b } from ...
        else if (child.type === 'import_clause') {
          this.processImportClause(child, modulePath)
        }

        // import * as ns from ...
        else if (child.type === 'namespace_import') {
          const alias = this.findChildByType(child, 'identifier')
          if (alias) {
            this.importMap.set(this.getNodeText(alias), modulePath)
          }
        }
      }
    }

    // Recurse
    for (const child of node.children) {
      this.traverseImports(child)
    }
  }

  private processImportClause(node: Parser.SyntaxNode, modulePath: string): void {
    for (const child of node.children) {
      // Default export
      if (child.type === 'identifier') {
        this.importMap.set(this.getNodeText(child), modulePath)
      }

      // Named exports { a, b, c as d }
      else if (child.type === 'named_imports') {
        for (const spec of child.children) {
          if (spec.type === 'import_specifier') {
            const identifiers = this.findChildrenByType(spec, 'identifier')
            if (identifiers.length === 1) {
              const name = this.getNodeText(identifiers[0])
              this.importMap.set(name, `${modulePath}.${name}`)
            } else if (identifiers.length === 2) {
              const original = this.getNodeText(identifiers[0])
              const alias = this.getNodeText(identifiers[1])
              this.importMap.set(alias, `${modulePath}.${original}`)
            }
          }
        }
      }
    }
  }

  protected override getComponentType(
    node: Parser.SyntaxNode,
    inClass: boolean
  ): 'function' | 'class' | 'method' | 'interface' {
    if (node.type === 'interface_declaration') {
      return 'interface'
    }
    if (node.type === 'abstract_class_declaration' || node.type === 'class_declaration') {
      return 'class'
    }
    return super.getComponentType(node, inClass) as 'function' | 'method'
  }

  protected override getGlobalBuiltins(): Set<string> {
    return TypeScriptAnalyzer.GLOBAL_BUILTINS
  }

  protected override getMemberBuiltins(): Set<string> {
    return TypeScriptAnalyzer.MEMBER_BUILTINS
  }
}

// JavaScript reuses TypeScript analyzer
export const JavaScriptAnalyzer = TypeScriptAnalyzer

/**
 * TSX language analyzer
 *
 * Inherits TypeScriptAnalyzer, only modifies extension configuration
 * Note: .tsx files require tree-sitter-tsx.wasm
 */
export class TSXAnalyzer extends TypeScriptAnalyzer {
  protected override getNodeTypes(): NodeTypes {
    const base = super.getNodeTypes()
    return {
      ...base,
      extensions: new Set(['.tsx']),
    }
  }
}
