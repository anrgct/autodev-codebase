/**
 * Node.js File System Adapter
 * Implements IFileSystem using Node.js fs/promises API
 */
import { promises as fs } from 'fs'
import * as path from 'path'
import { IFileSystem } from '../../abstractions/core'

export class NodeFileSystem implements IFileSystem {
  async readFile(uri: string): Promise<Uint8Array> {
    try {
      const buffer = await fs.readFile(uri)
      return new Uint8Array(buffer)
    } catch (error) {
      throw new Error(`Failed to read file ${uri}: ${error}`)
    }
  }

  async writeFile(uri: string, content: Uint8Array): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(uri)
      await fs.mkdir(dir, { recursive: true })
      
      await fs.writeFile(uri, Buffer.from(content))
    } catch (error) {
      throw new Error(`Failed to write file ${uri}: ${error}`)
    }
  }

  async exists(uri: string): Promise<boolean> {
    try {
      await fs.access(uri)
      return true
    } catch {
      return false
    }
  }

  async stat(uri: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtime: number }> {
    try {
      const stats = await fs.stat(uri)
      return {
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        size: stats.size,
        mtime: stats.mtime.getTime()
      }
    } catch (error) {
      throw new Error(`Failed to stat ${uri}: ${error}`)
    }
  }

  async readdir(uri: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(uri)
      return entries.map(entry => path.join(uri, entry))
    } catch (error) {
      throw new Error(`Failed to read directory ${uri}: ${error}`)
    }
  }

  async mkdir(uri: string): Promise<void> {
    try {
      await fs.mkdir(uri, { recursive: true })
    } catch (error) {
      throw new Error(`Failed to create directory ${uri}: ${error}`)
    }
  }

  async delete(uri: string): Promise<void> {
    try {
      const stats = await fs.stat(uri)
      if (stats.isDirectory()) {
        await fs.rm(uri, { recursive: true, force: true })
      } else {
        await fs.unlink(uri)
      }
    } catch (error) {
      throw new Error(`Failed to delete ${uri}: ${error}`)
    }
  }
}
