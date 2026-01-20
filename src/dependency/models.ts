/**
 * Core types and interfaces for Mini Dependency Analyzer
 */

/**
 * Represents a code element (class, function, method) in the dependency graph
 *
 * ID format: {module-path}.{Class}.{method} or {module-path}.{function}
 * 
 * Note: All path separators are normalized to forward slashes (/) for cross-platform consistency.
 * Class and method names use dots (.) as separators, making it easy to distinguish path from class/method.
 *
 * Examples:
 *   - src/users/service.UserService.getUser       (TypeScript method)
 *   - src/utils/helper.formatDate                (TypeScript function)
 *   - src/main/java/com/example.Main.main        (Java method, file path with / separator)
 */
export interface DependencyNode {
  /** Internal unique ID */
  id: string

  /** Simple name (e.g., "getUser") */
  name: string

  /** Component type */
  componentType: 'function' | 'class' | 'method' | 'interface' | 'struct' | 'trait' | 'enum' | 'module'

  /** Absolute file path */
  filePath: string

  /** Relative path from repository root */
  relativePath: string

  /** Start line number (1-based) */
  startLine: number

  /** End line number (1-based) */
  endLine: number

  /** Set of dependent node IDs */
  dependsOn: Set<string>

  // ─────────────────────────────────────
  // LLM context critical fields
  // ─────────────────────────────────────

  /** Source code (optional, for LLM context) */
  sourceCode?: string

  /** Documentation string */
  docstring?: string

  /** Function parameter list */
  parameters?: string[]

  // ─────────────────────────────────────
  // Metadata
  // ─────────────────────────────────────

  /** Logical ID (compatibility field) */
  componentId?: string

  /** Parent class name for methods */
  className?: string

  /** Language identifier */
  language?: string
}

/**
 * Represents a dependency/call relationship between nodes
 *
 * Direction: caller → callee (caller depends on callee)
 */
export interface DependencyEdge {
  /** Caller component_id */
  caller: string

  /** Callee component_id */
  callee: string

  /** Line number where the call occurred */
  callLine?: number

  /** Whether successfully resolved to a known node */
  isResolved: boolean

  /** Resolution confidence (0.0-1.0) */
  confidence: number
}

/**
 * Result of dependency analysis for a file or directory
 */
export interface DependencyResult {
  /** Node map (id → Node) */
  nodes: Map<string, DependencyNode>

  /** Relationship edges list */
  relationships: DependencyEdge[]

  /** Statistics summary */
  summary: DependencySummary

  /** Circular dependency list */
  cycles: string[][]

  /** Topologically sorted node ID list */
  topoOrder: string[]

  /** Optional errors encountered during analysis */
  errors?: string[]
}

/**
 * Summary statistics for dependency analysis
 */
export interface DependencySummary {
  /** Total number of files analyzed */
  totalFiles: number

  /** Total number of nodes/components */
  totalNodes: number

  /** Total number of relationships/edges */
  totalRelationships: number

  /** List of languages found */
  languages: string[]
}

/**
 * Parse output from language analyzers (internal use)
 * Contains extracted nodes and edges from code analysis
 */
export interface ParseOutput {
  nodes: DependencyNode[]
  edges: DependencyEdge[]
}

/**
 * Raw file parse result from parseFile()
 * Contains parsed file metadata and AST
 */
export interface FileParseResult {
  /** Absolute file path */
  filePath: string

  /** File content as string */
  content: string

  /** Detected language */
  language: string

  /** Parsed AST tree */
  ast: unknown

  /** Whether parsing succeeded */
  success: boolean

  /** Error message if parsing failed */
  error?: string
}

/**
 * Language support configuration
 */
export interface LanguageConfig {
  name: string
  extensions: string[]
  treeSitterName: string
  parser?: any
}

/**
 * Parser cache entry
 */
export interface ParserCacheEntry {
  parser: any
  language: any
  lastUsed: number
}

/**
 * File filter configuration
 */
export interface FileFilter {
  include?: string[]
  exclude?: string[]
  maxFileSize?: number
}

/**
 * Analysis options
 */
export interface AnalysisOptions {
  includeTests?: boolean
  includeNodeModules?: boolean
  maxDepth?: number
  followSymlinks?: boolean
  fileFilter?: FileFilter
  /** Enable dependency analysis cache (default: true) */
  enableCache?: boolean
  /** Custom cache base directory (default: ~/.autodev-cache/dependency-cache) */
  cacheBaseDir?: string
}
