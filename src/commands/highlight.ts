/**
 * Highlight command implementation
 *
 * Standalone pipeline: directly invokes IHighlighter.highlight(),
 * bypassing embed / vector search / rerank.
 */
import { Command } from "commander"
import { CommandOptions, createDependencies, getLogger, initGlobalLogger, initializeManager, resolveWorkspacePath } from "./shared"
import type { HighlightResult, HighlightLine, HighlightOptions } from "../code-index/interfaces/highlighter"

// ---------------------------------------------------------------------------
// stdin helper
// ---------------------------------------------------------------------------

/**
 * Read all content from stdin. Returns empty string if stdin is a TTY
 * (i.e. no piped input).
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return ""
  }

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString("utf-8")
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

interface HighlightFileResult {
  filePath: string
  result: HighlightResult
}

/**
 * Format highlight results as human-readable text.
 * Follows the same conventions as search command output:
 * file-level groupings, `====` separators, score bars.
 */
function formatHighlightResults(results: HighlightFileResult[], query: string): string {
  if (!results || results.length === 0) {
    return `No highlight results for query: "${query}"`
  }

  const parts: string[] = []
  const totalKeptLines = results.reduce((sum, r) => {
    return sum + r.result.lines.filter((l) => l.kept).length
  }, 0)

  // Compute chunk scores per file (sum of per-line scores, consistent with QRRanker's sum of per-token scores)
  const chunkScores = results.map((r) => {
    return r.result.lines.reduce((sum, l) => sum + l.score, 0)
  })
  const overallScore = chunkScores.length > 0
    ? chunkScores.reduce((a, b) => a + b, 0) / chunkScores.length
    : 0

  parts.push(
    `Highlight results for: "${query}"`,
    `${results.length} file(s), ${totalKeptLines} line(s) kept, avg-chunk-score: ${overallScore.toFixed(4)}`,
    "",
  )

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const keptCount = r.result.lines.filter((l) => l.kept).length
    const totalCount = r.result.lines.length
    parts.push(`${"=".repeat(50)}`)
    parts.push(`File: "${r.filePath}" (${keptCount}/${totalCount} lines kept, chunk-score: ${chunkScores[i].toFixed(4)})`)
    parts.push("")
    parts.push(r.result.formattedText)
    parts.push("")
  }

  return parts.join("\n")
}

/**
 * Format highlight results as JSON.
 */
