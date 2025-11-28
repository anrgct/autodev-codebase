/**
 * File System Utilities
 * Wrapper functions for fs/promises API
 */
import { promises as fs } from 'fs'
import * as path from 'path'

/**
 * Read file contents as Uint8Array
 */
export async function readFile(filePath: string): Promise<Uint8Array> {
  const buffer = await fs.readFile(filePath)
  return new Uint8Array(buffer)
}

/**
 * Read file contents as string
 */
export async function readFileText(filePath: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
  return fs.readFile(filePath, { encoding })
}

/**
 * Write content to file (creates parent directories if needed)
 */
export async function writeFile(filePath: string, content: Uint8Array | string): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  if (typeof content === 'string') {
    await fs.writeFile(filePath, content, 'utf-8')
  } else {
    await fs.writeFile(filePath, Buffer.from(content))
  }
}

/**
 * Check if file or directory exists
 */
export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Get file or directory stats
 */
export async function stat(filePath: string): Promise<{
  isFile: boolean
  isDirectory: boolean
  size: number
  mtime: number
}> {
  const stats = await fs.stat(filePath)
  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    size: stats.size,
    mtime: stats.mtime.getTime()
  }
}

/**
 * Read directory contents (returns full paths)
 */
export async function readdir(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath)
  return entries.map(entry => path.join(dirPath, entry))
}

/**
 * Read directory contents (returns entry names only)
 */
export async function readdirNames(dirPath: string): Promise<string[]> {
  return fs.readdir(dirPath)
}

/**
 * Create directory (recursive)
 */
export async function mkdir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true })
}

/**
 * Delete file or directory
 */
export async function remove(filePath: string): Promise<void> {
  const stats = await fs.stat(filePath)
  if (stats.isDirectory()) {
    await fs.rm(filePath, { recursive: true })
  } else {
    await fs.unlink(filePath)
  }
}

/**
 * Copy file
 */
export async function copyFile(src: string, dest: string): Promise<void> {
  const dir = path.dirname(dest)
  await fs.mkdir(dir, { recursive: true })
  await fs.copyFile(src, dest)
}

/**
 * Rename/move file or directory
 */
export async function rename(oldPath: string, newPath: string): Promise<void> {
  const dir = path.dirname(newPath)
  await fs.mkdir(dir, { recursive: true })
  await fs.rename(oldPath, newPath)
}
