export interface ICacheManager {
  /**
   * Initializes the cache manager by loading the cache file
   */
  initialize(): Promise<void>

  /**
   * Clears the cache file by writing an empty object to it
   */
  clearCacheFile(): Promise<void>

  /**
   * Gets the hash for a file path
   * @param filePath Path to the file
   * @returns The hash for the file or undefined if not found
   */
  getHash(filePath: string): string | undefined

  /**
   * Updates the hash for a file path
   * @param filePath Path to the file
   * @param hash New hash value
   */
  updateHash(filePath: string, hash: string): void

  /**
   * Deletes the hash for a file path
   * @param filePath Path to the file
   */
  deleteHash(filePath: string): void

  /**
   * Gets a copy of all file hashes
   * @returns A copy of the file hashes record
   */
  getAllHashes(): Record<string, string>
}
