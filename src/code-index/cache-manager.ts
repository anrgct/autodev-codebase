import { createHash } from "crypto"
import * as path from "path"
import * as os from "os"
import { ICacheManager } from "./interfaces/cache"
import * as filesystem from "../utils/filesystem"
import debounce from "lodash.debounce"

// Default cache base directory
const DEFAULT_CACHE_BASE = path.join(os.homedir(), ".autodev-cache")

/**
 * Manages the cache for code indexing
 */
export class CacheManager implements ICacheManager {
  private cachePath: string
  private fileHashes: Record<string, string> = {}
  private _debouncedSaveCache: () => void

  /**
   * Creates a new cache manager
   * @param workspacePath Path to the workspace
   */
  constructor(private workspacePath: string) {
    this.cachePath = this.createCachePath(
      `roo-index-cache-${createHash("sha256").update(workspacePath).digest("hex")}.json`,
    )
    this._debouncedSaveCache = debounce(async () => {
      await this._performSave()
    }, 1500)
  }

  /**
   * Creates a cache file path based on the filename
   * @param filename The cache filename
   * @returns The full path to the cache file
   */
  private createCachePath(filename: string): string {
    return path.join(DEFAULT_CACHE_BASE, filename)
  }

  /**
   * Gets the cache file path
   */
  get getCachePath(): string {
    return this.cachePath
  }

  /**
   * Initializes the cache manager by loading the cache file
   */
  async initialize(): Promise<void> {
    try {
      const cacheData = await filesystem.readFile(this.cachePath)
      this.fileHashes = JSON.parse(new TextDecoder().decode(cacheData))
    } catch (error) {
      this.fileHashes = {}
    }
  }

  /**
   * Saves the cache to disk
   */
  private async _performSave(): Promise<void> {
    try {
      // Persist cache JSON using the filesystem module
      const json = JSON.stringify(this.fileHashes, null, 2)
      await filesystem.writeFile(this.cachePath, new TextEncoder().encode(json))
    } catch (error) {
      console.error("Failed to save cache:", error)
    }
  }

  /**
   * Clears the cache for this workspace.
   * Default行为：删除对应的缓存文件，并重置内存中的哈希映射。
   */
  async clearCacheFile(): Promise<void> {
    try {
      // If the cache file exists, remove it entirely
      if (await filesystem.exists(this.cachePath)) {
        await filesystem.remove(this.cachePath)
      }

      // Reset in-memory cache state
      this.fileHashes = {}
    } catch (error) {
      console.error("Failed to clear cache file:", error, this.cachePath)
    }
  }

  /**
   * Gets the hash for a file path
   * @param filePath Path to the file
   * @returns The hash for the file or undefined if not found
   */
  getHash(filePath: string): string | undefined {
    return this.fileHashes[filePath]
  }

  /**
   * Updates the hash for a file path
   * @param filePath Path to the file
   * @param hash New hash value
   */
  updateHash(filePath: string, hash: string): void {
    this.fileHashes[filePath] = hash
    this._debouncedSaveCache()
  }

  /**
   * Deletes the hash for a file path
   * @param filePath Path to the file
   */
  deleteHash(filePath: string): void {
    delete this.fileHashes[filePath]
    this._debouncedSaveCache()
  }

  /**
   * Deletes multiple hashes by file path
   * @param filePaths Array of file paths to delete
   */
  deleteHashes(filePaths: string[]): void {
    for (const filePath of filePaths) {
      delete this.fileHashes[filePath]
    }
    this._debouncedSaveCache()
  }

  /**
   * Gets a copy of all file hashes
   * @returns A copy of the file hashes record
   */
  getAllHashes(): Record<string, string> {
    return { ...this.fileHashes }
  }
}
