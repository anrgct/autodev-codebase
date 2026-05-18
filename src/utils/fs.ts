import { promises as fs } from "fs"
import * as path from "path"

/**
 * Asynchronously creates all non-existing subdirectories for a given file path
 * and collects them in an array for later deletion.
 *
 * @param filePath - The full path to a file.
 * @returns A promise that resolves to an array of newly created directories.
 */
export async function createDirectoriesForFile(filePath: string): Promise<string[]> {
  const newDirectories: string[] = []
  const normalizedFilePath = path.normalize(filePath) // Normalize path for cross-platform compatibility
  const directoryPath = path.dirname(normalizedFilePath)

  let currentPath = directoryPath
  const dirsToCreate: string[] = []

  // Traverse up the directory tree and collect missing directories
  while (!(await fileExistsAtPath(currentPath))) {
    dirsToCreate.push(currentPath)
    currentPath = path.dirname(currentPath)
  }

  // Create directories from the topmost missing one down to the target directory
  for (let i = dirsToCreate.length - 1; i >= 0; i--) {
    await fs.mkdir(dirsToCreate[i])
    newDirectories.push(dirsToCreate[i])
  }

  return newDirectories
}

/**
 * Helper function to check if a path exists.
 *
 * @param path - The path to check.
 * @returns A promise that resolves to true if the path exists, false otherwise.
 */
export async function fileExistsAtPath(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Safely writes JSON data to a file, creating directories if needed
 *
 * @param filePath - The file path to write to
 * @param data - The JSON data to write
 * @returns A promise that resolves when the file is written
 */
export async function safeWriteJson(filePath: string, data: any): Promise<void> {
  try {
    // Ensure directory exists
    await createDirectoriesForFile(filePath)

    // Write JSON data with proper formatting
    const jsonString = JSON.stringify(data, null, 2)
    await fs.writeFile(filePath, jsonString, 'utf8')
  } catch (error) {
    throw new Error(`Failed to write JSON to ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
