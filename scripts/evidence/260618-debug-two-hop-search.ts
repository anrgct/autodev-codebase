#!/usr/bin/env node
/**
 * 调试单个 query 的两跳检索过程
 *
 * 用法:
 *   npx tsx scripts/debug-two-hop.ts \
 *     --corpus-dir /tmp/musique-corpus \
 *     --queries ~/workspace/hipporag/reproduce/dataset/musique.json \
 *     --config autodev-config.json \
 *     --query-id "2hop__81268_85407" \
 *     --first-hop-k 20 \
 *     --context-passages 5
 */
import * as path from "path"
import * as fs from "fs"
import { createNodeDependencies } from "../src/adapters/nodejs"
import { CodeIndexManager } from "../src/code-index/manager"
import { Logger, LogLevel, setGlobalLogger, getGlobalLogger } from "../src/utils/logger"
import { registerProjectToCacheMap } from "../src/commands/shared"

function getLogger() { return getGlobalLogger() }
function initGlobalLogger(level: LogLevel) {
  setGlobalLogger(new Logger({ name: "Debug", level, timestamps: true, colors: false }))
}

interface MusiqueQuery {
  id: string
  answer: string
  question: string
  paragraphs: { idx: number; title: string; paragraph_text: string; is_supporting: boolean }[]
  answer_aliases: string[]
  answerable: boolean
}

function parseArgs() {
  const args = process.argv.slice(2)
  const parsed: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2)
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "true"
      parsed[key] = val
      if (val !== "true") i++
    }
  }
  return parsed
}

function loadTitleMap(corpusDir: string): Map<string, string> {
  const metaPath = path.join(corpusDir, ".metadata.json")
  const map = new Map<string, string>()
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"))
    for (const [title, filename] of Object.entries(meta)) {
      map.set(filename as string, title)
    }
  }
  return map
}

function filePathToTitle(filePath: string, titleMap: Map<string, string>): string {
  const basename = path.basename(filePath)
  if (titleMap.has(basename)) return titleMap.get(basename)!
  if (basename.endsWith(".md")) return basename.slice(0, -3)
  return basename
}