function formatHighlightResultsAsJson(results: HighlightFileResult[], query: string): string {
  const files = results.map((r) => {
    const keptLines: HighlightLine[] = r.result.lines.filter((l) => l.kept)
    const allLines: Array<{
      lineNumber: number
      text: string
      score: number
      kept: boolean
    }> = r.result.lines.map((l) => ({
      lineNumber: l.lineNumber,
      text: l.text,
      score: Math.round(l.score * 10000) / 10000,
      kept: l.kept,
    }))

    const chunkScore = r.result.lines.reduce((sum, l) => sum + l.score, 0)

    return {
      filePath: r.filePath,
      startLine: r.result.startLine,
      endLine: r.result.endLine,
      totalLines: allLines.length,
      keptLines: keptLines.length,
      chunkScore: Math.round(chunkScore * 10000) / 10000,
      lines: allLines,
      formattedText: r.result.formattedText,
      ...(r.result.debugTokenView ? { debugTokenView: r.result.debugTokenView } : {}),
    }
  })

  return JSON.stringify({ query, files }, null, 2)
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function highlightHandler(query: string, paths: string[], options: any): Promise<void> {
  const workspacePath = resolveWorkspacePath(options.path, options.demo)

  const commandOptions: CommandOptions = {
    path: workspacePath,
    port: 3001,
    host: "localhost",
    config: options.config,
    logLevel: options.logLevel || "error",
    demo: !!options.demo,
    force: false,
    json: !!options.json,
  }

  initGlobalLogger(commandOptions.logLevel)

  getLogger().info("Highlight mode")
  getLogger().info(`Query: "${query}"`)
  getLogger().info(`Workspace: ${commandOptions.path}`)

  // --- Resolve input files ---
  const files: Array<{ filePath: string; content: string }> = []

  if (paths.length > 0) {
    // File paths / glob patterns: join with commas for compatibility with
    // resolveOutlineTargets (same pattern as the outline command).
    const pattern = paths.join(",")

    const deps = createDependencies(commandOptions)
    const { resolveOutlineTargets } = await import("../cli-tools/outline-targets")

    const resolved = await resolveOutlineTargets({
      input: pattern,
      workspacePath,
      workspace: deps.workspace,
      pathUtils: deps.pathUtils,
      fileSystem: deps.fileSystem,
      skipIgnoreCheckForSingleFile: true,
    })

    if (resolved.files.length === 0) {
      if (resolved.isGlob) {
        getLogger().warn(`No files found matching pattern: ${pattern}`)
      } else {
        getLogger().warn(`No file found (or ignored): ${pattern}`)
      }
      return
    }

    getLogger().info(`Found ${resolved.files.length} file(s)`)

    for (const file of resolved.files) {
      try {
        const contentBytes = await deps.fileSystem.readFile(file)
        const content = new TextDecoder().decode(contentBytes)
        files.push({ filePath: file, content })
      } catch (error) {
        getLogger().warn(`Failed to read ${file}: ${(error as Error).message}`)
      }
    }
  } else {
    // stdin mode (no paths provided)
    const content = await readStdin()
    if (!content) {
      getLogger().error("No input provided. Specify file paths or pipe content via stdin.")
      process.exit(1)
    }
    files.push({ filePath: "<stdin>", content })
    getLogger().info("Reading from stdin")
  }

  if (files.length === 0) {
    getLogger().error("No files to highlight")
    process.exit(1)
  }

  // --- Build highlight options from CLI flags ---
  const highlightOptions: HighlightOptions = {}
  if (options.topk !== undefined) highlightOptions.topK = parseInt(options.topk, 10)
  if (options.mode) highlightOptions.mode = options.mode
  if (options.threshold !== undefined) highlightOptions.threshold = parseFloat(options.threshold)
  if (options.debug) highlightOptions.debugHighlight = true

  // --- Initialize manager (search-only mode is sufficient - we only need the highlighter) ---
  const manager = await initializeManager(commandOptions, { searchOnly: true })
  if (!manager) {
    process.exit(1)
  }

  try {
    const results: HighlightFileResult[] = []

    for (const file of files) {
      try {
        const result = await manager.highlight(query, file.content, 1, highlightOptions)
        results.push({ filePath: file.filePath, result })
      } catch (error) {
        getLogger().warn(`Failed to highlight ${file.filePath}: ${(error as Error).message}`)
      }
    }

    // --- Output ---
    if (options.json) {
      console.log(formatHighlightResultsAsJson(results, query))
    } else {
      console.log(formatHighlightResults(results, query))
    }

    // Token-level debug heatmaps (same output format as search --debug-highlight)
    if (options.debug) {
      for (const r of results) {
        if (r.result.debugTokenView) {
          console.log(`\n${"═".repeat(50)}`)
          console.log(
            `[Debug Highlight] "${r.filePath}" (L${r.result.startLine}-${r.result.endLine})`,
          )
          console.log(r.result.debugTokenView)
          console.log(`${"═".repeat(50)}\n`)
        }
      }
    }
  } finally {
    manager.dispose()
    getLogger().info("Highlight completed. Exiting...")
  }
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

export function createHighlightCommand(): Command {
  const command = new Command("highlight")

  command
    .description("Highlight code lines by semantic relevance to a query")
    .argument("<query>", "Semantic query for line relevance scoring")
    .argument("[paths...]", "File paths or glob patterns. Reads from stdin if empty.")
    .option("-p, --path <path>", "Working directory path", ".")
    .option("-c, --config <path>", "Configuration file path")
    .option("-k, --topk <number>", "Top-K lines to keep (mode=topk)")
    .option("--mode <mode>", "Selection mode: topk | threshold")
    .option("-t, --threshold <number>", "Min score threshold 0-1 (mode=threshold)")
    .option("-d, --debug", "Print token-level ANSI 256-color heatmap")
    .option("-j, --json", "Output in JSON format")
    .option("--log-level <level>", "Log level: debug|info|warn|error", "error")
    .option("--demo", "Use demo workspace")
    .action(highlightHandler)

  return command
}
