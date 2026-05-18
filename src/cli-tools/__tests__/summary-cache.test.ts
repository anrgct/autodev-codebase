/**
 * Unit tests for SummaryCacheManager
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';
// Mock fs.promises to avoid real file system operations
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      copyFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined)
    }
  };
});

describe('SummaryCacheManager', () => {
  const mockStorage = {
    getCacheBasePath: vi.fn().mockReturnValue('/home/user/.autodev-cache')
  };

  const createMockFileSystem = () => ({
    exists: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    stat: vi.fn(),
    readdir: vi.fn(),
    mkdir: vi.fn(),
    delete: vi.fn()
  });

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('hash utilities', () => {
    it('should calculate consistent hash for same content', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any
      );

      const block = {
        name: 'testFunc',
        type: 'function',
        startLine: 1,
        endLine: 5,
        fullText: 'function test() { return true; }'
      };

      const hash1 = cacheManager.hashBlock(block);
      const hash2 = cacheManager.hashBlock(block);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 hex length
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should calculate different hashes for different content', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any
      );

      const block1 = {
        name: 'func1',
        type: 'function',
        startLine: 1,
        endLine: 5,
        fullText: 'function test() { return true; }'
      };

      const block2 = {
        name: 'func2',
        type: 'function',
        startLine: 6,
        endLine: 10,
        fullText: 'function test() { return false; }'
      };

      expect(cacheManager.hashBlock(block1)).not.toBe(cacheManager.hashBlock(block2));
    });

    it('should hash file content correctly', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any
      );

      const content = 'const x = 42;';
      const hash1 = cacheManager.hashFile(content);
      const hash2 = cacheManager.hashFile(content);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });
  });

  describe('configuration fingerprint', () => {
    it('should create fingerprint from config', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any
      );

      const config = {
        provider: 'ollama' as const,
        ollamaModelId: 'llama3.2',
        language: 'English' as const,
        temperature: 0.7
      };

      const fingerprint = cacheManager.createFingerprint(config);

      expect(fingerprint).toEqual({
        provider: 'ollama',
        modelId: 'llama3.2',
        language: 'English',
        promptVersion: '1.0',
        temperature: 0.7
      });
    });

    it('should use openai-compatible model ID', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any
      );

      const config = {
        provider: 'openai-compatible' as const,
        openAiCompatibleModelId: 'gpt-4',
        language: 'Chinese' as const
      };

      const fingerprint = cacheManager.createFingerprint(config);

      expect(fingerprint.modelId).toBe('gpt-4');
    });

    it('should detect config changes', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any
      );

      const config1 = {
        provider: 'ollama' as const,
        ollamaModelId: 'llama3.2',
        language: 'English' as const
      };

      const config2 = {
        provider: 'ollama' as const,
        ollamaModelId: 'llama3.2',
        language: 'Chinese' as const
      };

      const fp1 = cacheManager.createFingerprint(config1);
      const fp2 = cacheManager.createFingerprint(config2);

      expect(fp1.language).not.toBe(fp2.language);
    });
  });

  describe('cache path mapping', () => {
    it('should generate correct cache path', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any
      );

      const sourcePath = '/workspace/src/utils/helper.ts';
      const cachePath = cacheManager.getCachePathForSourceFile(sourcePath);

      expect(cachePath).toContain('.autodev-cache/summary-cache/');
      expect(cachePath).toContain('/files/');
      expect(cachePath).toContain('src/utils/helper.ts.summary.json');
    });

    it('should throw error for path traversal attacks', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any
      );

      const maliciousPath = '/workspace/../../../etc/passwd';

      expect(() => {
        cacheManager.getCachePathForSourceFile(maliciousPath);
      }).toThrow('Source file must be within workspace path');
    });

    it('should throw error for absolute path outside workspace', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any
      );

      const outsidePath = '/etc/config';

      expect(() => {
        cacheManager.getCachePathForSourceFile(outsidePath);
      }).toThrow();
    });
  });

  describe('cache hit/miss scenarios', () => {
    it('should return no-cache scenario when cache file does not exist', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      mockFileSystem.exists.mockResolvedValue(false);

      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any
      );

      const blocks = [{
        name: 'func1',
        type: 'function',
        startLine: 1,
        endLine: 5,
        fullText: 'function test() {}'
      }];

      const config = {
        provider: 'ollama' as const,
        ollamaModelId: 'llama3.2',
        language: 'English' as const
      };

      const result = await cacheManager.filterBlocksNeedingSummarization(
        '/workspace/test.ts',
        'const x = 1;',
        blocks,
        config
      );

      expect(result.stats.hitRate).toBe(0);
      expect(result.stats.invalidReason).toBe('no-cache');
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].summary).toBeUndefined();
    });

    it('should detect configuration changes', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(
        new TextEncoder().encode(JSON.stringify({
          version: '1.0',
          fingerprint: {
            provider: 'ollama',
            modelId: 'llama3.2',
            language: 'English',
            promptVersion: '1.0'
          },
          fileHash: 'abc123',
          lastAccessed: new Date().toISOString(),
          blocks: {}
        }, null, 2))
      );

      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any,
        mockLogger
      );

      const blocks = [{
        name: 'func1',
        type: 'function',
        startLine: 1,
        endLine: 5,
        fullText: 'function test() {}'
      }];

      const config = {
        provider: 'ollama' as const,
        ollamaModelId: 'llama3.1', // Different model
        language: 'English' as const
      };

      const result = await cacheManager.filterBlocksNeedingSummarization(
        '/workspace/test.ts',
        'const x = 1;',
        blocks,
        config
      );

      expect(result.stats.hitRate).toBe(0);
      expect(result.stats.invalidReason).toBe('config-changed');
    });

    it('should achieve 100% cache hit when file hash matches', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();

      const fileContent = 'function test() { return true; }';
      const fileHash = createHash('sha256').update(fileContent).digest('hex');

      const blockContent = 'function test() { return true; }';
      const blockHash = createHash('sha256').update(blockContent).digest('hex');

      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(
        new TextEncoder().encode(JSON.stringify({
          version: '1.0',
          fingerprint: {
            provider: 'ollama',
            modelId: 'llama3.2',
            language: 'English',
            promptVersion: '1.0'
          },
          fileHash: fileHash,
          fileSummary: 'Test file summary',
          lastAccessed: new Date().toISOString(),
          blocks: {
            [blockHash]: {
              codeHash: blockHash,
              contextHash: fileHash,
              summary: 'Cached summary'
            }
          }
        }, null, 2))
      );

      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any
      );

      const blocks = [{
        name: 'func1',
        type: 'function',
        startLine: 1,
        endLine: 1,
        fullText: blockContent
      }];

      const config = {
        provider: 'ollama' as const,
        ollamaModelId: 'llama3.2',
        language: 'English' as const
      };

      const result = await cacheManager.filterBlocksNeedingSummarization(
        '/workspace/test.ts',
        fileContent,
        blocks,
        config
      );

      expect(result.stats.hitRate).toBe(1.0);
      expect(result.stats.cachedBlocks).toBe(1);
      expect(result.blocks[0].summary).toBe('Cached summary');
      expect(result.fileSummary).toBe('Test file summary');
    });

    it('should handle partial cache hits when file changed', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();

      const unchangedBlock = 'function oldFunc() { return 1; }';
      const unchangedBlockHash = createHash('sha256').update(unchangedBlock).digest('hex');

      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(
        new TextEncoder().encode(JSON.stringify({
          version: '1.0',
          fingerprint: {
            provider: 'ollama',
            modelId: 'llama3.2',
            language: 'English',
            promptVersion: '1.0'
          },
          fileHash: 'old-hash',
          lastAccessed: new Date().toISOString(),
          blocks: {
            [unchangedBlockHash]: {
              codeHash: unchangedBlockHash,
              contextHash: 'old-context',
              summary: 'Cached for oldFunc'
            }
          }
        }, null, 2))
      );

      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any
      );

      const blocks = [
        {
          name: 'oldFunc',
          type: 'function',
          startLine: 1,
          endLine: 1,
          fullText: unchangedBlock
        },
        {
          name: 'newFunc',
          type: 'function',
          startLine: 2,
          endLine: 2,
          fullText: 'function newFunc() { return 2; }'
        }
      ];

      const config = {
        provider: 'ollama' as const,
        ollamaModelId: 'llama3.2',
        language: 'English' as const
      };

      const result = await cacheManager.filterBlocksNeedingSummarization(
        '/workspace/test.ts',
        'modified file content',
        blocks,
        config
      );

      expect(result.stats.invalidReason).toBe('file-changed');
      expect(result.stats.hitRate).toBe(0.5); // 1 of 2 blocks cached
      expect(result.blocks[0].summary).toBe('Cached for oldFunc');
      expect(result.blocks[1].summary).toBeUndefined();
    });
  });

  describe('cache update operations', () => {
    it('should save cache with correct structure', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      mockFileSystem.stat.mockResolvedValue({
        isDirectory: () => false,
        isFile: () => true
      });

      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any,
        mockLogger
      );

      const blocks = [{
        name: 'func1',
        type: 'function',
        startLine: 1,
        endLine: 3,
        fullText: 'function test() { return true; }',
        summary: 'AI generated summary'
      }];

      const config = {
        provider: 'ollama' as const,
        ollamaModelId: 'llama3.2',
        language: 'English' as const,
        temperature: 0.7
      };

      await cacheManager.updateCache(
        '/workspace/test.ts',
        'const x = 1;',
        blocks,
        'File summary',
        config
      );

      expect(mockFileSystem.writeFile).toHaveBeenCalled();
      const writtenContent = mockFileSystem.writeFile.mock.calls[0][1];
      const cache = JSON.parse(new TextDecoder().decode(writtenContent));

      expect(cache.version).toBe('1.0');
      expect(cache.fingerprint.provider).toBe('ollama');
      expect(cache.fingerprint.modelId).toBe('llama3.2');
      expect(cache.fingerprint.language).toBe('English');
      expect(cache.fingerprint.temperature).toBe(0.7);
      expect(cache.fileSummary).toBe('File summary');
      expect(cache.blocks).toBeDefined();
    });

    it('should skip cache if size exceeds limit', async () => {
      const { SummaryCacheManager, CACHE_LIMITS } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      mockFileSystem.stat.mockResolvedValue({
        isDirectory: () => false,
        isFile: () => true
      });

      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any,
        mockLogger
      );

      // Create a very large summary to exceed size limit
      const largeSummary = 'x'.repeat(CACHE_LIMITS.MAX_SUMMARY_LENGTH + 1000);

      const blocks = [{
        name: 'func1',
        type: 'function',
        startLine: 1,
        endLine: 3,
        fullText: 'function test() {}',
        summary: largeSummary
      }];

      const config = {
        provider: 'ollama' as const,
        ollamaModelId: 'llama3.2',
        language: 'English' as const
      };

      await cacheManager.updateCache(
        '/workspace/test.ts',
        'small content',
        blocks,
        undefined,
        config
      );

      // Should skip write and log warning
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Summary too long')
      );
    });
  });

  describe('cache cleanup', () => {
    it('should clean orphaned cache files', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();

      // Mock project hash calculation
      const mockProjectHash = 'c52ddf65534b7b46';
      const cacheDir = `/home/user/.autodev-cache/summary-cache/${mockProjectHash}/files`;

      // Mock exists to handle both cache directory and source files
      mockFileSystem.exists.mockImplementation(async (path: string) => {
        if (path === cacheDir) return true;
        // Only src/utils/helper.ts exists, others are orphaned
        if (path === '/workspace/src/utils/helper.ts') return true;
        if (path === '/workspace/src/components/button.ts') return false;
        if (path === '/workspace/nested/dir/config.json') return false;
        return false;
      });

      // Mock readdir to return entry names (not full paths, per IFileSystem spec)
      mockFileSystem.readdir.mockImplementation(async (dir: string) => {
        if (dir === cacheDir) {
          return [
            `src/utils/helper.ts.summary.json`,
            `src/components/button.ts.summary.json`,
            `nested/dir/config.json.summary.json`
          ];
        }
        // No subdirectories to scan
        return [];
      });

      // Mock stat for files (no directories in this test)
      mockFileSystem.stat.mockImplementation(async (path: string) => {
        return {
          isFile: true,
          isDirectory: false,
          size: 100,
          mtime: Date.now()
        };
      });

      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any,
        mockLogger
      );

      const result = await cacheManager.cleanOrphanedCaches();

      expect(result.removed).toBe(2); // 2 orphaned files
      expect(result.kept).toBe(1);   // 1 file kept
      expect(mockFileSystem.delete).toHaveBeenCalledTimes(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Cleaned 2 orphaned cache files')
      );
    });

    it('should clean old caches based on last access time', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();

      // Mock project hash calculation
      const mockProjectHash = 'c52ddf65534b7b46';
      const cacheDir = `/home/user/.autodev-cache/summary-cache/${mockProjectHash}/files`;

      // Mock exists for cache directory
      mockFileSystem.exists.mockResolvedValue(true);

      // Mock readdir to return entry names (no subdirectories to simplify)
      mockFileSystem.readdir.mockResolvedValue([
        'file1.summary.json',
        'file2.summary.json',
        'file3.summary.json'
      ]);

      // Mock stat for files (all are files, no directories)
      mockFileSystem.stat.mockImplementation(async (path: string) => {
        return {
          isFile: true,
          isDirectory: false,
          size: 100,
          mtime: Date.now()
        };
      });

      // Mock readFile for cache content
      const now = new Date();
      const oldDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
      const recentDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days ago

      mockFileSystem.readFile.mockImplementation(async (path: string) => {
        if (path.includes('file1.summary.json')) {
          // Old cache (60 days)
          return new TextEncoder().encode(JSON.stringify({
            version: '1.0',
            fingerprint: { provider: 'ollama', modelId: 'llama3.2', language: 'English', promptVersion: '1.0' },
            fileHash: 'hash1',
            lastAccessed: oldDate.toISOString(),
            blocks: {}
          }));
        }
        if (path.includes('file2.summary.json')) {
          // Recent cache (5 days)
          return new TextEncoder().encode(JSON.stringify({
            version: '1.0',
            fingerprint: { provider: 'ollama', modelId: 'llama3.2', language: 'English', promptVersion: '1.0' },
            fileHash: 'hash2',
            lastAccessed: recentDate.toISOString(),
            blocks: {}
          }));
        }
        if (path.includes('file3.summary.json')) {
          // Corrupted cache
          return new TextEncoder().encode('invalid json');
        }
        return new TextEncoder().encode('');
      });

      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any,
        mockLogger
      );

      // Clean caches older than 30 days
      const removed = await cacheManager.cleanOldCaches(30);

      expect(removed).toBe(2); // file1 (old) + file3 (corrupted)
      expect(mockFileSystem.delete).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('should handle corrupted cache file gracefully', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(
        new TextEncoder().encode('invalid json{{{')
      );

      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any,
        mockLogger
      );

      const blocks = [{
        name: 'func1',
        type: 'function',
        startLine: 1,
        endLine: 5,
        fullText: 'function test() {}'
      }];

      const config = {
        provider: 'ollama' as const,
        ollamaModelId: 'llama3.2',
        language: 'English' as const
      };

      const result = await cacheManager.filterBlocksNeedingSummarization(
        '/workspace/test.ts',
        'const x = 1;',
        blocks,
        config
      );

      // Should treat as no cache
      expect(result.stats.invalidReason).toBe('no-cache');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load cache')
      );
    });

    it('should handle cache version mismatch', async () => {
      const { SummaryCacheManager } = await import('../summary-cache');
      const mockFileSystem = createMockFileSystem();
      mockFileSystem.exists.mockResolvedValue(true);
      mockFileSystem.readFile.mockResolvedValue(
        new TextEncoder().encode(JSON.stringify({
          version: '0.5', // Wrong version
          fingerprint: { provider: 'ollama', modelId: 'llama3.2', language: 'English', promptVersion: '1.0' },
          fileHash: 'abc',
          lastAccessed: new Date().toISOString(),
          blocks: {}
        }, null, 2))
      );

      const cacheManager = new SummaryCacheManager(
        '/workspace',
        mockStorage as any,
        mockFileSystem as any,
        mockLogger
      );

      const blocks = [{
        name: 'func1',
        type: 'function',
        startLine: 1,
        endLine: 5,
        fullText: 'function test() {}'
      }];

      const config = {
        provider: 'ollama' as const,
        ollamaModelId: 'llama3.2',
        language: 'English' as const
      };

      const result = await cacheManager.filterBlocksNeedingSummarization(
        '/workspace/test.ts',
        'const x = 1;',
        blocks,
        config
      );

      expect(result.stats.invalidReason).toBe('no-cache');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cache version mismatch')
      );
    });
  });
});
