/**
 * Summary Cache Manager
 *
 * Provides caching for AI-generated code summaries to avoid redundant LLM calls.
 * Uses a two-level hash mechanism:
 * - File-level hash for quick detection of unchanged files
 * - Block-level hash for precise detection of changed code blocks
 *
 * Cache location: ~/.autodev-cache/summary-cache/{projectHash}/files/
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { IFileSystem, IStorage } from '../abstractions';
import type { SummarizerConfig } from '../code-index/interfaces';

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Configuration fingerprint - used to detect configuration changes
 */
export interface CacheFingerprint {
	provider: 'ollama' | 'openai-compatible' | 'llamacpp';
	modelId: string;
	language: 'English' | 'Chinese';
	promptVersion: string;
	temperature?: number;
}

/**
 * Block-level summary cache entry
 */
export interface BlockSummary {
	codeHash: string;           // Block content hash (also cache key)
	contextHash: string;        // File context hash (metadata only, not used for cache invalidation)
	summary: string;            // AI-generated summary
	metadata?: {
		name?: string;          // Function/class name (for debugging)
		startLine: number;      // Start line number
		endLine: number;        // End line number
	};
}

/**
 * Complete summary cache for a file
 */
export interface SummaryCache {
	version: string;                       // Cache format version
	fingerprint: CacheFingerprint;         // Configuration fingerprint
	fileHash: string;                      // Complete file SHA256
	fileSummary?: string;                  // File-level summary
	lastAccessed: string;                  // Last access time (ISO 8601)
	blocks: Record<string, BlockSummary>;  // key = codeHash
}

/**
 * Cache statistics
 */
export interface CacheStats {
	totalBlocks: number;
	cachedBlocks: number;
	hitRate: number;        // 0-1
	invalidReason?: 'config-changed' | 'file-changed' | 'no-cache';
}

/**
 * Result of filtering blocks that need summarization
 */
export interface FilterResult {
	blocks: CodeBlock[];
	fileSummary: string | undefined;
	stats: CacheStats;
}

/**
 * Code block extracted from source file
 */
export interface CodeBlock {
	name: string;
	type: string;
	startLine: number;
	endLine: number;
	fullText: string;
	summary?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Cache format version */
export const CACHE_VERSION = '1.0';

/** Cache configuration limits */
export const CACHE_LIMITS = {
	MAX_BLOCKS_PER_FILE: 500,            // Max blocks per file
	MAX_CACHE_SIZE_BYTES: 1024 * 1024,   // Max cache file size (1MB)
	MAX_SUMMARY_LENGTH: 5000             // Max summary length (chars)
};

// ============================================================================
// SummaryCacheManager Class
// ============================================================================

/**
 * Manages summary cache for AI-generated code summaries
 */
export class SummaryCacheManager {
	private readonly workspacePath: string;
	private readonly storage: IStorage;
	private readonly fileSystem: IFileSystem;
	private readonly logger?: {
		info: (message: string) => void;
		error: (message: string) => void;
		warn?: (message: string) => void;
	};

	constructor(
		workspacePath: string,
		storage: IStorage,
		fileSystem: IFileSystem,
		logger?: {
			info: (message: string) => void;
			error: (message: string) => void;
			warn?: (message: string) => void;
		}
	) {
		this.workspacePath = workspacePath;
		this.storage = storage;
		this.fileSystem = fileSystem;
		this.logger = logger;
	}

	// ============================================================================
	// Hash Utilities
	// ============================================================================

	/**
	 * Calculate hash for a code block
	 */
	hashBlock(block: CodeBlock): string {
		return createHash('sha256')
			.update(block.fullText)
			.digest('hex');
	}

	/**
	 * Calculate hash for complete file content
	 */
	hashFile(content: string): string {
		return createHash('sha256')
			.update(content)
			.digest('hex');
	}

	/**
	 * Calculate file context hash (for metadata recording only)
	 */
	hashContext(documentContent: string): string {
		return this.hashFile(documentContent);
	}

	/**
	 * Create configuration fingerprint
	 */
	createFingerprint(config: SummarizerConfig): CacheFingerprint {
		return {
			provider: config.provider,
			modelId: config.provider === 'ollama'
				? (config.ollamaModelId || '')
				: config.provider === 'llamacpp'
					? (config.llamaCppModelPath || '')
					: (config.openAiCompatibleModelId || ''),
			language: config.language || 'English',
			promptVersion: '1.0',
			temperature: config.temperature
		};
	}

	// ============================================================================
	// Path Mapping
	// ============================================================================

