/**
 * Language analyzer registry
 * Maps file extensions to analyzer classes and WASM language names
 */

import Parser from 'web-tree-sitter'
import { TypeScriptAnalyzer } from './typescript'
import { PythonAnalyzer } from './python'
import { JavaAnalyzer } from './java'
import { CAnalyzer } from './c'
import { CppAnalyzer } from './cpp'
import { CSharpAnalyzer } from './csharp'
import { RustAnalyzer } from './rust'
import { GoAnalyzer } from './go'
import { BaseAnalyzer } from './base'

/**
 * Registry mapping file extensions to analyzer classes
 */
export const ANALYZER_REGISTRY: Record<
  string,
  new (filePath: string, content: string, repoPath: string, parser: Parser) => BaseAnalyzer
> = {
  // TypeScript/JavaScript variants
  '.ts': TypeScriptAnalyzer,
  '.tsx': TypeScriptAnalyzer,
  '.js': TypeScriptAnalyzer,
  '.jsx': TypeScriptAnalyzer,

  // Python
  '.py': PythonAnalyzer,

  // Java
  '.java': JavaAnalyzer,

  // C/C++ variants
  '.c': CAnalyzer,
  '.h': CAnalyzer,
  '.cpp': CppAnalyzer,
  '.cc': CppAnalyzer,
  '.cxx': CppAnalyzer,
  '.hpp': CppAnalyzer,
  '.hxx': CppAnalyzer,
  '.c++': CppAnalyzer,

  // C#
  '.cs': CSharpAnalyzer,

  // Rust
  '.rs': RustAnalyzer,

  // Go
  '.go': GoAnalyzer
}

/**
 * Mapping from file extensions to WASM language names for tree-sitter
 */
export const EXTENSION_TO_WASM: Record<string, string> = {
  // TypeScript/JavaScript variants
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',

  // Python
  '.py': 'python',

  // Java
  '.java': 'java',

  // C
  '.c': 'c',
  '.h': 'c',

  // C++ variants
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.c++': 'cpp',

  // C#
  '.cs': 'csharp',

  // Rust
  '.rs': 'rust',

  // Go
  '.go': 'go'
}

/**
 * Get analyzer class for a given file extension
 */
export function getAnalyzer(
  filePath: string
): new (filePath: string, content: string, repoPath: string, parser: Parser) => BaseAnalyzer | null {
  const ext = filePath.substring(filePath.lastIndexOf('.'))
  return ANALYZER_REGISTRY[ext] || null
}

/**
 * Check if a file extension is supported
 */
export function isSupported(filePath: string): boolean {
  const ext = filePath.substring(filePath.lastIndexOf('.'))
  return ext in ANALYZER_REGISTRY
}

/**
 * Get WASM language name for a given file extension
 */
export function getWasmLanguage(filePath: string): string | null {
  const ext = filePath.substring(filePath.lastIndexOf('.'))
  return EXTENSION_TO_WASM[ext] || null
}

/**
 * Export all analyzer classes
 */
export {
  BaseAnalyzer,
  TypeScriptAnalyzer,
  PythonAnalyzer,
  JavaAnalyzer,
  CAnalyzer,
  CppAnalyzer,
  CSharpAnalyzer,
  RustAnalyzer,
  GoAnalyzer
}
