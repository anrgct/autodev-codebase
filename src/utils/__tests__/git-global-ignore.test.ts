import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { ensureGitGlobalIgnorePatterns, type RunGitCommand } from '../git-global-ignore'

function ok(stdout = '', stderr = '') {
  return { ok: true, exitCode: 0, stdout, stderr }
}

function fail(exitCode = 1, stdout = '', stderr = '') {
  return { ok: false, exitCode, stdout, stderr }
}

function createGitMock(initialExcludesFile?: string) {
  let excludesFile = initialExcludesFile

  const runGit: RunGitCommand = (args) => {
    if (args.length === 1 && args[0] === '--version') {
      return ok('git version 2.0.0\n')
    }

    const key = args.join(' ')

    if (key === 'config --global --path core.excludesfile') {
      return excludesFile ? ok(`${excludesFile}\n`) : fail(1)
    }
    if (key === 'config --global --get core.excludesfile') {
      return excludesFile ? ok(`${excludesFile}\n`) : fail(1)
    }

    if (args[0] === 'config' && args[1] === '--global' && args[2] === 'core.excludesfile' && args[3]) {
      excludesFile = args[3]
      return ok('')
    }

    if (key === 'config --global --unset core.excludesfile') {
      excludesFile = undefined
      return ok('')
    }

    return fail(1, '', `unhandled git args: ${key}`)
  }

  return {
    runGit,
    getExcludesFile: () => excludesFile,
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

describe('ensureGitGlobalIgnorePatterns', () => {
  let tempRoot: string
  let tempHome: string

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(process.cwd(), '.tmp-gitignore-test-'))
    tempHome = path.join(tempRoot, 'home')
    await fs.mkdir(tempHome, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('returns git_not_available when git is missing', async () => {
    const runGit: RunGitCommand = (args) => {
      if (args.length === 1 && args[0] === '--version') return fail(127, '', 'not found')
      return fail(127, '', 'not found')
    }

    const res = await ensureGitGlobalIgnorePatterns(['autodev-config.json'], {
      runGit,
      homedir: () => tempHome,
      env: {},
      logger: console,
    })

    expect(res.didUpdate).toBe(true)
    expect(res.excludesFilePath).toBeTruthy()
    const content = await fs.readFile(res.excludesFilePath!, 'utf8')
    expect(content).toContain('autodev-config.json')
  })

  it('is idempotent when pattern already exists', async () => {
    const excludesPath = path.join(tempHome, '.config', 'git', 'ignore')
    await fs.mkdir(path.dirname(excludesPath), { recursive: true })
    await fs.writeFile(excludesPath, '# Added by @autodev/codebase\nautodev-config.json\n', 'utf8')

    const git = createGitMock(excludesPath)
    const res = await ensureGitGlobalIgnorePatterns(['autodev-config.json'], {
      runGit: git.runGit,
      homedir: () => tempHome,
      env: {},
      logger: console,
    })

    expect(res.didUpdate).toBe(false)
    expect(res.addedPatterns).toEqual([])
    expect(await fs.readFile(excludesPath, 'utf8')).toContain('autodev-config.json')
  })

  it('sets core.excludesfile (if missing) and appends pattern once', async () => {
    const git = createGitMock(undefined)

    const res1 = await ensureGitGlobalIgnorePatterns(['autodev-config.json'], {
      runGit: git.runGit,
      homedir: () => tempHome,
      env: {},
      logger: console,
    })

    expect(res1.didUpdate).toBe(true)
    expect(res1.addedPatterns).toEqual(['autodev-config.json'])

    const excludesPath = git.getExcludesFile()
    expect(excludesPath).toBeTruthy()
    expect(await exists(excludesPath!)).toBe(true)

    const content = await fs.readFile(excludesPath!, 'utf8')
    expect(content).toContain('# Added by @autodev/codebase')
    expect(content).toContain('autodev-config.json')

    const res2 = await ensureGitGlobalIgnorePatterns(['autodev-config.json'], {
      runGit: git.runGit,
      homedir: () => tempHome,
      env: {},
      logger: console,
    })

    expect(res2.didUpdate).toBe(false)
    expect(res2.addedPatterns).toEqual([])
  })

  it('rolls back core.excludesfile when file update fails', async () => {
    const git = createGitMock(undefined)

    let shouldFail = true
    const wrappedFs = {
      ...fs,
      writeFile: (async (...args: Parameters<typeof fs.writeFile>) => {
        if (shouldFail) {
          shouldFail = false
          throw new Error('simulated write failure')
        }
        return fs.writeFile(...args)
      }) as typeof fs.writeFile,
    }

    const res = await ensureGitGlobalIgnorePatterns(['autodev-config.json'], {
      runGit: git.runGit,
      homedir: () => tempHome,
      env: {},
      fs: wrappedFs,
      logger: console,
    })

    expect(res.didUpdate).toBe(false)
    expect(git.getExcludesFile()).toBeUndefined()
  })
})
