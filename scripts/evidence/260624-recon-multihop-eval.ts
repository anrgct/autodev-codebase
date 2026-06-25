#!/usr/bin/env npx tsx
/**
 * recon 向量链递归多跳检索评测（260624-recon-agent-multihop 核心实验）。
 *
 * 流程（对每题）:
 *   reconHistory = []
 *   for hop in [0..maxHops):
 *     prompt = hop==0 ? "" : REASONING_PROMPT
 *     { newRecon, embedding } = reconForward(reconHistory, query, prevNewAnswer, prompt)
 *       // [recon×10@1]+...+[recon×10@n-1]+[query]+[新answer]+[prompt]+[question×10]
 *       //   → embd 注入 forward → question token 位置 hidden → recon_mlp → [recon×10@n]
 *     reconHistory.push(newRecon)
 *     results = vectorStore.search(embedding, ...)   // dense + BM25
 *     newResults = results 去重(已见文档)              // 只把新线索回传下跳
 *     prevNewAnswer = passages(newResults)
 *   最终排名 = RRF / BestRank / 最后一跳 三种融合对比
 *
 * ⚠️ 只读已有索引（searchOnly=true），不重建。
 *
 * 用法:
 *   npx tsx scripts/evidence/260624-recon-multihop-eval.ts \
 *     --corpus-dir /tmp/musique-corpus \
 *     --worst20 data/musique-4hop-worst20.json \
 *     --config autodev-config.json \
 *     --max-hops 2 --k-list 1,2,5,10,20,50 [--log-level warn]
 */
import * as path from "path"
import * as fs from "fs"
import { createNodeDependencies } from "../../src/adapters/nodejs"
import { CodeIndexManager } from "../../src/code-index/manager"
import { Logger, LogLevel, setGlobalLogger, getGlobalLogger } from "../../src/utils/logger"
import { registerProjectToCacheMap } from "../../src/commands/shared"
import { LlamaCppLlm2VecEmbedder } from "../../src/code-index/embedders/llamacpp-llm2vec"
import { VectorStoreSearchResult } from "../../src/code-index/interfaces"

const REASONING_PROMPT = "Identify newly appearing relevant clues in the material:"

// ── CLI ────────────────────────────────────────────────────────────────────
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

// ── 数据 ────────────────────────────────────────────────────────────────────
interface WorstItem { queryId: string; question: string; goldTitles: string[] }

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

// ── Recall / 融合 ───────────────────────────────────────────────────────────
function computeRecalls(rankedTitles: string[], goldTitles: string[], kList: number[]): Record<number, number> {
  const goldSet = new Set(goldTitles.map(t => t.toLowerCase()))
  const goldCount = goldTitles.length
  const recalls: Record<number, number> = {}
  for (const k of kList) {
    const hits = rankedTitles.slice(0, k).filter(t => goldSet.has(t.toLowerCase())).length
    recalls[k] = goldCount > 0 ? hits / goldCount : 0
  }
  return recalls
}

function buildDocRanks(results: VectorStoreSearchResult[]): Map<string, number> {
  const docScores = new Map<string, number>()
  for (const r of results) {
    const fp = r.payload?.filePath
    if (!fp) continue
    const prev = docScores.get(fp) ?? -1
    if (r.score > prev) docScores.set(fp, r.score)
  }
  const ranked = Array.from(docScores.entries()).sort((a, b) => b[1] - a[1])
  const ranks = new Map<string, number>()
  ranked.forEach(([fp], i) => ranks.set(fp, i))
  return ranks
}

/** RRF 融合：score = Σ 1/(60+rank) */
function rrfFuse(hopResults: VectorStoreSearchResult[][], titleMap: Map<string, string>): string[] {
  const perHopRanks = hopResults.map(buildDocRanks)
  const allDocs = new Set<string>()
  for (const r of perHopRanks) for (const fp of r.keys()) allDocs.add(fp)
  const fused: Array<{ fp: string; score: number }> = []
  for (const fp of allDocs) {
    let score = 0
    for (const ranks of perHopRanks) { const r = ranks.get(fp); if (r !== undefined) score += 1 / (60 + r) }
    fused.push({ fp, score })
  }
  fused.sort((a, b) => b.score - a.score)
  return fused.map(f => filePathToTitle(f.fp, titleMap))
}

/** BestRank 融合：取每个文档在所有跳的最优排名（衡量 gold 是否在任何跳被召回过）*/
function bestRankFuse(hopResults: VectorStoreSearchResult[][], titleMap: Map<string, string>): string[] {
  const perHopRanks = hopResults.map(buildDocRanks)
  const allDocs = new Set<string>()
  for (const r of perHopRanks) for (const fp of r.keys()) allDocs.add(fp)
  const best = new Map<string, number>()
  for (const fp of allDocs) {
    let b = Infinity
    for (const ranks of perHopRanks) { const r = ranks.get(fp); if (r !== undefined && r < b) b = r }
    best.set(fp, b)
  }
  return Array.from(best.entries()).sort((a, b) => a[1] - b[1]).map(([fp]) => filePathToTitle(fp, titleMap))
}

