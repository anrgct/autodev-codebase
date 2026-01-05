import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveOutlineTargets } from '../outline-targets'

vi.mock('fast-glob', () => ({
  default: vi.fn()
}))

describe('resolveOutlineTargets', () => {
  const mockPathUtils = {
    isAbsolute: (p: string) => p.startsWith('/'),
    join: (...parts: string[]) => parts.join('/'),
    extname: (p: string) => (p.match(/\.[^.]+$/)?.[0] ?? ''),
    basename: (p: string) => p.split('/').pop() || p,
    relative: (from: string, to: string) => to.replace(from, '').replace(/^\//, ''),
    normalize: (p: string) => p,
    resolve: (...parts: string[]) => parts.join('/'),
    dirname: (p: string) => p.substring(0, p.lastIndexOf('/')) || '.'
  }

  const createWorkspace = () => ({
    getGlobIgnorePatterns: vi.fn(async () => ['node_modules']),
    shouldIgnore: vi.fn(async () => false),
    getRelativePath: vi.fn((p: string) => p)
  })

  const createFileSystem = () => ({
    stat: vi.fn(async () => ({ isFile: true, isDirectory: false, size: 0, mtime: 0 })),
    exists: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readdir: vi.fn(),
    mkdir: vi.fn(),
    delete: vi.fn()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('treats directory input as "dir/*" (one level)', async () => {
    const fastGlob = (await import('fast-glob')).default as unknown as ReturnType<typeof vi.fn>
    fastGlob.mockResolvedValue(['/ws/src/a.ts', '/ws/src/b.ts'])

    const workspace = createWorkspace()
    const fileSystem = createFileSystem()
    fileSystem.stat.mockResolvedValueOnce({ isFile: false, isDirectory: true, size: 0, mtime: 0 })

    const result = await resolveOutlineTargets({
      input: 'src',
      workspacePath: '/ws',
      workspace: workspace as any,
      pathUtils: mockPathUtils as any,
      fileSystem: fileSystem as any,
      skipIgnoreCheckForSingleFile: true
    })

    expect(result.isGlob).toBe(true)
    expect(result.files).toEqual(['/ws/src/a.ts', '/ws/src/b.ts'])
    expect(fastGlob).toHaveBeenCalledWith(['src/*'], expect.objectContaining({ cwd: '/ws', absolute: true, onlyFiles: true }))
  })

  it('does not ignore single-file inputs when skipIgnoreCheckForSingleFile=true', async () => {
    const workspace = createWorkspace()
    workspace.shouldIgnore.mockResolvedValueOnce(true)
    const fileSystem = createFileSystem()

    const result = await resolveOutlineTargets({
      input: 'src/index.ts',
      workspacePath: '/ws',
      workspace: workspace as any,
      pathUtils: mockPathUtils as any,
      fileSystem: fileSystem as any,
      skipIgnoreCheckForSingleFile: true
    })

    expect(result.isGlob).toBe(false)
    expect(result.files).toEqual(['/ws/src/index.ts'])
  })
})

