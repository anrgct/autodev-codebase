import { createHash } from "crypto"
import { ICacheManager } from "./interfaces/cache"
import { IFileSystem, IStorage } from "../abstractions"
import debounce from "lodash.debounce"

/**
 * Manages the cache for code indexing
 */
export class CacheManager implements ICacheManager {
	private cachePath: string
	private fileHashes: Record<string, string> = {}
	private _debouncedSaveCache: () => void

	/**
	 * Creates a new cache manager
	 * @param fileSystem File system abstraction
	 * @param storage Storage abstraction
	 * @param workspacePath Path to the workspace
	 */
	constructor(
		private fileSystem: IFileSystem,
		private storage: IStorage,
		private workspacePath: string,
	) {
		this.cachePath = this.storage.createCachePath(
			`roo-index-cache-${createHash("sha256").update(workspacePath).digest("hex")}.json`,
		)
		this._debouncedSaveCache = debounce(async () => {
			await this._performSave()
		}, 1500)
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
			const cacheData = await this.fileSystem.readFile(this.cachePath)
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
			// Persist cache JSON via the injected filesystem so implementations
			// (Node.js, VSCode, etc.) stay in control of how writes are done.
			const json = JSON.stringify(this.fileHashes, null, 2)
			await this.fileSystem.writeFile(this.cachePath, new TextEncoder().encode(json))
		} catch (error) {
			console.error("Failed to save cache:", error)
		}
	}

	/**
	 * Clears the cache file by writing an empty object to it
	 */
	async clearCacheFile(): Promise<void> {
		try {
			await this.fileSystem.writeFile(this.cachePath, new TextEncoder().encode("{}"))
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