	/**
	 * Get cache path for a source file
	 *
	 * @example
	 * getCachePathForSourceFile("/project/src/index.ts")
	 * // Returns: "~/.autodev-cache/summary-cache/a1b2c3d4e5f6g7h8/files/src/index.ts.summary.json"
	 */
	getCachePathForSourceFile(sourceFilePath: string): string {
		// 1. Calculate project hash
		const projectHash = createHash('sha256')
			.update(this.workspacePath)
			.digest('hex')
			.substring(0, 16);

		// 2. Calculate relative path
		const relativePath = path.relative(this.workspacePath, sourceFilePath);

		// 3. Security check: prevent path traversal attacks
		if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
			throw new Error(
				`Source file must be within workspace path.\n` +
				`  Workspace: ${this.workspacePath}\n` +
				`  Source file: ${sourceFilePath}\n` +
				`  Relative path: ${relativePath}`
			);
		}

		// 4. Build cache path
		const cacheBasePath = path.join(
			this.storage.getCacheBasePath(),  // ~/.autodev-cache
			'summary-cache',                   // summary-cache subdirectory
			projectHash,                       // project hash
			'files'                            // files subdirectory
		);

		return path.join(cacheBasePath, `${relativePath}.summary.json`);
	}

	// ============================================================================
	// Cache Operations
	// ============================================================================

	/**
	 * Load cache file for a source file
	 */
	async loadCache(sourceFilePath: string): Promise<SummaryCache | null> {
		const cachePath = this.getCachePathForSourceFile(sourceFilePath);

		try {
			const exists = await this.fileSystem.exists(cachePath);
			if (!exists) {
				return null;
			}

			const content = await this.fileSystem.readFile(cachePath);
			const cache = JSON.parse(new TextDecoder().decode(content)) as SummaryCache;

			// Validate version
			if (cache.version !== CACHE_VERSION) {
				this.logger?.warn?.(`Cache version mismatch: ${cache.version} != ${CACHE_VERSION}`);
				return null;
			}

			return cache;
		} catch (error) {
			// Cache file corrupted or invalid - treat as no cache
			this.logger?.warn?.(`Failed to load cache: ${error}`);
			return null;
		}
	}

	/**
	 * Filter blocks that need summarization
	 *
	 * This is the core logic for cache hit/miss determination:
	 * 1. No cache → all blocks need summarization
	 * 2. Config changed → all blocks need summarization
	 * 3. File hash matches → 100% cache hit (fast path)
	 * 4. File hash changed → check each block (slow path)
	 */
	async filterBlocksNeedingSummarization(
		sourceFilePath: string,
		fileContent: string,
		blocks: CodeBlock[],
		config: SummarizerConfig
	): Promise<FilterResult> {
		const currentFileHash = this.hashFile(fileContent);
		const cache = await this.loadCache(sourceFilePath);

		// Case 1: No cache
		if (!cache) {
			return {
				blocks,
				fileSummary: undefined,
				stats: {
					totalBlocks: blocks.length,
					cachedBlocks: 0,
					hitRate: 0,
					invalidReason: 'no-cache'
				}
			};
		}

		// Case 2: Configuration fingerprint mismatch
		const currentFingerprint = this.createFingerprint(config);

		// Explicit field comparison (includes all parameters that affect output)
		const fingerprintChanged =
			cache.fingerprint.provider !== currentFingerprint.provider ||
			cache.fingerprint.modelId !== currentFingerprint.modelId ||
			cache.fingerprint.language !== currentFingerprint.language ||
			cache.fingerprint.promptVersion !== currentFingerprint.promptVersion ||
			cache.fingerprint.temperature !== currentFingerprint.temperature;

		if (fingerprintChanged) {
			this.logger?.info?.(`Config changed, invalidating cache`);
			return {
				blocks,
				fileSummary: undefined,
				stats: {
					totalBlocks: blocks.length,
					cachedBlocks: 0,
					hitRate: 0,
					invalidReason: 'config-changed'
				}
			};
		}

		// Case 3: File hash matches (fast path) → 100% cache hit
		if (cache.fileHash === currentFileHash) {
			const updatedBlocks = blocks.map(block => {
				const currentBlockHash = this.hashBlock(block);
				const cached = cache.blocks[currentBlockHash];
				return {
					...block,
					summary: cached?.summary
				};
			});

			return {
				blocks: updatedBlocks,
				fileSummary: cache.fileSummary,
				stats: {
					totalBlocks: blocks.length,
					cachedBlocks: blocks.length,
					hitRate: 1.0
				}
			};
		}

		// Case 4: File hash changed (slow path) → check each block
		let cachedCount = 0;

		const updatedBlocks = blocks.map(block => {
			const currentBlockHash = this.hashBlock(block);
			const cached = cache.blocks[currentBlockHash];

			// Block hash matches → use cache (even if other parts of file changed)
			// Note: contextHash is not used for cache invalidation, only for metadata
			if (cached && cached.codeHash === currentBlockHash) {
				cachedCount++;
				return {
					...block,
					summary: cached.summary
				};
			}

			// Block hash doesn't match → clear summary, trigger re-generation
			return block;
		});

		return {
			blocks: updatedBlocks,
			fileSummary: undefined,  // File changed, file summary invalid
			stats: {
				totalBlocks: blocks.length,
				cachedBlocks: cachedCount,
				hitRate: blocks.length > 0 ? cachedCount / blocks.length : 1.0,
				invalidReason: 'file-changed'
			}
		};
	}

