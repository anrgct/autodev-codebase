/**
 * JSONC (JSON with Comments) Helper Utilities
 * Provides functions to save configuration while preserving comments
 */

import * as jsoncParser from 'jsonc-parser'

/**
 * Saves configuration object to JSONC format while preserving existing comments
 * 
 * @param originalContent - The original JSONC content (empty string for new files)
 * @param newConfig - The new configuration object to save
 * @param formattingOptions - Optional formatting options
 * @returns JSONC string with preserved comments, or standard JSON if preservation fails
 */
export function saveJsoncPreservingComments(
  originalContent: string,
  newConfig: Record<string, any>,
  formattingOptions: jsoncParser.FormattingOptions = { insertSpaces: true, tabSize: 2 }
): string {
  // If no original content, use standard JSON.stringify
  if (!originalContent || originalContent.trim() === '') {
    return JSON.stringify(newConfig, null, 2)
  }

  // Validate original content is valid JSONC by checking for parse errors
  const parseErrors: jsoncParser.ParseError[] = []
  jsoncParser.parse(originalContent, parseErrors)
  if (parseErrors.length > 0) {
    // Fallback to standard JSON if original is invalid
    return JSON.stringify(newConfig, null, 2)
  }

  let result = originalContent
  let hasErrors = false

  // Modification options for jsonc-parser
  const modificationOptions: jsoncParser.ModificationOptions = {
    formattingOptions: formattingOptions
  }

  /**
   * Check if value is a plain object (not null, not array, not Date, etc.)
   */
  function isPlainObject(value: any): boolean {
    return value !== null && 
           typeof value === 'object' && 
           !Array.isArray(value) && 
           !(value instanceof Date) &&
           !(value instanceof RegExp)
  }

  /**
   * Recursively apply updates while preserving comments
   */
  function applyUpdates(obj: any, path: string[] = []): void {
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = [...path, key]

      if (isPlainObject(value)) {
        // For objects, check if we should merge or replace
        const existingValue = getPathValue(jsoncParser.parse(result), currentPath)

        if (isPlainObject(existingValue)) {
          // Recursively merge nested objects
          applyUpdates(value, currentPath)
          continue
        }

        // Set the entire object
        try {
          const edit = jsoncParser.modify(result, currentPath, value, modificationOptions)
          const newResult = jsoncParser.applyEdits(result, edit)
          
          // Verify the edit was applied successfully
          if (newResult !== result) {
            result = newResult
          } else {
            hasErrors = true
          }
        } catch (e) {
          hasErrors = true
        }
      } else {
        // Primitive values, arrays, null - set directly
        try {
          const edit = jsoncParser.modify(result, currentPath, value, modificationOptions)
          const newResult = jsoncParser.applyEdits(result, edit)
          
          if (newResult !== result) {
            result = newResult
          } else {
            hasErrors = true
          }
        } catch (e) {
          hasErrors = true
        }
      }
    }
  }

  applyUpdates(newConfig)

  // If any errors occurred during modification, verify the result is still valid
  if (hasErrors) {
    const finalErrors: jsoncParser.ParseError[] = []
    jsoncParser.parse(result, finalErrors)
    if (finalErrors.length > 0) {
      // If result became invalid, fallback to standard JSON
      return JSON.stringify(newConfig, null, 2)
    }
  }

  return result
}

/**
 * Helper function to get value at a path in an object
 */
function getPathValue(obj: any, path: string[]): any {
  return path.reduce((acc, key) => acc?.[key], obj)
}

/**
 * Validates that the content is valid JSONC
 * Uses parse with error array to detect syntax issues
 */
export function isValidJsonc(content: string): boolean {
  const errors: jsoncParser.ParseError[] = []
  jsoncParser.parse(content, errors)
  return errors.length === 0
}

/**
 * Merges configuration objects, with newConfig taking precedence
 * This is a deep merge that preserves existing properties
 * Only merges plain objects, primitives and arrays are replaced
 */
export function mergeConfig(
  baseConfig: Record<string, any>,
  newConfig: Record<string, any>
): Record<string, any> {
  const result: Record<string, any> = { ...baseConfig }

  for (const [key, value] of Object.entries(newConfig)) {
    const baseValue = result[key]
    
    // Only merge if both values are plain objects
    if (isPlainObject(value) && isPlainObject(baseValue)) {
      result[key] = mergeConfig(baseValue, value)
    } else {
      // Replace primitive values, arrays, or non-mergeable objects
      result[key] = value
    }
  }

  return result
}

/**
 * Check if value is a plain object (helper for mergeConfig)
 */
function isPlainObject(value: any): boolean {
  return value !== null && 
         typeof value === 'object' && 
         !Array.isArray(value) && 
         !(value instanceof Date) &&
         !(value instanceof RegExp)
}
