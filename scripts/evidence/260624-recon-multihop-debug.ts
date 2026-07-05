#!/usr/bin/env npx tsx
/**
 * 260624-recon-multihop-debug.ts
 *
 * 对单个 query 精细分析 recon 向量链多跳的每一跳：
 *   - recon 历史长度、上一跳传入的新线索文本
 *   - 每跳检索结果（标注 [GOLD] / [NEW]）
 *   - 本跳新出现的文档及其内容（看是否真的发现新线索）
 *   - gold 在每跳的排名变化
 *
 * 用法:
 *   npx tsx scripts/evidence/260624-recon-multihop-debug.ts \
 *     --corpus-dir /tmp/musique-corpus --worst20 data/musique-4hop-worst20.json \
 *     --idx 13 --max-hops 3 [--no-prompt] [--log-level warn]
 */
import * as path from "path"
import * as fs from "fs"
import { createNodeDependencies } from "../../src/adapters/nodejs"
import { CodeIndexManager } from "../../src/code-index/manager"
import { Logger, LogLevel, setGlobalLogger, getGlobalLogger } from "../../src/utils/logger"
import { registerProjectToCacheMap } from "../../src/commands/shared"
import { LlamaCppLlm2VecEmbedder } from "../../src/code-index/embedders/llamacpp-llm2vec"
import { VectorStoreSearchResult } from "../../src/code-index/interfaces"

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
    for (const [title, filename] of Object.entries(meta)) map.set(filename as string, title)
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
  const corpusDir = args["corpus-dir"]
  const worst20Path = args["worst20"] || "data/musique-4hop-worst20.json"
  const configPath = args["config"] || "autodev-config.json"
  const logLevel = (args["log-level"] || "warn") as LogLevel
  const idx = parseInt(args["idx"] ?? "13", 10)
  const maxHops = parseInt(args["max-hops"] || "3", 10)
  const contextPassages = parseInt(args["context-passages"] || "5", 10)
  const maxPassageChars = parseInt(args["max-passage-chars"] || "400", 10)
  const usePrompt = !args["no-prompt"]
  const promptText = args["prompt"] || "Identify newly appearing relevant clues in the material:"
  const topKShow = parseInt(args["topk-show"] || "15", 10)

  setGlobalLogger(new Logger({ name: "Debug", level: logLevel, timestamps: false, colors: true }))
  const log = getGlobalLogger()

  const items: Array<{ queryId: string; question: string; goldTitles: string[] }> = JSON.parse(fs.readFileSync(worst20Path, "utf-8"))
  const item = items[idx]
  const titleMap = loadTitleMap(corpusDir)
  const goldSet = new Set(item.goldTitles.map(t => t.toLowerCase()))

  log.info(`\n┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  log.info(`┃ Query [${idx}] ${item.queryId}`)
  log.info(`┃ ${item.question}`)
  log.info(`┃ Gold: ${item.goldTitles.join(" | ")}`)
  log.info(`┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)

  // 初始化
  const deps = createNodeDependencies({
    workspacePath: corpusDir,
    configOptions: { configPath },
    loggerOptions: { name: "Debug", level: logLevel, timestamps: false, colors: false },
  })
  await deps.configProvider.loadConfig()
  await registerProjectToCacheMap(corpusDir)
  const manager = CodeIndexManager.getInstance(deps)
  await manager.initialize({ searchOnly: true })
  if (manager.getCurrentStatus().systemStatus !== "Indexed") {
    log.error("索引未就绪"); process.exit(1)
  }
  const emb = (manager as any)._embedder as LlamaCppLlm2VecEmbedder
  const vs = manager.getDryRunComponents().vectorStore
  const rawCfg = await deps.configProvider.getConfig()
  const hybridCfg = { rawQuery: item.question, enabled: rawCfg?.hybridSearchEnabled ?? true, denseWeight: rawCfg?.hybridSearchDenseWeight ?? 1, sparseWeight: rawCfg?.hybridSearchSparseWeight ?? 0.3 }

  // recon 向量链多跳
  const reconHistory: number[][][] = []
  const seenDocs = new Set<string>()
  const hopResults: VectorStoreSearchResult[][] = []
  let prevNewAnswer = ""

  for (let hop = 0; hop < maxHops; hop++) {
    const prompt = hop === 0 ? "" : (usePrompt ? promptText : "")
    log.info(`╔══ hop ${hop} ════════════════════════════════════════════════════════════════`)
    log.info(`║ recon历史: ${reconHistory.length} 个 recon (each 10×${(emb as any)._nEmbd})`)
    if (hop > 0) {
      log.info(`║ prompt: "${prompt || "(空)"}"`)
      log.info(`║ 上跳新线索(prevNewAnswer, 前${maxPassageChars}字符):`)
      const ansPreview = prevNewAnswer.slice(0, maxPassageChars).replace(/\n/g, " ")
      log.info(`║   "${ansPreview}${prevNewAnswer.length > maxPassageChars ? "..." : ""}"`)
    }

    const { newRecon, embedding } = await emb.reconForward(reconHistory, item.question, prevNewAnswer, prompt)
    reconHistory.push(newRecon)

    const results = await vs.search(embedding, { limit: 50, minScore: 0 }, hybridCfg)
    hopResults.push(results)

    // 打印 top 检索结果
    log.info(`║ ── 检索 top ${Math.min(topKShow, results.length)} ──`)
    results.slice(0, topKShow).forEach((r, i) => {
      const fp = r.payload?.filePath || ""
      const title = filePathToTitle(fp, titleMap)
      const isGold = goldSet.has(title.toLowerCase())
      const isNew = !seenDocs.has(fp)
      const tag = `${isGold ? "[GOLD]" : "     "}${isNew ? "[NEW]" : "     "}`
      log.info(`║   ${String(i + 1).padStart(2)}. ${tag} ${(r.score).toFixed(3)} ${title}`)
    })

    // gold 排名
    const docScores = new Map<string, number>()
    for (const r of results) {
      const fp = r.payload?.filePath
      if (!fp) continue
      const prev = docScores.get(fp) ?? -1
      if (r.score > prev) docScores.set(fp, r.score)
    }
    const ranked = Array.from(docScores.entries()).sort((a, b) => b[1] - a[1]).map(([fp]) => filePathToTitle(fp, titleMap))
    const goldRanks = item.goldTitles.map(t => ({ title: t, rank: ranked.findIndex(r => r.toLowerCase() === t.toLowerCase()) + 1 }))
    log.info(`║ ── gold 排名（该跳单独）──`)
    goldRanks.forEach(g => log.info(`║   ${g.rank > 0 && g.rank <= 50 ? "✓" : "✗"} ${g.title}: ${g.rank > 0 ? "#" + g.rank : "不在top50"}`))

    // 去重：新文档
    const newResults = results.filter(r => {
      const fp = r.payload?.filePath
      if (!fp) return false
      if (seenDocs.has(fp)) return false
      seenDocs.add(fp)
      return true
    })
    log.info(`║ ── 本跳新文档: ${newResults.length} 个（取前${contextPassages}作下跳线索）──`)
    newResults.slice(0, contextPassages).forEach(r => {
      const title = filePathToTitle(r.payload?.filePath || "", titleMap)
      const isGold = goldSet.has(title.toLowerCase())
      const text = (r.payload?.codeChunk || "").replace(/\n/g, " ").slice(0, 180)
      log.info(`║   ${isGold ? "[GOLD]" : "     "} ${title}: ${text}..."`)
    })

    prevNewAnswer = newResults.slice(0, contextPassages).map(r => {
      const t = r.payload?.codeChunk || ""
      return t.length > maxPassageChars ? t.slice(0, maxPassageChars) : t
    }).filter(t => t.length > 0).join("\n")

    log.info(`╚════════════════════════════════════════════════════════════════════════════\n`)
  }

  // RRF 融合最终排名
  log.info(`╔══ RRF 融合所有跳 ═══════════════════════════════════════════════════════════`)
  const perHopRanks = hopResults.map(results => {
    const ds = new Map<string, number>()
    for (const r of results) {
      const fp = r.payload?.filePath
      if (!fp) continue
      const prev = ds.get(fp) ?? -1
      if (r.score > prev) ds.set(fp, r.score)
    }
    const ranked = Array.from(ds.entries()).sort((a, b) => b[1] - a[1])
    const m = new Map<string, number>()
    ranked.forEach(([fp], i) => m.set(fp, i))
    return m
  })
  const allDocs = new Set<string>()
  for (const r of perHopRanks) for (const fp of r.keys()) allDocs.add(fp)
  const fused: Array<{ fp: string; score: number }> = []
  for (const fp of allDocs) {
    let score = 0
    for (const ranks of perHopRanks) {
      const r = ranks.get(fp)
      if (r !== undefined) score += 1 / (60 + r)
    }
    fused.push({ fp, score })
  }
  fused.sort((a, b) => b.score - a.score)
  const fusedTitles = fused.map(f => filePathToTitle(f.fp, titleMap))
  log.info(`║ 最终 RRF top 20:`)
  fusedTitles.slice(0, 20).forEach((t, i) => {
    const isGold = goldSet.has(t.toLowerCase())
    log.info(`║   ${String(i + 1).padStart(2)}. ${isGold ? "[GOLD]" : "     "} ${t}`)
  })
  const goldFinalRanks = item.goldTitles.map(t => ({ title: t, rank: fusedTitles.findIndex(r => r.toLowerCase() === t.toLowerCase()) + 1 }))
  log.info(`║ gold 最终排名:`)
  goldFinalRanks.forEach(g => log.info(`║   ${g.rank > 0 ? "#" + g.rank : "未召回"} ${g.title}`))
  log.info(`╚════════════════════════════════════════════════════════════════════════════`)

  manager.dispose()
}

main().catch(e => { console.error(e); process.exit(1) })