	/**
	 * Update cache file (atomic operation)
	 */
	async updateCache(
		sourceFilePath: string,
		fileContent: string,
		blocks: CodeBlock[],
		fileSummary: string | undefined,
		config: SummarizerConfig
	): Promise<void> {
		const cachePath = this.getCachePathForSourceFile(sourceFilePath);
		const tempPath = `${cachePath}.tmp.${process.pid}`;
		const fileHash = this.hashFile(fileContent);

		// Build block-level cache (with size limits)
		const blockCache: Record<string, BlockSummary> = {};
		for (const block of blocks) {
			if (block.summary) {
				const codeHash = this.hashBlock(block);

				// Limit: single summary length
				if (block.summary.length > CACHE_LIMITS.MAX_SUMMARY_LENGTH) {
					this.logger?.warn?.(
						`Summary too long (${block.summary.length} chars), skipping cache for block: ${block.name}`
					);
					continue;
				}

				// Limit: blocks per file
				if (Object.keys(blockCache).length >= CACHE_LIMITS.MAX_BLOCKS_PER_FILE) {
					this.logger?.warn?.(
						`Too many blocks (${Object.keys(blockCache).length}), skipping cache for block: ${block.name}`
					);
					continue;
				}

				blockCache[codeHash] = {
					codeHash,
					contextHash: this.hashContext(fileContent),  // Context hash for metadata only
					summary: block.summary,
					metadata: {
						name: block.name,
						startLine: block.startLine,
						endLine: block.endLine
					}
				};
			}
		}

		// Build complete cache
		const cache: SummaryCache = {
			version: CACHE_VERSION,
			fingerprint: this.createFingerprint(config),
			fileHash,
			fileSummary,
			lastAccessed: new Date().toISOString(),
			blocks: blockCache
		};

		// Serialize and check size
		const content = JSON.stringify(cache, null, 2);
		const contentBytes = new TextEncoder().encode(content).length;

		if (contentBytes > CACHE_LIMITS.MAX_CACHE_SIZE_BYTES) {
			this.logger?.warn?.(
				`Cache file too large (${(contentBytes / 1024).toFixed(2)} KB), skipping cache save`
			);
			return;  // Don't save cache, regenerate next time
		}

		// Ensure directory exists
		await fs.mkdir(path.dirname(cachePath), { recursive: true });

		try {
			// 1. Write to temp file
			await this.fileSystem.writeFile(tempPath, new TextEncoder().encode(content));

			// 2. Atomic rename (cross-platform compatible using Node.js fs)
			try {
				await fs.rename(tempPath, cachePath);
			} catch (renameError) {
				// Some filesystems (cross-partition, some Windows configs) may fail rename
				// Fallback: copy + delete
				this.logger?.warn?.(`Rename failed, using copy+delete fallback: ${renameError}`);
				await fs.copyFile(tempPath, cachePath);
				await fs.unlink(tempPath);
			}
		} catch (error) {
			// Clean up temp file
			try {
				await fs.unlink(tempPath);
			} catch { }
			throw error;
		}
	}

	// ============================================================================
	// Cache Cleanup
	// ============================================================================

