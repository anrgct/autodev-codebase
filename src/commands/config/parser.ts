/**
 * Configuration value parsing and validation
 *
 * Provides utilities for parsing configuration values from command-line
 * strings into properly typed values.
 */

import { getValidConfigKeys, getConfigKeyMetadata, isValidConfigKey } from './metadata'

/**
 * Parse configuration value with type conversion and validation
 *
 * @param key - Configuration key
 * @param value - String value from command line
 * @returns Parsed and validated value
 * @throws {Error} If value is invalid for the key's type
 */
export function parseConfigValue(key: string, value: string): any {
  const metadata = getConfigKeyMetadata(key)

  if (!metadata) {
    console.error(`Unknown configuration key: ${key}`)
    console.error(`Supported keys: ${getValidConfigKeys().join(', ')}`)
    process.exit(1)
  }

  const { type, enumValues, minValue, maxValue } = metadata

  // Boolean type
  if (type === 'boolean') {
    if (value !== 'true' && value !== 'false') {
      console.error(`Invalid boolean value for ${key}: ${value} (must be 'true' or 'false')`)
      process.exit(1)
    }
    return value === 'true'
  }

  // Integer type
  if (type === 'integer') {
    if (!/^-?\d+$/.test(value)) {
      console.error(`Invalid integer value for ${key}: ${value}`)
      process.exit(1)
    }
    const parsed = parseInt(value, 10)

    if (minValue !== undefined && parsed < minValue) {
      console.error(`Invalid value for ${key}: ${value} (must be >= ${minValue})`)
      process.exit(1)
    }

    if (maxValue !== undefined && parsed > maxValue) {
      console.error(`Invalid value for ${key}: ${value} (must be <= ${maxValue})`)
      process.exit(1)
    }

    return parsed
  }

  // Number type
  if (type === 'number') {
    if (!/^-?\d+(?:\.\d+)?$/.test(value)) {
      console.error(`Invalid numeric value for ${key}: ${value}`)
      process.exit(1)
    }
    const parsed = parseFloat(value)

    if (!Number.isFinite(parsed)) {
      console.error(`Invalid numeric value for ${key}: ${value}`)
      process.exit(1)
    }

    if (minValue !== undefined && parsed < minValue) {
      console.error(`Invalid value for ${key}: ${value} (must be >= ${minValue})`)
      process.exit(1)
    }

    if (maxValue !== undefined && parsed > maxValue) {
      console.error(`Invalid value for ${key}: ${value} (must be <= ${maxValue})`)
      process.exit(1)
    }

    return parsed
  }

  // Enum type
  if (type === 'enum' && enumValues) {
    if (!enumValues.includes(value)) {
      console.error(`Invalid value for ${key}: ${value}`)
      console.error(`Valid values: ${enumValues.join(', ')}`)
      process.exit(1)
    }
    return value
  }

  // Union type (e.g., "last" | number)
  if (type === 'union' && metadata.unionTypes) {
    // Try to parse as each member type in order
    for (const memberType of metadata.unionTypes) {
      if (memberType === 'string' && value === 'last') {
        return value  // special keyword
      }
      if (memberType === 'integer' && /^-?\d+$/.test(value)) {
        return parseInt(value, 10)
      }
      if (memberType === 'number' && /^-?\d+(?:\.\d+)?$/.test(value)) {
        return parseFloat(value)
      }
    }
    console.error(`Invalid union value for ${key}: ${value}`)
    console.error(`Expected types: ${metadata.unionTypes.join(' | ')}`)
    process.exit(1)
  }

  // String type (default)
  return value
}

/**
 * Parse key=value pairs from config string
 *
 * @param configString - Comma-separated key=value pairs (e.g., "key1=value1,key2=value2")
 * @returns Object mapping keys to their string values
 * @throws {Error} If format is invalid
 */
export function parseConfigPairs(configString: string): Record<string, string> {
  const pairs = configString.split(',').map((s) => s.trim())
  const result: Record<string, string> = {}

  for (const pair of pairs) {
    const equalIndex = pair.indexOf('=')
    if (equalIndex === -1) {
      console.error(`Invalid configuration format: ${pair} (should be key=value)`)
      process.exit(1)
    }

    const key = pair.substring(0, equalIndex).trim()
    const value = pair.substring(equalIndex + 1).trim()

    if (!key || value === '') {
      console.error(`Invalid configuration format: ${pair} (empty key or value)`)
      process.exit(1)
    }

    if (!isValidConfigKey(key)) {
      console.error(`Invalid configuration item: ${key}`)
      console.error(`Supported items: ${getValidConfigKeys().join(', ')}`)
      process.exit(1)
    }

    result[key] = value
  }

  return result
}

/**
 * Get all valid configuration keys
 */
export { getValidConfigKeys }

/**
 * Check if a configuration key is valid
 */
export { isValidConfigKey }