// ── recon 向量链递归多跳核心 ─────────────────────────────────────────────────
interface MultiHopOptions { maxHops: number; contextPassages: number; maxPassageChars: number }

async function evaluateReconMultiHop(
  emb: LlamaCppLlm2VecEmbedder,
  vs: any,
  item: WorstItem,
  titleMap: Map<string, string>,
  kList: number[],
  options: MultiHopOptions,
  hybridCfg: { enabled: boolean; denseWeight: number; sparseWeight: number },
  log: Logger,
): Promise<{
  hopResults: VectorStoreSearchResult[][]
  perHopRecalls: Record<number, number>[]
  perHopNewDocs: number[]
}> {
  const maxK = Math.max(...kList)
  const reconHistory: number[][][] = []
  const seenDocs = new Set<string>()
  const hopResults: VectorStoreSearchResult[][] = []
  const perHopRecalls: Record<number, number>[] = []
  const perHopNewDocs: number[] = []
  let prevNewAnswer = ""

  for (let hop = 0; hop < options.maxHops; hop++) {
    // 1. recon 历史 forward → 新 recon + 检索向量
    //    首跳无历史无 answer（等价纯 query forward），后续跳融入推理历史 + 上一跳新线索
    const prompt = hop === 0 ? "" : REASONING_PROMPT
    const { newRecon, embedding } = await emb.reconForward(reconHistory, item.question, prevNewAnswer, prompt)
    reconHistory.push(newRecon)

    // 2. 检索（dense + BM25；BM25 rawQuery 始终用原始 query）
    const results = await vs.search(
      embedding,
      { limit: maxK, minScore: 0 },
      { rawQuery: item.question, enabled: hybridCfg.enabled, denseWeight: hybridCfg.denseWeight, sparseWeight: hybridCfg.sparseWeight },
    )
    hopResults.push(results)

    const hopRanks = buildDocRanks(results)
    const hopTitles = Array.from(hopRanks.keys()).map(fp => filePathToTitle(fp, titleMap))
    perHopRecalls.push(computeRecalls(hopTitles, item.goldTitles, kList))

    // 3. 去重：本跳新出现的文档 → 下一跳的 newAnswer（只回传新线索，避免重复稀释）
    const newResults = results.filter(r => {
      const fp = r.payload?.filePath
      if (!fp) return false
      if (seenDocs.has(fp)) return false
      seenDocs.add(fp)
      return true
    })
    perHopNewDocs.push(newResults.length)

    prevNewAnswer = newResults
      .slice(0, options.contextPassages)
      .map(r => {
        const t = r.payload?.codeChunk || ""
        return t.length > options.maxPassageChars ? t.slice(0, options.maxPassageChars) : t
      })
      .filter(t => t.length > 0)
      .join("\n")

    log.debug(`  [hop${hop}] results=${results.length} newDocs=${newResults.length} reconHistory=${reconHistory.length} answerLen=${prevNewAnswer.length}`)
  }

  return { hopResults, perHopRecalls, perHopNewDocs }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs()
  const corpusDir = args["corpus-dir"]
  const worst20Path = args["worst20"]
  const configPath = args["config"] || "autodev-config.json"
  const logLevel = (args["log-level"] || "info") as LogLevel
  const kList = (args["k-list"] || "1,2,5,10,20,50").split(",").map(s => parseInt(s, 10))
  const options: MultiHopOptions = {
    maxHops: parseInt(args["max-hops"] || "2", 10),
    contextPassages: parseInt(args["context-passages"] || "5", 10),
    maxPassageChars: parseInt(args["max-passage-chars"] || "500", 10),
  }

  if (!corpusDir || !worst20Path) {
    console.error(`用法: npx tsx scripts/evidence/260624-recon-multihop-eval.ts \
      --corpus-dir /tmp/musique-corpus --worst20 data/musique-4hop-worst20.json \
      --config autodev-config.json --max-hops 2`)
    process.exit(1)
  }

  setGlobalLogger(new Logger({ name: "MultiHop", level: logLevel, timestamps: true, colors: false }))
  const log = getGlobalLogger()

  const items: WorstItem[] = JSON.parse(fs.readFileSync(worst20Path, "utf-8"))
  const titleMap = loadTitleMap(corpusDir)
  log.info(`加载 ${items.length} 题, titleMap=${titleMap.size}`)
  log.info(`配置: maxHops=${options.maxHops} ctxPassages=${options.contextPassages} maxChars=${options.maxPassageChars}`)

  // 初始化 manager（searchOnly，复用已有索引）
  const deps = createNodeDependencies({
    workspacePath: corpusDir,
    configOptions: { configPath },
    loggerOptions: { name: "MultiHop", level: logLevel, timestamps: true, colors: false },
  })
  await deps.configProvider.loadConfig()
  await registerProjectToCacheMap(corpusDir)
  const manager = CodeIndexManager.getInstance(deps)
  await manager.initialize({ searchOnly: true })
  if (manager.getCurrentStatus().systemStatus !== "Indexed") {
    log.error(`索引未就绪 (status=${manager.getCurrentStatus().systemStatus})，请先用 hotpotqa-eval.ts 建索引`)
    process.exit(1)
  }
  log.info("索引已就绪（复用）")

  const emb = (manager as any)._embedder as LlamaCppLlm2VecEmbedder
  const vs = manager.getDryRunComponents().vectorStore
  const rawCfg = await deps.configProvider.getConfig()
  const hybridCfg = {
    enabled: rawCfg?.hybridSearchEnabled ?? true,
    denseWeight: rawCfg?.hybridSearchDenseWeight ?? 1,
    sparseWeight: rawCfg?.hybridSearchSparseWeight ?? 0.3,
  }

  // 跑评测
  const t0 = performance.now()
  const singleRecalls: Record<number, number>[] = []
  const rrfRecalls: Record<number, number>[] = []
  const bestRankRecalls: Record<number, number>[] = []
  const perHopAll: Record<number, number>[][] = []
  const newDocsAll: number[][] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    try {
      // 单跳 baseline（manager.searchIndex 标准路径）
      const hop1 = await manager.searchIndex(item.question, { limit: Math.max(...kList) })
      const hop1Titles = Array.from(buildDocRanks(hop1).keys()).map(fp => filePathToTitle(fp, titleMap))
      singleRecalls.push(computeRecalls(hop1Titles, item.goldTitles, kList))

      // recon 向量链递归多跳
      const mh = await evaluateReconMultiHop(emb, vs, item, titleMap, kList, options, hybridCfg, log)
      perHopAll.push(mh.perHopRecalls)
      newDocsAll.push(mh.perHopNewDocs)
      rrfRecalls.push(computeRecalls(rrfFuse(mh.hopResults, titleMap), item.goldTitles, kList))
      bestRankRecalls.push(computeRecalls(bestRankFuse(mh.hopResults, titleMap), item.goldTitles, kList))

      const fmt = (r: Record<number, number>) => kList.map(k => `R@${k}=${(r[k] * 100).toFixed(0)}%`).join(" ")
      log.info(`[${i}] ${item.queryId}`)
      log.info(`    单跳    : ${fmt(singleRecalls[i])}`)
      log.info(`    多跳RRF : ${fmt(rrfRecalls[i])}`)
      log.info(`    多跳Best: ${fmt(bestRankRecalls[i])}`)
    } catch (e: any) {
      log.error(`[${i}] ${item.queryId} 失败: ${e.message}`)
      const zero = Object.fromEntries(kList.map(k => [k, 0]))
      singleRecalls.push(zero); rrfRecalls.push({ ...zero }); bestRankRecalls.push({ ...zero })
      perHopAll.push([]); newDocsAll.push([])
    }
  }

  const dur = ((performance.now() - t0) / 1000).toFixed(1)

  // 汇总
  const pool = (rs: Record<number, number>[]) => {
    const out: Record<number, number> = {}
    for (const k of kList) out[k] = rs.reduce((s, r) => s + (r[k] || 0), 0) / rs.length
    return out
  }
  const fmtPool = (r: Record<number, number>) => kList.map(k => `R@${k}=${(r[k] * 100).toFixed(2)}%`).join("  ")
  log.info("\n" + "═".repeat(70))
  log.info(`汇总 (${items.length} 题, ${dur}s, maxHops=${options.maxHops})`)
  log.info("═".repeat(70))
  log.info(`单跳 baseline   : ${fmtPool(pool(singleRecalls))}`)
  log.info(`多跳 RRF        : ${fmtPool(pool(rrfRecalls))}`)
  log.info(`多跳 BestRank   : ${fmtPool(pool(bestRankRecalls))}  ← 取所有跳最优排名`)

  // 每跳趋势
  for (let h = 0; h < options.maxHops; h++) {
    const hopRs = perHopAll.map(qh => qh[h]).filter(Boolean) as Record<number, number>[]
    const avgNew = newDocsAll.map(qh => qh[h]).filter(n => n !== undefined).reduce((s, n) => s + n, 0) / items.length
    if (hopRs.length > 0) log.info(`  hop${h} 单独      : ${fmtPool(pool(hopRs))}  (avg ${avgNew.toFixed(1)} new docs)`)
  }

  const outPath = "/tmp/260624-recon-multihop-eval.json"
  fs.writeFileSync(outPath, JSON.stringify({ options, kList, single: pool(singleRecalls), rrf: pool(rrfRecalls), bestRank: pool(bestRankRecalls) }, null, 2))
  log.info(`详细结果: ${outPath}`)

  manager.dispose()
}

main().catch(err => { console.error(err); process.exit(1) })
