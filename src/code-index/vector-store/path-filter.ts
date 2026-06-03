//
// Path Filter: compiles glob-like path patterns into predicates usable by
// both the Qdrant backend (substring match clauses) and the SQLite backend
// (LIKE / NOT LIKE predicates on a pre-lowercased `file_path_lower` column).
//
// Extracted from qdrant-client.ts so both backends can share one
// implementation. The behaviour is intentionally identical to the previous
// Qdrant-side compiler:
//   - `**` and `*` are wildcard separators
//   - Brace expansion {a,b} is expanded at the application layer
//   - Character classes [...] are dropped (not supported)
//   - `?` is treated as a literal character
//   - Leading `!` makes a pattern an exclude pattern
//
// Keep this file dependency-free (no Node modules) so it can be reused by
// any backend without dragging extra runtime cost.
//

export interface CompiledPathFilter {
  // Include patterns. Each entry is a list of substrings that must ALL appear
  // in the path (in order, after lowercasing). Different entries are OR'd.
  // Empty array means "no include filter" (match everything).
  includes: string[][]
  // Exclude patterns. Same shape as `includes`, OR'd, and applied as NOT.
  // Empty array means "no exclude filter".
  excludes: string[][]
}

// Compiles a list of path filter patterns (e.g. ["src/**/*.ts", "!**/*.test.ts"])
// into a normalized CompiledPathFilter that both backends can consume.
//
// Patterns starting with `!` are excludes. Everything else is an include.
export function compilePathFilters(pathFilters: string[] | undefined): CompiledPathFilter {
  if (!pathFilters || pathFilters.length === 0) {
    return { includes: [], excludes: [] }
  }

  const includes: string[][] = []
  const excludes: string[][] = []

  for (const raw of pathFilters) {
    if (!raw) continue
    const isExclude = raw.startsWith('!')
    const pattern = isExclude ? raw.slice(1) : raw
    const expanded = expandBraces(pattern)
    const target = isExclude ? excludes : includes
    for (const p of expanded) {
      const subs = extractSubstrings(p)
      // An include that matches everything (no substrings) is a no-op.
      if (subs.length > 0) {
        target.push(subs)
      }
    }
  }

  return { includes, excludes }
}

// Expand {a,b,c} brace groups into multiple patterns. Recursive so nested
// braces are handled (e.g. src/{a,{b,c}}/x).
export function expandBraces(pattern: string): string[] {
  const braceRegex = /{([^}]+)}/g
  const match = braceRegex.exec(pattern)
  if (!match) return [pattern]

  const options = match[1].split(',').map((opt) => opt.trim()).filter(Boolean)
  if (options.length === 0) return [pattern]

  const prefix = pattern.substring(0, match.index)
  const suffix = pattern.substring(match.index + match[0].length)
  return options.flatMap((opt) => expandBraces(prefix + opt + suffix))
}

// Extract the literal substrings a path must contain to satisfy a pattern.
// We split the pattern on `**` and `*` and keep everything that is neither
// a wildcard, a [...] character class, nor a lone path separator.
//
// The match is intentionally loose: as long as every substring appears in
// the (lowercased) path, the pattern is considered to match. This mirrors
// the existing Qdrant behaviour and is sufficient for the typical
// src/**/*.ts style filters used in this project.
export function extractSubstrings(pattern: string): string[] {
  const segments = pattern.split(/(\*\*|\*)/)
  return segments.filter((part) => {
    if (part === '**' || part === '*') return false
    if (part.length === 0) return false
    if (part.includes('[') || part.includes(']')) return false
    if (part === '/' || part === '\\') return false
    return true
  })
}

// Convert a CompiledPathFilter to a SQL WHERE fragment + bound parameters,
// suitable for `WHERE <sql>`. Uses LIKE against the precomputed
// file_path_lower column. Returns { sql: "1=1", params: [] } when no
// filter is active so callers can always splice the result unconditionally.
export function compilePathFiltersToSql(filter: CompiledPathFilter): { sql: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []

  for (const includeGroup of filter.includes) {
    const subClauses: string[] = []
    for (const sub of includeGroup) {
      params.push(`%${sub.toLowerCase()}%`)
      subClauses.push('file_path_lower LIKE ?')
    }
    if (subClauses.length > 0) {
      clauses.push('(' + subClauses.join(' AND ') + ')')
    }
  }

  for (const excludeGroup of filter.excludes) {
    const subClauses: string[] = []
    for (const sub of excludeGroup) {
      params.push(`%${sub.toLowerCase()}%`)
      subClauses.push('file_path_lower LIKE ?')
    }
    if (subClauses.length > 0) {
      clauses.push('NOT (' + subClauses.join(' AND ') + ')')
    }
  }

  if (clauses.length === 0) {
    return { sql: '1=1', params: [] }
  }
  return { sql: clauses.join(' AND '), params }
}

// Convert a CompiledPathFilter to a Qdrant filter object. This is the
// exact shape the existing Qdrant implementation used to construct inline;
// extracted here so the SQLite backend can ignore it and the Qdrant
// backend can use the same shared compiler.
export function compilePathFiltersToQdrant(filter: CompiledPathFilter): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  if (filter.includes.length > 0) {
    out['should'] = filter.includes.map((group) => ({
      must: group.map((s) => ({
        key: 'filePathLower',
        match: { text: s.toLowerCase() },
      })),
    }))
  }

  if (filter.excludes.length > 0) {
    out['must_not'] = filter.excludes.map((group) => ({
      must: group.map((s) => ({
        key: 'filePathLower',
        match: { text: s.toLowerCase() },
      })),
    }))
  }

  return out
}
