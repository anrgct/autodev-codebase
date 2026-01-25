/**
 * Utilities for parsing comma-separated path filters while respecting brace expansion.
 *
 * Used by CLI and MCP to keep behavior consistent.
 */

/**
 * Split filters by comma, but respect brace expansion (e.g., `{a,b}`).
 */
export function parsePathFilters(filtersString: string): string[] {
  const filters: string[] = []
  let current = ''
  let braceDepth = 0

  for (let i = 0; i < filtersString.length; i++) {
    const char = filtersString[i]

    if (char === '{') {
      braceDepth++
      current += char
      continue
    }

    if (char === '}') {
      braceDepth--
      current += char
      continue
    }

    if (char === ',' && braceDepth === 0) {
      const trimmed = current.trim()
      if (trimmed.length > 0) {
        filters.push(trimmed)
      }
      current = ''
      continue
    }

    current += char
  }

  const trimmed = current.trim()
  if (trimmed.length > 0) {
    filters.push(trimmed)
  }

  return filters
}

/**
 * Check whether a string contains glob pattern characters or comma-separated patterns.
 */
export function isGlobPattern(input: string): boolean {
  return /[*?{}\[\],]/.test(input)
}

