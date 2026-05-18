import * as childProcess from "child_process"
import * as path from "path"
import * as readline from "readline"

import { IFileSystem } from "../abstractions/core"
/*
This file provides platform-agnostic functionality to perform regex searches on files using ripgrep.
Inspired by: https://github.com/DiscreteTom/vscode-ripgrep-utils

Key components:
1. getBinPath: Locates the ripgrep binary in system PATH or VSCode installation.
2. execRipgrep: Executes the ripgrep command and returns the output.
3. regexSearchFiles: The main function that performs regex searches on files.
   - Parameters:
     * cwd: The current working directory (for relative path calculation)
     * directoryPath: The directory to search in
     * regex: The regular expression to search for (Rust regex syntax)
     * filePattern: Optional glob pattern to filter files (default: '*')
     * options: Optional configuration including fileSystem, vscodeAppRoot, and ignoreFilter
   - Returns: A formatted string containing search results with context

The search results include:
- Relative file paths (normalized to forward slashes)
- 1 line of context before and after each match
- Matches formatted with pipe characters for easy reading

Platform-agnostic usage example:
const results = await regexSearchFiles('/path/to/cwd', '/path/to/search', 'TODO:', '*.ts', {
  fileSystem: myFileSystem,
  ignoreFilter: (path) => !path.includes('node_modules')
});

VSCode usage example:
const results = await regexSearchFiles('/path/to/cwd', '/path/to/search', 'TODO:', '*.ts', {
  vscodeAppRoot: vscode.env.appRoot,
  fileSystem: myFileSystem
});

Node.js usage example (with system ripgrep):
const results = await regexSearchFiles('/path/to/cwd', '/path/to/search', 'TODO:', '*.ts');

rel/path/to/app.ts
# ----
│  1 | function processData(data: any) {
│  2 |   // Some processing logic here
│  3 |   // TODO: Implement error handling
│  4 |   return processedData;
│  5 | }
# ----
*/

const isWindows = process.platform.startsWith("win")
const binName = isWindows ? "rg.exe" : "rg"

interface SearchFileResult {
  file: string
  searchResults: SearchResult[]
}

interface SearchResult {
  lines: SearchLineResult[]
}

interface SearchLineResult {
  line: number
  text: string
  isMatch: boolean
  column?: number
}
// Constants
const MAX_RESULTS = 300
const MAX_LINE_LENGTH = 500

/**
 * Truncates a line if it exceeds the maximum length
 * @param line The line to truncate
 * @param maxLength The maximum allowed length (defaults to MAX_LINE_LENGTH)
 * @returns The truncated line, or the original line if it's shorter than maxLength
 */
export function truncateLine(line: string, maxLength: number = MAX_LINE_LENGTH): string {
  return line.length > maxLength ? line.substring(0, maxLength) + " [truncated...]" : line
}
/**
 * Get the path to the ripgrep binary
 * First tries to find it in the system PATH, then falls back to VSCode locations if available
 */
export async function getBinPath(fileSystem?: IFileSystem, vscodeAppRoot?: string): Promise<string | undefined> {
  // First try to find ripgrep in system PATH
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const which = process.platform === 'win32' ? 'where' : 'which'
      childProcess.exec(`${which} ${binName}`, (error, stdout) => {
        if (error) {
          reject(error)
        } else {
          resolve(stdout.trim())
        }
      })
    })

    if (result && fileSystem) {
      const exists = await fileSystem.exists(result)
      if (exists) {
        return result
      }
    } else if (result) {
      // If no fileSystem provided, assume system which/where result is valid
      return result
    }
  } catch {
    // Fall through to VSCode paths
  }

  // Fall back to VSCode installation paths if available
  if (vscodeAppRoot && fileSystem) {
    const checkPath = async (pkgFolder: string) => {
      const fullPath = path.join(vscodeAppRoot, pkgFolder, binName)
      return (await fileSystem.exists(fullPath)) ? fullPath : undefined
    }

    return (
      (await checkPath("node_modules/@vscode/ripgrep/bin/")) ||
      (await checkPath("node_modules/vscode-ripgrep/bin")) ||
      (await checkPath("node_modules.asar.unpacked/vscode-ripgrep/bin/")) ||
      (await checkPath("node_modules.asar.unpacked/@vscode/ripgrep/bin/"))
    )
  }

  return undefined
}

async function execRipgrep(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const rgProcess = childProcess.spawn(bin, args)
    // cross-platform alternative to head, which is ripgrep author's recommendation for limiting output.
    const rl = readline.createInterface({
      input: rgProcess.stdout,
      crlfDelay: Infinity, // treat \r\n as a single line break even if it's split across chunks. This ensures consistent behavior across different operating systems.
    })

    let output = ""
    let lineCount = 0
    const maxLines = MAX_RESULTS * 5 // limiting ripgrep output with max lines since there's no other way to limit results. it's okay that we're outputting as json, since we're parsing it line by line and ignore anything that's not part of a match. This assumes each result is at most 5 lines.

    rl.on("line", (line) => {
      if (lineCount < maxLines) {
        output += line + "\n"
        lineCount++
      } else {
        rl.close()
        rgProcess.kill()
      }
    })

    let errorOutput = ""
    rgProcess.stderr.on("data", (data) => {
      errorOutput += data.toString()
    })
    rl.on("close", () => {
      if (errorOutput) {
        reject(new Error(`ripgrep process error: ${errorOutput}`))
      } else {
        resolve(output)
      }
    })
    rgProcess.on("error", (error) => {
      reject(new Error(`ripgrep process error: ${error.message}`))
    })
  })
}