	/**
	 * Clean orphaned caches (source files that have been deleted)
	 */
	async cleanOrphanedCaches(): Promise<{ removed: number; kept: number }> {
		const projectHash = createHash('sha256')
			.update(this.workspacePath)
			.digest('hex')
			.substring(0, 16);

		const cacheDir = path.join(
			this.storage.getCacheBasePath(),
			'summary-cache',
			projectHash,
			'files'
		);

		let removed = 0;
		let kept = 0;

		// Recursively scan all cache files
		const scanDir = async (dir: string): Promise<void> => {
			try {
					const entries = await this.fileSystem.readdir(dir);

					for (const entry of entries) {
						try {
							const fullPath = path.join(dir, entry);
							const stat = await this.fileSystem.stat(fullPath);

							if (stat.isDirectory) {
								await scanDir(fullPath);
							} else if (fullPath.endsWith('.summary.json')) {
								// Calculate relative path from cache dir
								const relativePath = path.relative(cacheDir, fullPath);
							
								// Reverse calculate source file path
								const sourceRelPath = relativePath.replace('.summary.json', '');
								const sourcePath = path.join(this.workspacePath, sourceRelPath);

								// Check if source file exists
								const exists = await this.fileSystem.exists(sourcePath);
								if (!exists) {
									await this.fileSystem.delete(fullPath);
									removed++;
								} else {
									kept++;
								}
							}
						} catch {
							// Skip entries that can't be stat'd
						}
					}
				} catch {
					// Directory doesn't exist or can't be read
				}
			};

		const exists = await this.fileSystem.exists(cacheDir);
		if (exists) {
			await scanDir(cacheDir);
		}

		if (removed > 0) {
			this.logger?.info?.(`Cleaned ${removed} orphaned cache files`);
		}

		return { removed, kept };
	}

	/**
	 * Clean caches older than N days (LRU cleanup)
	 */
	async cleanOldCaches(maxAgeDays: number = 30): Promise<number> {
		const projectHash = createHash('sha256')
			.update(this.workspacePath)
			.digest('hex')
			.substring(0, 16);

		const cacheDir = path.join(
			this.storage.getCacheBasePath(),
			'summary-cache',
			projectHash,
			'files'
		);

		let removed = 0;
		let kept = 0;
		const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
		const cutoffDate = new Date(Date.now() - maxAgeMs);

		const scanDir = async (dir: string): Promise<void> => {
			try {
					const entries = await this.fileSystem.readdir(dir);

					for (const entry of entries) {
						const fullPath = path.join(dir, entry);

						try {
							const stat = await this.fileSystem.stat(fullPath);

							if (stat.isDirectory) {
								await scanDir(fullPath);
							} else if (fullPath.endsWith('.summary.json')) {
								try {
									const content = await this.fileSystem.readFile(fullPath);
									const cache = JSON.parse(new TextDecoder().decode(content)) as SummaryCache;

									// Check last access time
									const lastAccessed = new Date(cache.lastAccessed);
									const ageMs = Date.now() - lastAccessed.getTime();

									if (ageMs > maxAgeMs) {
										await this.fileSystem.delete(fullPath);
										removed++;
									} else {
										kept++;
									}
								} catch {
									// Invalid or corrupted cache file - delete it
									await this.fileSystem.delete(fullPath);
									removed++;
								}
							}
						} catch {
							// Skip entries that can't be stat'd
						}
					}
				} catch {
					// Directory doesn't exist or can't be read
				}
			};

		const exists = await this.fileSystem.exists(cacheDir);
		if (exists) {
			await scanDir(cacheDir);
		}

		return removed;
	}

	/**
	 * Clear all summary caches for the current project
	 *
	 * Deletes the entire project cache directory.
	 * This is useful when you want to force regenerate all AI summaries.
	 *
	 * @returns Number of cache files deleted (or -1 if directory was removed)
	 */
	async clearAllCaches(): Promise<number> {
		const projectHash = createHash('sha256')
			.update(this.workspacePath)
			.digest('hex')
			.substring(0, 16);

		const projectCacheDir = path.join(
			this.storage.getCacheBasePath(),
			'summary-cache',
			projectHash
		);

		try {
			const exists = await this.fileSystem.exists(projectCacheDir);
			if (!exists) {
				return 0;
			}

			// Count files before deletion
			let fileCount = 0;
			const countFiles = async (dir: string): Promise<void> => {
				try {
					const entries = await this.fileSystem.readdir(dir);
					for (const entry of entries) {
						const fullPath = path.join(dir, entry);
						const stat = await this.fileSystem.stat(fullPath);
						if (stat.isDirectory) {
							await countFiles(fullPath);
						} else {
							fileCount++;
						}
					}
				} catch {
					// Directory doesn't exist or can't be read
				}
			};
			await countFiles(projectCacheDir);

			// Delete the entire project cache directory
			const { promises: fs } = await import('fs');
			await fs.rm(projectCacheDir, { recursive: true, force: true });

			if (fileCount > 0) {
				this.logger?.info?.(`Cleared ${fileCount} summary cache files`);
			}

			return fileCount;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			this.logger?.error?.(`Failed to clear cache: ${errorMsg}`);
			return 0;
		}
	}
}
