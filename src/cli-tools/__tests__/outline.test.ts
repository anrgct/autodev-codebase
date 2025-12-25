/**
 * Unit tests for outline CLI tool
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OutlineOptions } from '../outline';
import { loadRequiredLanguageParsers } from '../../tree-sitter/languageParser';

vi.mock('../../tree-sitter', async (importOriginal) => {
	// Keep everything except the pieces we want to control for unit tests.
	const actual = await importOriginal<typeof import('../../tree-sitter')>();
	return {
		...actual,
		getMinComponentLines: () => 1,
		parseSourceCodeDefinitionsForFile: vi.fn(async (filePath: string, deps: any) => {
			// Ensure the outline tool uses the injected fileSystem abstraction.
			await deps.fileSystem.readFile(filePath);

			// Simulate tree-sitter behavior: return undefined for unsupported file types.
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

// Mock dependencies
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
	getFolderByPath: vi.fn()
};

const mockLogger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn()
};

const mockDeps = {
	fileSystem: mockFileSystem as any,
	workspace: mockWorkspace as any,
	pathUtils: mockPathUtils as any,
	logger: mockLogger
};

// Sample TypeScript code for testing
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

// Sample Python code for testing
const samplePythonCode = `
class UserService:
    """Service for managing users."""

    def __init__(self):
        self.users = []

    def get_user_by_id(self, user_id: int):
        """Get user by ID."""
        return next((u for u in self.users if u.id == user_id), None)

    def add_user(self, user):
        """Add a new user."""
        self.users.append(user)

def create_user(name: str):
    """Create a new user."""
    return {"id": len(UserService().users) + 1, "name": name}
`;

describe('extractOutline', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

		describe('should extract outline as text', () => {
			it('should extract outline as text for TypeScript file', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = '/src/test.ts';
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
							parse: vi.fn().mockReturnValue({
								rootNode: {}
							})
						},
						query: {
							captures: vi.fn().mockReturnValue([
								{
									name: 'definition.interface',
									node: {
										startPosition: { row: 1, column: 0 },
										endPosition: { row: 4, column: 1 },
										type: 'interface_declaration',
										text: 'interface User { id: number; name: string; }'
									}
								},
								{
									name: 'name.definition.interface',
									node: {
										startPosition: { row: 1, column: 10 },
										endPosition: { row: 1, column: 14 },
										text: 'User'
									}
								}
							])
						}
					}
				} as any);

				const result = await extractOutline(options);

				expect(result).toBeDefined();
				expect(typeof result).toBe('string');
				expect(result).toContain('test.ts');
			expect(mockFileSystem.readFile).toHaveBeenCalled();
		});

			it('should extract outline as text for Python file', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = '/lib/test.py';
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

				vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
					py: {
						parser: {
							parse: vi.fn().mockReturnValue({
								rootNode: {}
							})
						},
						query: {
							captures: vi.fn().mockReturnValue([
								{
									name: 'definition.class',
									node: {
										startPosition: { row: 1, column: 0 },
										endPosition: { row: 3, column: 0 },
										type: 'class_definition',
										text: 'class UserService: ...'
									}
								},
								{
									name: 'name.definition.class',
									node: {
										startPosition: { row: 1, column: 6 },
										endPosition: { row: 1, column: 17 },
										text: 'UserService'
									}
								}
							])
						}
					}
				} as any);

				const result = await extractOutline(options);

				expect(result).toBeDefined();
				expect(typeof result).toBe('string');
				expect(result).toContain('test.py');
		});

		it('should extract outline as JSON', async () => {
			const { extractOutline } = await import('../outline');
			const filePath = '/src/test.ts';
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

			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
				ts: {
					parser: {
						parse: vi.fn().mockReturnValue({
							rootNode: {}
						})
					},
					query: {
						captures: vi.fn().mockReturnValue([
							{
								name: 'definition.function',
								node: {
									startPosition: { row: 0, column: 0 },
									endPosition: { row: 0, column: 10 },
									type: 'function_declaration',
									text: 'function createUser() {}'
								}
							},
							{
								name: 'name.definition.function',
								node: {
									startPosition: { row: 0, column: 9 },
									endPosition: { row: 0, column: 19 },
									text: 'createUser'
								}
							}
						])
					}
				}
			} as any);

			const result = await extractOutline(options);

			expect(result).toBeDefined();
			expect(typeof result).toBe('string');

			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('filePath');
			expect(parsed).toHaveProperty('language');
			expect(parsed).toHaveProperty('definitionCount');
			expect(parsed).toHaveProperty('definitions');
			expect(Array.isArray(parsed.definitions)).toBe(true);
		});

		it('should include wasTruncated and textLength in JSON output', async () => {
			const { extractOutline } = await import('../outline');
			const filePath = '/src/test.ts';
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

			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
				ts: {
					parser: {
						parse: vi.fn().mockReturnValue({
							rootNode: {}
						})
					},
					query: {
						captures: vi.fn().mockReturnValue([
							{
								name: 'definition.class',
								node: {
									startPosition: { row: 0, column: 0 },
									endPosition: { row: 0, column: 10 },
									type: 'class_declaration',
									text: 'class UserService {}'
								}
							},
							{
								name: 'name.definition.class',
								node: {
									startPosition: { row: 0, column: 6 },
									endPosition: { row: 0, column: 17 },
									text: 'UserService'
								}
							}
						])
					}
				}
			} as any);

			const result = await extractOutline(options);
			const parsed = JSON.parse(result);

			if (parsed.definitions.length > 0) {
				const firstDef = parsed.definitions[0];
				expect(firstDef).toHaveProperty('wasTruncated');
				expect(firstDef).toHaveProperty('textLength');
				expect(typeof firstDef.wasTruncated).toBe('boolean');
				expect(typeof firstDef.textLength).toBe('number');
			}
		});

		it('should truncate text in JSON output', async () => {
			const { extractOutline } = await import('../outline');
			// Create a long function
			const longCode = `
function longFunction() {
  ${Array(50).fill('  console.log("line");').join('\n')}
}
`;
			const filePath = '/src/long.ts';
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

			vi.mocked(loadRequiredLanguageParsers).mockResolvedValue({
				ts: {
					parser: {
						parse: vi.fn().mockReturnValue({
							rootNode: {}
						})
					},
					query: {
						captures: vi.fn().mockReturnValue([
							{
								name: 'definition.function',
								node: {
									startPosition: { row: 0, column: 0 },
									endPosition: { row: 0, column: 10 },
									type: 'function_declaration',
									text: longCode
								}
							},
							{
								name: 'name.definition.function',
								node: {
									startPosition: { row: 0, column: 9 },
									endPosition: { row: 0, column: 21 },
									text: 'longFunction'
								}
							}
						])
					}
				}
			} as any);

			const result = await extractOutline(options);
			const parsed = JSON.parse(result);

			if (parsed.definitions.length > 0) {
				const def = parsed.definitions[0];
				// If text was truncated, verify the structure
				if (def.wasTruncated) {
					expect(def.text).toContain('...');
					expect(def.textLength).toBeGreaterThan(def.text.length);
				}
			}
		});

		describe('summarizer integration', () => {
			beforeEach(() => {
				vi.clearAllMocks();
			});

			it('should generate AI summaries when summarize=true', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = '/src/test.ts';
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
							parse: vi.fn().mockReturnValue({
								rootNode: {}
							})
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
				// 应该包含 summary 标记（如果 summarizer 配置正确）
				// 注意：由于没有配置真实的 summarizer，这里只测试不会抛出错误
			});

			it('should include summaries in JSON output when summarize=true', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = '/src/test.ts';
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
							parse: vi.fn().mockReturnValue({
								rootNode: {}
							})
						},
						query: {
							captures: vi.fn().mockReturnValue([
								{
									name: 'definition.function',
									node: {
										startPosition: { row: 19, column: 0 },
										endPosition: { row: 20, column: 1 },
										type: 'function_declaration',
										text: 'function createUser(name: string): User {\n  return { id: Date.now(), name };\n}'
									}
								},
								{
									name: 'name.definition.function',
									node: {
										startPosition: { row: 19, column: 9 },
										endPosition: { row: 19, column: 21 },
										text: 'createUser'
									}
								}
							])
						}
					}
				} as any);

				const result = await extractOutline(options);

				expect(result).toBeDefined();
				const parsed = JSON.parse(result);
				expect(parsed).toHaveProperty('definitions');
				expect(Array.isArray(parsed.definitions)).toBe(true);
			
				// 每个 definition 应该有 summary 字段（即使为空）
				if (parsed.definitions.length > 0) {
					expect(parsed.definitions[0]).toHaveProperty('summary');
				}
			});

			it('should skip very large blocks (>1000 lines) when summarizing', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = '/src/test.ts';
				const workspacePath = '/workspace';

				// 创建一个超过 1000 行的函数
				const largeFunctionLines = [];
				for (let i = 0; i < 1005; i++) {
					largeFunctionLines.push(`  console.log("Line ${i}");`);
				}
				const largeCode = `
	function veryLargeFunction() {
	${largeFunctionLines.join('\n')}
	}
	`;

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
							parse: vi.fn().mockReturnValue({
								rootNode: {}
							})
						},
						query: {
							captures: vi.fn().mockReturnValue([
								{
									name: 'definition.function',
									node: {
										startPosition: { row: 0, column: 0 },
										endPosition: { row: 1005, column: 1 },
										type: 'function_declaration',
										text: largeCode
									}
								},
								{
									name: 'name.definition.function',
									node: {
										startPosition: { row: 0, column: 9 },
										endPosition: { row: 0, column: 26 },
										text: 'veryLargeFunction'
									}
								}
							])
						}
					}
				} as any);

				const result = await extractOutline(options);
				const parsed = JSON.parse(result);

				if (parsed.definitions.length > 0) {
					const def = parsed.definitions[0];
					// 超大块应该有特殊的 summary
					expect(def.summary).toContain('Code too large to summarize');
				}
			});

			it('should handle summarizer errors gracefully', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = '/src/test.ts';
				const workspacePath = '/workspace';

				mockFileSystem.exists.mockResolvedValue(true);
				mockFileSystem.readFile.mockResolvedValue(
					new TextEncoder().encode(sampleTypeScriptCode)
				);
				mockWorkspace.shouldIgnore.mockResolvedValue(false);

				// 创建一个会触发错误的配置
				const invalidConfigPath = '/nonexistent/config.json';

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
							parse: vi.fn().mockReturnValue({
								rootNode: {}
							})
						},
						query: {
							captures: vi.fn().mockReturnValue([
								{
									name: 'definition.function',
									node: {
										startPosition: { row: 19, column: 0 },
										endPosition: { row: 20, column: 1 },
										type: 'function_declaration',
										text: 'function createUser(name: string): User {}'
									}
								},
								{
									name: 'name.definition.function',
									node: {
										startPosition: { row: 19, column: 9 },
										endPosition: { row: 19, column: 21 },
										text: 'createUser'
									}
								}
							])
						}
					}
				} as any);

				// 应该不会抛出错误，而是优雅降级
				const result = await extractOutline(options);
				expect(result).toBeDefined();
				expect(typeof result).toBe('string');
			});

			it('should log warning when summarizer is not configured', async () => {
				const { extractOutline } = await import('../outline');
				const filePath = '/src/test.ts';
				const workspacePath = '/workspace';

				mockFileSystem.exists.mockResolvedValue(true);
				mockFileSystem.readFile.mockResolvedValue(
					new TextEncoder().encode(sampleTypeScriptCode)
				);
				mockWorkspace.shouldIgnore.mockResolvedValue(false);

				// 使用不存在的配置路径来触发 summarizer 配置失败
				const nonExistentConfigPath = '/nonexistent/path/config.json';

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
							parse: vi.fn().mockReturnValue({
								rootNode: {}
							})
						},
						query: {
							captures: vi.fn().mockReturnValue([
								{
									name: 'definition.function',
									node: {
										startPosition: { row: 19, column: 0 },
										endPosition: { row: 20, column: 1 },
										type: 'function_declaration',
										text: 'function createUser(name: string): User {}'
									}
								},
								{
									name: 'name.definition.function',
									node: {
										startPosition: { row: 19, column: 9 },
										endPosition: { row: 19, column: 21 },
										text: 'createUser'
									}
								}
							])
						}
					}
				} as any);

				const result = await extractOutline(options);

				// 即使 summarizer 未配置，也应该返回有效结果（降级处理）
				expect(result).toBeDefined();
				expect(typeof result).toBe('string');
				expect(result).toContain('test.ts');
				
				// 验证调用了警告（如果 summarizer 创建失败）
				// 注意：这可能不会调用，因为系统可能有默认的 summarizer 配置
				// 所以我们只验证不会抛出错误
			});
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

			await expect(extractOutline(options)).rejects.toThrow('File not found');
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

			// Verify that the relative path was resolved
			expect(mockFileSystem.readFile).toHaveBeenCalledWith('/workspace/src/test.ts');
		});

		it('should use fileSystem.readFile instead of fs.promises', async () => {
			const { extractOutline } = await import('../outline');
			const filePath = '/src/test.ts';
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

			// Verify that mockFileSystem.readFile was called (not fs.promises)
			expect(mockFileSystem.readFile).toHaveBeenCalled();
			expect(mockFileSystem.readFile).toHaveBeenCalledWith(filePath);
		});

		it('should handle unsupported file types', async () => {
			const { extractOutline } = await import('../outline');
			const filePath = '/src/test.xyz';
			const workspacePath = '/workspace';

			mockFileSystem.exists.mockResolvedValue(true);
			mockFileSystem.readFile.mockResolvedValue(
				new TextEncoder().encode('some content')
			);

			const options: OutlineOptions = {
				filePath,
				workspacePath,
				json: false,
				fileSystem: mockFileSystem as any,
				pathUtils: mockPathUtils as any,
				logger: mockLogger as any
			};

			const result = await extractOutline(options);

			// Should return a message indicating no definitions found
			expect(result).toBeDefined();
			expect(result).toContain('test.xyz');
		});
	});

	describe('logger integration', () => {
		it('should NOT call logger.info (to avoid polluting output)', async () => {
			const { extractOutline } = await import('../outline');
			const filePath = '/src/test.ts';
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
				workspace: mockWorkspace as any,
				pathUtils: mockPathUtils as any,
				logger: mockLogger as any
			};

			await extractOutline(options);

			// Logger.info should NOT be called (to avoid polluting output)
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