export interface RipgrepOptions {
  fileSystem?: IFileSystem
  vscodeAppRoot?: string
  ignoreFilter?: (filePath: string) => boolean
}

/**
 * Helper function to create an ignore filter from a RooIgnoreController
 * This maintains backward compatibility while being platform-agnostic
 */
export function createIgnoreFilter(ignoreController?: { validateAccess(path: string): boolean }): (filePath: string) => boolean {
  return (filePath: string) => ignoreController ? ignoreController.validateAccess(filePath) : true
}

export async function regexSearchFiles(
  cwd: string,
  directoryPath: string,
  regex: string,
  filePattern?: string,
  options?: RipgrepOptions,
): Promise<string> {
  const rgPath = await getBinPath(options?.fileSystem, options?.vscodeAppRoot)

  if (!rgPath) {
    throw new Error("Could not find ripgrep binary. Please install ripgrep (rg) on your system or provide vscodeAppRoot.")
  }

  const args = ["--json", "-e", regex, "--glob", filePattern || "*", "--context", "1", directoryPath]

  let output: string
  try {
    output = await execRipgrep(rgPath, args)
  } catch (error) {
    console.error("Error executing ripgrep:", error)
    return "No results found"
  }

  const results: SearchFileResult[] = []
  let currentFile: SearchFileResult | null = null

  output.split("\n").forEach((line) => {
    if (line) {
      try {
        const parsed = JSON.parse(line)
        if (parsed.type === "begin") {
          currentFile = {
            file: parsed.data.path.text.toString(),
            searchResults: [],
          }
        } else if (parsed.type === "end") {
          // Reset the current result when a new file is encountered
          results.push(currentFile as SearchFileResult)
          currentFile = null
        } else if ((parsed.type === "match" || parsed.type === "context") && currentFile) {
          const line = {
            line: parsed.data.line_number,
            text: truncateLine(parsed.data.lines.text),
            isMatch: parsed.type === "match",
            ...(parsed.type === "match" && { column: parsed.data.absolute_offset }),
          }

          const lastResult = currentFile.searchResults[currentFile.searchResults.length - 1]
          if (lastResult?.lines.length > 0) {
            const lastLine = lastResult.lines[lastResult.lines.length - 1]

            // If this line is contiguous with the last result, add to it
            if (parsed.data.line_number <= lastLine.line + 1) {
              lastResult.lines.push(line)
            } else {
              // Otherwise create a new result
              currentFile.searchResults.push({
                lines: [line],
              })
            }
          } else {
            // First line in file
            currentFile.searchResults.push({
              lines: [line],
            })
          }
        }
      } catch (error) {
        console.error("Error parsing ripgrep output:", error)
      }
    }
  })

  // console.log(results)

  // Filter results using ignoreFilter if provided
  const filteredResults = options?.ignoreFilter
    ? results.filter((result) => options.ignoreFilter!(result.file))
    : results

  return formatResults(filteredResults, cwd)
}

function formatResults(fileResults: SearchFileResult[], cwd: string): string {
  const groupedResults: { [key: string]: SearchResult[] } = {}

  let totalResults = fileResults.reduce((sum, file) => sum + file.searchResults.length, 0)
  let output = ""
  if (totalResults >= MAX_RESULTS) {
    output += `Showing first ${MAX_RESULTS} of ${MAX_RESULTS}+ results. Use a more specific search if necessary.\n\n`
  } else {
    output += `Found ${totalResults === 1 ? "1 result" : `${totalResults.toLocaleString()} results`}.\n\n`
  }

  // Group results by file name
  fileResults.slice(0, MAX_RESULTS).forEach((file) => {
    const relativeFilePath = path.relative(cwd, file.file)
    if (!groupedResults[relativeFilePath]) {
      groupedResults[relativeFilePath] = []

      groupedResults[relativeFilePath].push(...file.searchResults)
    }
  })

  for (const [filePath, fileResults] of Object.entries(groupedResults)) {
    // Normalize path separators to forward slashes for cross-platform compatibility
    const normalizedPath = filePath.replace(/\\/g, '/')
    output += `# ${normalizedPath}\n`

    fileResults.forEach((result) => {
      // Only show results with at least one line
      if (result.lines.length > 0) {
        // Show all lines in the result
        result.lines.forEach((line) => {
          const lineNumber = String(line.line).padStart(3, " ")
          output += `${lineNumber} | ${line.text.trimEnd()}\n`
        })
        output += "----\n"
      }
    })

    output += "\n"
  }

  return output.trim()
}