async function main() {
  const args = parseArgs()
  const corpusDir = args["corpus-dir"] || args["corpusDir"]
  const queriesPath = args["queries"]
  const configPath = args["config"] || path.join(process.cwd(), "autodev-config.json")
  const queryId = args["query-id"]
  const firstHopK = parseInt(args["first-hop-k"] || "20", 10)
  const contextPassages = parseInt(args["context-passages"] || "5", 10)
  const logLevel = (args["log-level"] || "warn") as LogLevel

  if (!corpusDir || !queriesPath || !queryId) {
    console.error("用法见脚本头部注释")
    process.exit(1)
  }

  initGlobalLogger(logLevel)
  const log = getLogger()

  const titleMap = loadTitleMap(corpusDir)

  // 加载 query
  const rawQueries: MusiqueQuery[] = JSON.parse(fs.readFileSync(queriesPath, "utf-8"))
  const query = rawQueries.find((q) => q.id === queryId)
  if (!query) {
    console.error(`Query ${queryId} 未找到`)
    process.exit(1)
  }

  // gold titles
  const goldTitles = query.paragraphs.filter((p) => p.is_supporting).map((p) => p.title)
  const goldSet = new Set(goldTitles.map((t) => t.toLowerCase()))
  console.log("=".repeat(60))
  console.log(`Query ID: ${query.id}`)
  console.log(`Question: ${query.question}`)
  console.log(`Answer: ${query.answer}`)
  console.log(`Gold titles: ${goldTitles.join(", ")}`)
  console.log("=".repeat(60))

  // 初始化 manager
  const deps = createNodeDependencies({
    workspacePath: corpusDir,
    configOptions: { configPath },
    loggerOptions: { name: "Debug", level: logLevel, timestamps: true, colors: false },
  })
  await deps.configProvider.loadConfig()
  await registerProjectToCacheMap(corpusDir)
  const manager = CodeIndexManager.getInstance(deps)
  await manager.initialize({ searchOnly: true })

  // 等待索引就绪
  const initStatus = manager.getCurrentStatus()
  if (initStatus.systemStatus !== "Indexed") {
    log.info("等待索引...")
    await new Promise<void>((resolve, reject) => {
      const unsubscribe = manager.onProgressUpdate((data) => {
        if (data.systemStatus === "Indexed") {
          unsubscribe()
          resolve()
        } else if (data.systemStatus === "Error") {
          unsubscribe()
          reject(new Error("索引失败"))
        }
      })
      if (initStatus.systemStatus === "Standby") {
        manager.startIndexing().catch(reject)
      }
    })
  }

  // ── 第一跳 ──
  console.log("\n" + "─".repeat(60))
  console.log(`【第一跳】query: "${query.question}"`)
  console.log("─".repeat(60))
  const firstResults = await manager.searchIndex(query.question, { limit: firstHopK })

  console.log(`返回 ${firstResults.length} 个结果:`)
  for (let i = 0; i < Math.min(firstResults.length, 20); i++) {
    const r = firstResults[i]
    const fp = r.payload?.filePath || "?"
    const title = filePathToTitle(fp, titleMap)
    const isGold = goldSet.has(title.toLowerCase()) ? " ← GOLD" : ""
    const preview = (r.payload?.codeChunk || "").replace(/\n/g, " ").slice(0, 80)
    console.log(`  [${String(i).padStart(2)}] score=${r.score.toFixed(4)}  title="${title}"${isGold}`)
    console.log(`        ${preview}...`)
  }

  // ── 构建扩展 query ──
  console.log("\n" + "─".repeat(60))
  console.log("【构建扩展 query】")
  console.log("─".repeat(60))

  const contextTitles: string[] = []
  const seenTitles = new Set<string>()
  for (const r of firstResults) {
    if (contextTitles.length >= contextPassages) break
    if (!r.payload?.filePath) continue
    const title = filePathToTitle(r.payload.filePath, titleMap)
    const normalized = title.toLowerCase()
    if (seenTitles.has(normalized)) continue
    seenTitles.add(normalized)
    contextTitles.push(title)
  }

  // 方案 A: 标题拼接
  const expandedQueryTitles = contextTitles.length > 0
    ? `${query.question}\nRelated: ${contextTitles.join(", ")}`
    : query.question

  // 方案 B: 正文拼接（之前的失败方案，保留对比）
  const contextChunks = firstResults
    .slice(0, contextPassages)
    .map((r) => {
      const text = r.payload?.codeChunk || ""
      return text.length > 200 ? text.slice(0, 200) + "..." : text
    })
    .filter((t) => t.length > 0)
  const expandedQueryText = contextChunks.length > 0
    ? `${query.question}\n\nRelevant context:\n${contextChunks.join("\n---\n")}`
    : query.question

  console.log("\n方案 A（标题拼接）:")
  console.log(`  ${expandedQueryTitles}`)
  console.log(`  (${expandedQueryTitles.length} 字符)`)
  console.log("\n方案 B（正文拼接，之前失败方案）:")
  console.log(`  ${expandedQueryText.slice(0, 300)}...`)
  console.log(`  (${expandedQueryText.length} 字符)`)

  // ── 第二跳：方案 A ──
  console.log("\n" + "─".repeat(60))
  console.log("【第二跳 / 方案 A：标题拼接】")
  console.log("─".repeat(60))
  const resultsA = await manager.searchIndex(expandedQueryTitles, { limit: 50 })
  console.log(`返回 ${resultsA.length} 个结果 (top 20):`)
  let hitA = 0
  for (let i = 0; i < Math.min(resultsA.length, 20); i++) {
    const r = resultsA[i]
    const fp = r.payload?.filePath || "?"
    const title = filePathToTitle(fp, titleMap)
    const isGold = goldSet.has(title.toLowerCase())
    if (isGold) hitA++
    const mark = isGold ? " ← GOLD" : ""
    console.log(`  [${String(i).padStart(2)}] score=${r.score.toFixed(4)}  title="${title}"${mark}`)
  }
  console.log(`  → top-20 命中 gold: ${hitA}/${goldTitles.length}`)

  // ── 第二跳：方案 B ──
  console.log("\n" + "─".repeat(60))
  console.log("【第二跳 / 方案 B：正文拼接】")
  console.log("─".repeat(60))
  const resultsB = await manager.searchIndex(expandedQueryText, { limit: 50 })
  console.log(`返回 ${resultsB.length} 个结果 (top 20):`)
  let hitB = 0
  for (let i = 0; i < Math.min(resultsB.length, 20); i++) {
    const r = resultsB[i]
    const fp = r.payload?.filePath || "?"
    const title = filePathToTitle(fp, titleMap)
    const isGold = goldSet.has(title.toLowerCase())
    if (isGold) hitB++
    const mark = isGold ? " ← GOLD" : ""
    console.log(`  [${String(i).padStart(2)}] score=${r.score.toFixed(4)}  title="${title}"${mark}`)
  }
  console.log(`  → top-20 命中 gold: ${hitB}/${goldTitles.length}`)

  // ── RRF 融合：单跳 + 两跳(标题) ──
  console.log("\n" + "─".repeat(60))
  console.log("【RRF 融合：单跳 + 两跳(标题)】")
  console.log("─".repeat(60))

  // 构建文档级排名（按 score 降序，每个 filePath 取最高分 block 的排名）
  const buildDocRanks = (results: typeof firstResults): Map<string, number> => {
    const docScores = new Map<string, number>()
    for (const r of results) {
      const fp = r.payload?.filePath
      if (!fp) continue
      const prev = docScores.get(fp) ?? -1
      if (r.score > prev) docScores.set(fp, r.score)
    }
    // 按分数降序排名
    const ranked = Array.from(docScores.entries()).sort((a, b) => b[1] - a[1])
    const ranks = new Map<string, number>()
    ranked.forEach(([fp], i) => ranks.set(fp, i))
    return ranks
  }

  const hop1Ranks = buildDocRanks(firstResults)
  const hop2Ranks = buildDocRanks(resultsA)

  // RRF: score = Σ 1/(60 + rank)
  const K = 60
  const rrfFuse = (ranksA: Map<string, number>, ranksB: Map<string, number>, label: string) => {
    const docs = new Set<string>([...ranksA.keys(), ...ranksB.keys()])
    const fused: Array<{ fp: string; score: number; hops: string }> = []
    for (const fp of docs) {
      let score = 0
      const hops: string[] = []
      const ra = ranksA.get(fp)
      const rb = ranksB.get(fp)
      if (ra !== undefined) { score += 1 / (K + ra); hops.push(`a#${ra}`) }
      if (rb !== undefined) { score += 1 / (K + rb); hops.push(`b#${rb}`) }
      fused.push({ fp, score, hops: hops.join(",") })
    }
    fused.sort((a, b) => b.score - a.score)

    console.log(`\n融合后 ${fused.length} 个文档 (top 20):`)
    let hit = 0
    for (let i = 0; i < Math.min(fused.length, 20); i++) {
      const { fp, score, hops } = fused[i]
      const title = filePathToTitle(fp, titleMap)
      const isGold = goldSet.has(title.toLowerCase())
      if (isGold) hit++
      const mark = isGold ? " ← GOLD" : ""
      console.log(`  [${String(i).padStart(2)}] rrf=${score.toFixed(6)}  (${hops})  title="${title}"${mark}`)
    }
    console.log(`  → top-20 命中 gold: ${hit}/${goldTitles.length}`)
    return hit
  }

  const hitFused = rrfFuse(hop1Ranks, hop2Ranks, "单跳+两跳(标题)")

  // ── RRF 融合：单跳 + 两跳(正文) ──
  console.log("\n" + "─".repeat(60))
  console.log("【RRF 融合：单跳 + 两跳(正文)】")
  console.log("─".repeat(60))
  const hop2BRanks = buildDocRanks(resultsB)
  const hitFusedB = rrfFuse(hop1Ranks, hop2BRanks, "单跳+两跳(正文)")

  // ── 对比总结 ──
  console.log("\n" + "=".repeat(60))
  console.log("【总结】")
  console.log("=".repeat(60))
  console.log(`Gold titles: ${goldTitles.join(", ")}`)

  // 单跳 top-20 gold 命中
  let hitSingle = 0
  for (let i = 0; i < Math.min(firstResults.length, 20); i++) {
    const title = filePathToTitle(firstResults[i].payload?.filePath || "?", titleMap)
    if (goldSet.has(title.toLowerCase())) hitSingle++
  }
  console.log(`单跳 top-20 命中: ${hitSingle}/${goldTitles.length}`)
  console.log(`两跳(标题) top-20 命中: ${hitA}/${goldTitles.length}`)
  console.log(`两跳(正文) top-20 命中: ${hitB}/${goldTitles.length}`)
  console.log(`RRF融合(标题) top-20 命中: ${hitFused}/${goldTitles.length}`)
  console.log(`RRF融合(正文) top-20 命中: ${hitFusedB}/${goldTitles.length}`)

  manager.dispose()
}

main().catch((err) => {
  console.error("调试失败:", err)
  process.exit(1)
})
