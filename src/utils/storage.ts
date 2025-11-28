/**
 * JSON File Storage
 * Simple key-value storage using JSON file
 */
import { promises as fs } from 'fs'
import * as path from 'path'

export interface StorageOptions {
  /** Storage file path */
  storagePath: string
}

export class Storage<T = any> {
  private storagePath: string
  private data: Map<string, T> = new Map()
  private loaded: boolean = false

  constructor(options: StorageOptions) {
    this.storagePath = options.storagePath
  }

  /**
   * Load data from storage file
   */
  private async load(): Promise<void> {
    if (this.loaded) return

    try {
      const content = await fs.readFile(this.storagePath, 'utf-8')
      const parsed = JSON.parse(content)
      this.data = new Map(Object.entries(parsed))
    } catch (error: any) {
      // File doesn't exist or is invalid, start with empty data
      if (error.code !== 'ENOENT') {
        console.warn(`Failed to load storage from ${this.storagePath}:`, error.message)
      }
      this.data = new Map()
    }

    this.loaded = true
  }

  /**
   * Save data to storage file
   */
  private async save(): Promise<void> {
    const dir = path.dirname(this.storagePath)
    await fs.mkdir(dir, { recursive: true })

    const obj = Object.fromEntries(this.data)
    await fs.writeFile(this.storagePath, JSON.stringify(obj, null, 2), 'utf-8')
  }

  /**
   * Get value by key
   */
  async get(key: string): Promise<T | undefined> {
    await this.load()
    return this.data.get(key)
  }

  /**
   * Get value by key with default value
   */
  async getOrDefault(key: string, defaultValue: T): Promise<T> {
    await this.load()
    return this.data.get(key) ?? defaultValue
  }

  /**
   * Set value for key
   */
  async set(key: string, value: T): Promise<void> {
    await this.load()
    this.data.set(key, value)
    await this.save()
  }

  /**
   * Delete key
   */
  async delete(key: string): Promise<boolean> {
    await this.load()
    const existed = this.data.delete(key)
    if (existed) {
      await this.save()
    }
    return existed
  }

  /**
   * Check if key exists
   */
  async has(key: string): Promise<boolean> {
    await this.load()
    return this.data.has(key)
  }

  /**
   * Get all keys
   */
  async keys(): Promise<string[]> {
    await this.load()
    return Array.from(this.data.keys())
  }

  /**
   * Get all values
   */
  async values(): Promise<T[]> {
    await this.load()
    return Array.from(this.data.values())
  }

  /**
   * Get all entries
   */
  async entries(): Promise<[string, T][]> {
    await this.load()
    return Array.from(this.data.entries())
  }

  /**
   * Clear all data
   */
  async clear(): Promise<void> {
    this.data.clear()
    await this.save()
  }

  /**
   * Get the number of stored items
   */
  async size(): Promise<number> {
    await this.load()
    return this.data.size
  }

  /**
   * Reload data from file (useful for external changes)
   */
  async reload(): Promise<void> {
    this.loaded = false
    await this.load()
  }
}

/**
 * Create a storage instance
 */
export function createStorage<T = any>(storagePath: string): Storage<T> {
  return new Storage<T>({ storagePath })
}
