/**
 * Unit tests for outline CLI tool
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OutlineOptions } from '../outline';
import { loadRequiredLanguageParsers } from '../../tree-sitter/languageParser';

// Mock SummaryCacheManager to avoid real file system operations in summarizer tests
vi.mock('../summary-cache', () => ({
	SummaryCacheManager: vi.fn().mockImplementation(() => ({
		filterBlocksNeedingSummarization: vi.fn().mockImplementation((sourceFilePath, fileContent, blocks) => {
			return Promise.resolve({
				blocks,
				fileSummary: undefined,
				stats: { totalBlocks: blocks.length, cachedBlocks: 0, hitRate: 0 }
			});
		}),
		updateCache: vi.fn().mockResolvedValue(undefined),
		cleanOrphanedCaches: vi.fn().mockResolvedValue(undefined)
	}))
}));

vi.mock('../../tree-sitter', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../tree-sitter')>();
	return {
		...actual,
		getMinComponentLines: () => 1,
		parseSourceCodeDefinitionsForFile: vi.fn(async (filePath: string, deps: any) => {
			await deps.fileSystem.readFile(filePath);
			if (!/\.(ts|tsx|js|jsx|py|md|markdown)$/.test(filePath)) {
				return undefined;
			}
			return `# ${deps.pathUtils.basename(filePath)}\n   1--2 | outline`;
		})
	};
});

vi.mock('../../tree-sitter/languageParser', () => ({
	loadRequiredLanguageParsers: vi.fn()
}));

const mockPathUtils = {
	isAbsolute: (path: string) => path.startsWith('/'),
	join: (...parts: string[]) => parts.join('/'),
	extname: (path: string) => {
		const match = path.match(/\.[^.]+$/);
		return match ? match[0] : '';
	},
	basename: (path: string) => path.split('/').pop() || path,
	relative: (from: string, to: string) => to.replace(from, '').replace(/^\//, ''),
	normalize: (path: string) => path,
	resolve: (...parts: string[]) => parts.join('/'),
	dirname: (path: string) => path.substring(0, path.lastIndexOf('/')) || '.'
};

const mockFileSystem = {
	exists: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
	stat: vi.fn(),
	readdir: vi.fn(),
	mkdir: vi.fn(),
	delete: vi.fn()
};

const mockWorkspace = {
	shouldIgnore: vi.fn(),
	findFiles: vi.fn(),
	folderPaths: [],
	addFolder: vi.fn(),
	removeFolder: vi.fn(),
	getFolderByPath: vi.fn(),
	getRelativePath: vi.fn((filePath: string) => {
		if (filePath.startsWith('/workspace/')) {
			return filePath.substring('/workspace/'.length);
		}
		return filePath.split('/').pop() || filePath;
	}),
	getName: vi.fn(() => 'test-workspace')
};

const mockLogger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn()
};

const sampleTypeScriptCode = `
interface User {
  id: number;
  name: string;
}

class UserService {
  private users: User[] = [];

  async getUserById(id: number): Promise<User | undefined> {
    return this.users.find(u => u.id === id);
  }

  async addUser(user: User): Promise<void> {
    this.users.push(user);
  }
}

function createUser(name: string): User {
  return { id: Date.now(), name };
}
`;

const samplePythonCode = `
class Calculator:
    def __init__(self):
        self.result = 0

    def add(self, a, b):
        return a + b

    def subtract(self, a, b):
        return a - b

def main():
    calc = Calculator()
    print(calc.add(1, 2))
`;



describe('extractOutline', () => {
	describe('should extract outline as text', () => {
		it('should extract outline as text for TypeScript file', async () => {
			const { extractOutline } = await import('../outline');
			const filePath = '/workspace/src/test.ts';
			const workspacePath = '/workspace';

			mockFileSystem.exists.mockResolvedValue(true);
			mockFileSystem.readFile.mockResolvedValue(
				new TextEncoder().encode(sampleTypeScriptCode)
			);
			mockWorkspace.shouldIgnore.mockResolvedValue(false);

			const options: OutlineOptions = {
				filePath,
				workspacePath,
				json: false,
				fileSystem: mockFileSystem as any,
				pathUtils: mockPathUtils as any,
				logger: mockLogger as any
			};

			const ts = {
				parser: {
					parse: vi.fn().mockReturnValue({ rootNode: {} })
				},
				query: {
					captures: vi.fn().mockReturnValue([
						{
							name: 'definition.function',
							node: {
								startPosition: { row: 9, column: 2 },
								endPosition: { row: 12, column: 3 },
								type: 'function_declaration',
								text: sampleTypeScriptCode.split('\n').slice(9, 13).join('\n')
							}
						},
						{
							name: 'name.definition.function',
							node: {
								startPosition: { row: 9, column: 11 },
								endPosition: { row: 9, column: 23 },
								text: 'getUserById'
							}
						}
					])
				}
			};

			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({ ts: ts as any });

			const result = await extractOutline(options);

			expect(result).toBeDefined();
			expect(typeof result).toBe('string');
			expect(result).toContain('getUserById');
		});

		it('should extract outline as text for Python file', async () => {
			const { extractOutline } = await import('../outline');
			const filePath = 'test.py';
			const workspacePath = '/workspace';

			mockFileSystem.exists.mockResolvedValue(true);
			mockFileSystem.readFile.mockResolvedValue(
				new TextEncoder().encode(samplePythonCode)
			);
			mockWorkspace.shouldIgnore.mockResolvedValue(false);

			const options: OutlineOptions = {
				filePath,
				workspacePath,
				json: false,
				fileSystem: mockFileSystem as any,
				pathUtils: mockPathUtils as any,
				logger: mockLogger as any
			};

			const py = {
				parser: {
					parse: vi.fn().mockReturnValue({ rootNode: {} })
				},
				query: {
					captures: vi.fn().mockReturnValue([
						{
							name: 'definition.class',
							node: {
								startPosition: { row: 1, column: 0 },
								endPosition: { row: 9, column: 3 },
								type: 'class_definition',
								text: samplePythonCode.split('\n').slice(1, 10).join('\n')
							}
						},
						{
							name: 'name.definition.class',
							node: {
								startPosition: { row: 1, column: 6 },
								endPosition: { row: 1, column: 16 },
								text: 'Calculator'
							}
						}
					])
				}
			};

			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({ py: py as any });

			const result = await extractOutline(options);

			expect(result).toBeDefined();
			expect(typeof result).toBe('string');
			expect(result).toContain('test.py');
		});

		it('should extract outline as JSON', async () => {
			const { extractOutline } = await import('../outline');
			const filePath = '/workspace/src/test.ts';
			const workspacePath = '/workspace';

			mockFileSystem.exists.mockResolvedValue(true);
			mockFileSystem.readFile.mockResolvedValue(
				new TextEncoder().encode(sampleTypeScriptCode)
			);
			mockWorkspace.shouldIgnore.mockResolvedValue(false);

			const options: OutlineOptions = {
				filePath,
				workspacePath,
				json: true,
				fileSystem: mockFileSystem as any,
				pathUtils: mockPathUtils as any,
				logger: mockLogger as any
			};

			const ts = {
				parser: {
					parse: vi.fn().mockReturnValue({ rootNode: {} })
				},
				query: {
					captures: vi.fn().mockReturnValue([
						{
							name: 'definition.function',
							node: {
								startPosition: { row: 9, column: 2 },
								endPosition: { row: 12, column: 3 },
								type: 'function_declaration',
								text: sampleTypeScriptCode.split('\n').slice(9, 13).join('\n')
							}
						},
						{
							name: 'name.definition.function',
							node: {
								startPosition: { row: 9, column: 11 },
								endPosition: { row: 9, column: 23 },
								text: 'getUserById'
							}
						}
					])
				}
			};

			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({ ts: ts as any });

			const result = await extractOutline(options);
			const parsed = JSON.parse(result);

			expect(parsed).toBeDefined();
			expect(parsed.filePath).toBe('/workspace/src/test.ts');
			expect(parsed.language).toBe('ts');
			expect(parsed.definitions).toBeDefined();
			expect(parsed.definitions.length).toBeGreaterThan(0);
			expect(parsed.definitions[0].name).toBe('getUserById');
		});

		it('should include wasTruncated and textLength in JSON output', async () => {
			const { extractOutline } = await import('../outline');
			const filePath = '/workspace/src/test.ts';
			const workspacePath = '/workspace';

			mockFileSystem.exists.mockResolvedValue(true);
			mockFileSystem.readFile.mockResolvedValue(
				new TextEncoder().encode(sampleTypeScriptCode)
			);
			mockWorkspace.shouldIgnore.mockResolvedValue(false);

			const options: OutlineOptions = {
				filePath,
				workspacePath,
				json: true,
				fileSystem: mockFileSystem as any,
				pathUtils: mockPathUtils as any,
				logger: mockLogger as any
			};

			const ts = {
				parser: {
					parse: vi.fn().mockReturnValue({ rootNode: {} })
				},
				query: {
					captures: vi.fn().mockReturnValue([
						{
							name: 'definition.function',
							node: {
								startPosition: { row: 9, column: 2 },
								endPosition: { row: 12, column: 3 },
								type: 'function_declaration',
								text: sampleTypeScriptCode.split('\n').slice(9, 13).join('\n')
							}
						},
						{
							name: 'name.definition.function',
							node: {
								startPosition: { row: 9, column: 11 },
								endPosition: { row: 9, column: 23 },
								text: 'getUserById'
							}
						}
					])
				}
			};

			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({ ts: ts as any });

			const result = await extractOutline(options);
			const parsed = JSON.parse(result);
			const firstDef = parsed.definitions[0];

			expect(firstDef.wasTruncated).toBeDefined();
			expect(firstDef.textLength).toBeDefined();
		});

		it('should truncate text in JSON output', async () => {
			const { extractOutline } = await import('../outline');
			const longCode = 'function longFunction() {\n' + 'console.log("line");\n'.repeat(200) + '}';
			const filePath = '/src/test.ts';
			const workspacePath = '/workspace';

			mockFileSystem.exists.mockResolvedValue(true);
			mockFileSystem.readFile.mockResolvedValue(new TextEncoder().encode(longCode));
			mockWorkspace.shouldIgnore.mockResolvedValue(false);

			const options: OutlineOptions = {
				filePath,
				workspacePath,
				json: true,
				fileSystem: mockFileSystem as any,
				pathUtils: mockPathUtils as any,
				logger: mockLogger as any
			};

			const ts = {
				parser: {
					parse: vi.fn().mockReturnValue({ rootNode: {} })
				},
				query: {
					captures: vi.fn().mockReturnValue([
						{
							name: 'definition.function',
							node: {
								startPosition: { row: 0, column: 0 },
								endPosition: { row: 202, column: 1 },
								type: 'function_declaration',
								text: longCode
							}
						},
						{
							name: 'name.definition.function',
							node: {
								startPosition: { row: 0, column: 9 },
								endPosition: { row: 0, column: 22 },
								text: 'longFunction'
							}
						}
					])
				}
			};

			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({ ts: ts as any });

			const result = await extractOutline(options);
			const parsed = JSON.parse(result);
			const def = parsed.definitions[0];

			expect(def.wasTruncated).toBe(true);
			expect(def.text).toContain('...');
			expect(def.textLength).toBeGreaterThan(def.text.length);
		});

		describe('summarizer integration', () => {
			beforeEach(() => {
				vi.clearAllMocks();
			});

			it('should generate AI summaries when summarize=true', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = 'src/test.ts';
				const workspacePath = '/workspace';

				mockFileSystem.exists.mockResolvedValue(true);
				mockFileSystem.readFile.mockResolvedValue(
					new TextEncoder().encode(sampleTypeScriptCode)
				);
				mockWorkspace.shouldIgnore.mockResolvedValue(false);

				const options: OutlineOptions = {
					filePath,
					workspacePath,
					json: false,
					summarize: true,
					fileSystem: mockFileSystem as any,
					pathUtils: mockPathUtils as any,
					logger: mockLogger as any
				};

				vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
					ts: {
						parser: {
							parse: vi.fn().mockReturnValue({ rootNode: {} })
						},
						query: {
							captures: vi.fn().mockReturnValue([
								{
									name: 'definition.function',
									node: {
										startPosition: { row: 9, column: 2 },
										endPosition: { row: 12, column: 3 },
										type: 'function_declaration',
										text: sampleTypeScriptCode.split('\n').slice(9, 13).join('\n')
									}
								},
								{
									name: 'name.definition.function',
									node: {
										startPosition: { row: 9, column: 11 },
										endPosition: { row: 9, column: 23 },
										text: 'getUserById'
									}
								},
								{
									name: 'definition.function',
									node: {
										startPosition: { row: 14, column: 2 },
										endPosition: { row: 16, column: 3 },
										type: 'function_declaration',
										text: sampleTypeScriptCode.split('\n').slice(14, 17).join('\n')
									}
								},
								{
									name: 'name.definition.function',
									node: {
										startPosition: { row: 14, column: 11 },
										endPosition: { row: 14, column: 19 },
										text: 'addUser'
									}
								}
							])
						}
					}
				} as any);

				const result = await extractOutline(options);

				expect(result).toBeDefined();
				expect(typeof result).toBe('string');
			});

			it('should include summaries in JSON output when summarize=true', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = 'src/test.ts';
				const workspacePath = '/workspace';

				mockFileSystem.exists.mockResolvedValue(true);
				mockFileSystem.readFile.mockResolvedValue(
					new TextEncoder().encode(sampleTypeScriptCode)
				);
				mockWorkspace.shouldIgnore.mockResolvedValue(false);

				const options: OutlineOptions = {
					filePath,
					workspacePath,
					json: true,
					summarize: true,
					fileSystem: mockFileSystem as any,
					pathUtils: mockPathUtils as any,
					logger: mockLogger as any
				};

				vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
					ts: {
						parser: {
							parse: vi.fn().mockReturnValue({ rootNode: {} })
						},
						query: {
							captures: vi.fn().mockReturnValue([
								{
									name: 'definition.function',
									node: {
										startPosition: { row: 9, column: 2 },
										endPosition: { row: 12, column: 3 },
										type: 'function_declaration',
										text: sampleTypeScriptCode.split('\n').slice(9, 13).join('\n')
									}
								},
								{
									name: 'name.definition.function',
									node: {
										startPosition: { row: 9, column: 11 },
										endPosition: { row: 9, column: 23 },
										text: 'getUserById'
									}
								}
							])
						}
					}
				} as any);

				const result = await extractOutline(options);
				const parsed = JSON.parse(result);

				expect(parsed).toBeDefined();
				expect(parsed.definitions).toBeDefined();
			});

			it('should skip very large blocks (>1000 lines) when summarizing', async () => {
				const { extractOutline } = await import('../outline');
				const largeCode = 'function largeFunction() {\n' + 'console.log("line");\n'.repeat(1002) + '}';
				const filePath = 'src/test.ts';
				const workspacePath = '/workspace';

				mockFileSystem.exists.mockResolvedValue(true);
				mockFileSystem.readFile.mockResolvedValue(new TextEncoder().encode(largeCode));
				mockWorkspace.shouldIgnore.mockResolvedValue(false);

				const options: OutlineOptions = {
					filePath,
					workspacePath,
					json: true,
					summarize: true,
					fileSystem: mockFileSystem as any,
					pathUtils: mockPathUtils as any,
					logger: mockLogger as any
				};

				vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
					ts: {
						parser: {
							parse: vi.fn().mockReturnValue({ rootNode: {} })
						},
						query: {
							captures: vi.fn().mockReturnValue([
								{
									name: 'definition.function',
									node: {
										startPosition: { row: 0, column: 0 },
										endPosition: { row: 1004, column: 1 },
										type: 'function_declaration',
										text: 'function largeFunction() {...}'
									}
								},
								{
									name: 'name.definition.function',
									node: {
										startPosition: { row: 0, column: 9 },
										endPosition: { row: 0, column: 23 },
										text: 'largeFunction'
									}
								}
							])
						}
					}
				} as any);

				const result = await extractOutline(options);
				const parsed = JSON.parse(result);
				expect(parsed.definitions).toBeDefined();
				expect(parsed.definitions.length).toBeGreaterThan(0);
			});

			it('should handle summarizer errors gracefully', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = 'src/test.ts';
				const workspacePath = '/workspace';
				const invalidConfigPath = '/nonexistent/config.json';

				mockFileSystem.exists.mockResolvedValue(true);
				mockFileSystem.readFile.mockResolvedValue(
					new TextEncoder().encode(sampleTypeScriptCode)
				);
				mockWorkspace.shouldIgnore.mockResolvedValue(false);

				const options: OutlineOptions = {
					filePath,
					workspacePath,
					json: false,
					summarize: true,
					configPath: invalidConfigPath,
					fileSystem: mockFileSystem as any,
					pathUtils: mockPathUtils as any,
					logger: mockLogger as any
				};

				vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
					ts: {
						parser: {
							parse: vi.fn().mockReturnValue({ rootNode: {} })
						},
						query: {
							captures: vi.fn().mockReturnValue([
								{
									name: 'definition.function',
									node: {
										startPosition: { row: 9, column: 2 },
										endPosition: { row: 12, column: 3 },
										type: 'function_declaration',
										text: sampleTypeScriptCode.split('\n').slice(9, 13).join('\n')
									}
								},
								{
									name: 'name.definition.function',
									node: {
										startPosition: { row: 9, column: 11 },
										endPosition: { row: 9, column: 23 },
										text: 'getUserById'
									}
								}
							])
						}
					}
				} as any);

				const result = await extractOutline(options);
				expect(result).toBeDefined();
			});

			it('should log warning when summarizer is not configured', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = 'src/test.ts';
				const workspacePath = '/workspace';
				const nonExistentConfigPath = '/nonexistent/config.json';

				mockFileSystem.exists.mockResolvedValue(true);
				mockFileSystem.readFile.mockResolvedValue(
					new TextEncoder().encode(sampleTypeScriptCode)
				);
				mockWorkspace.shouldIgnore.mockResolvedValue(false);

				const options: OutlineOptions = {
					filePath,
					workspacePath,
					json: false,
					summarize: true,
					configPath: nonExistentConfigPath,
					fileSystem: mockFileSystem as any,
					pathUtils: mockPathUtils as any,
					logger: mockLogger as any
				};

				vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
					ts: {
						parser: {
							parse: vi.fn().mockReturnValue({ rootNode: {} })
						},
						query: {
							captures: vi.fn().mockReturnValue([
								{
									name: 'definition.function',
									node: {
										startPosition: { row: 9, column: 2 },
										endPosition: { row: 12, column: 3 },
										type: 'function_declaration',
										text: sampleTypeScriptCode.split('\n').slice(9, 13).join('\n')
									}
								},
								{
									name: 'name.definition.function',
									node: {
										startPosition: { row: 9, column: 11 },
										endPosition: { row: 9, column: 23 },
										text: 'getUserById'
									}
								}
							])
						}
					}
				} as any);

				const result = await extractOutline(options);
				expect(result).toBeDefined();
			});
		});

		describe('error handling', () => {
			it('should throw error for non-existent file', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = '/src/nonexistent.ts';
				const workspacePath = '/workspace';

				mockFileSystem.exists.mockResolvedValue(false);

				const options: OutlineOptions = {
					filePath,
					workspacePath,
					json: false,
					fileSystem: mockFileSystem as any,
					pathUtils: mockPathUtils as any,
					logger: mockLogger as any
				};

				await expect(extractOutline(options)).rejects.toThrow();
			});

			it('should resolve relative paths using pathUtils', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = 'src/test.ts';
				const workspacePath = '/workspace';

				mockFileSystem.exists.mockResolvedValue(true);
				mockFileSystem.readFile.mockResolvedValue(
					new TextEncoder().encode(sampleTypeScriptCode)
				);
				mockWorkspace.shouldIgnore.mockResolvedValue(false);

				const options: OutlineOptions = {
					filePath,
					workspacePath,
					json: false,
					fileSystem: mockFileSystem as any,
					pathUtils: mockPathUtils as any,
					logger: mockLogger as any
				};

				await extractOutline(options);

				expect(mockFileSystem.readFile).toHaveBeenCalledWith('/workspace/src/test.ts');
			});

			it('should use fileSystem.readFile instead of fs.promises', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = '/workspace/src/test.ts';
				const workspacePath = '/workspace';

				mockFileSystem.exists.mockResolvedValue(true);
				mockFileSystem.readFile.mockResolvedValue(
					new TextEncoder().encode(sampleTypeScriptCode)
				);
				mockWorkspace.shouldIgnore.mockResolvedValue(false);

				const options: OutlineOptions = {
					filePath,
					workspacePath,
					json: false,
					fileSystem: mockFileSystem as any,
					pathUtils: mockPathUtils as any,
					logger: mockLogger as any
				};

				vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
					ts: {
						parser: {
							parse: vi.fn().mockReturnValue({ rootNode: {} })
						},
						query: {
							captures: vi.fn().mockReturnValue([
								{
									name: 'definition.function',
									node: {
										startPosition: { row: 9, column: 2 },
										endPosition: { row: 12, column: 3 },
										type: 'function_declaration',
										text: sampleTypeScriptCode.split('\n').slice(9, 13).join('\n')
									}
								},
								{
									name: 'name.definition.function',
									node: {
										startPosition: { row: 9, column: 11 },
										endPosition: { row: 9, column: 23 },
										text: 'getUserById'
									}
								}
							])
						}
					}
				} as any);

				await extractOutline(options);

				expect(mockFileSystem.readFile).toHaveBeenCalled();
				expect(mockFileSystem.readFile).toHaveBeenCalledWith(filePath);
			});

			it('should handle unsupported file types', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = '/src/test.xyz';
				const workspacePath = '/workspace';

				mockFileSystem.exists.mockResolvedValue(true);
				mockFileSystem.readFile.mockResolvedValue(new TextEncoder().encode('some content'));

				const options: OutlineOptions = {
					filePath,
					workspacePath,
					json: false,
					fileSystem: mockFileSystem as any,
					pathUtils: mockPathUtils as any,
					logger: mockLogger as any
				};

				const result = await extractOutline(options);
				expect(result).toContain('No code definitions found');
			});
		});

		beforeEach(() => {
				vi.clearAllMocks();
			});

		describe('logger integration', () => {
			it('should NOT call logger.info (to avoid polluting output)', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = '/workspace/src/test.ts';
				const workspacePath = '/workspace';

				mockFileSystem.exists.mockResolvedValue(true);
				mockFileSystem.readFile.mockResolvedValue(
					new TextEncoder().encode(sampleTypeScriptCode)
				);
				mockWorkspace.shouldIgnore.mockResolvedValue(false);

				const options: OutlineOptions = {
					filePath,
					workspacePath,
					json: false,
					summarize: false,
					fileSystem: mockFileSystem as any,
					workspace: mockWorkspace as any,
					pathUtils: mockPathUtils as any,
					logger: mockLogger as any
				};

				await extractOutline(options);

				expect(mockLogger.info).not.toHaveBeenCalled();
			});

			it('should call logger.error on file not found', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = '/src/nonexistent.ts';
				const workspacePath = '/workspace';

				mockFileSystem.exists.mockResolvedValue(false);

				const options: OutlineOptions = {
					filePath,
					workspacePath,
					json: false,
					fileSystem: mockFileSystem as any,
					pathUtils: mockPathUtils as any,
					logger: mockLogger as any
				};

				await expect(extractOutline(options)).rejects.toThrow();
				expect(mockLogger.error).toHaveBeenCalledWith(
					expect.stringContaining('File not found')
				);
			});
		});
	});
});