#!/usr/bin/env node
/**
 * HotpotQA Recall@K 评测脚本
 *
 * 直接使用 autodev-codebase 的 library API，一次加载模型，批量评测。
 * 无 reranker、无 highlighter，纯向量检索 + 混合搜索。
 *
 * 用法:
 *   1) 先准备语料 .md 文件:
 *      python scripts/prepare-corpus.py --corpus <hotpotqa_corpus.json> --out /tmp/hotpotqa-corpus
 *
 *   2) 运行评测:
 *      npx tsx scripts/hotpotqa-eval.ts \
 *        --corpus-dir /tmp/hotpotqa-corpus \
 *        --queries <hotpotqa.json> \
 *        --config autodev-config.json
 *
 * HotpotQA 数据格式 (HippoRAG reproduce/dataset/hotpotqa.json):
 *   [
 *     {
 *       "_id": "5abe...",
 *       "answer": "...",
 *       "question": "what is one of the stars of The Newcomers known for",
 *       "supporting_facts": [["The Newcomers (film)", 0], ["Chris Evans (actor)", 1]],
 *       "context": [["title", ["sentence1", "sentence2", ...]], ...]
 *     }
 *   ]
 */

import * as path from "path"
import * as fs from "fs"
import { createNodeDependencies } from "../src/adapters/nodejs"
import { CodeIndexManager } from "../src/code-index/manager"
import { Logger, LogLevel, setGlobalLogger, getGlobalLogger } from "../src/utils/logger"
import { registerProjectToCacheMap } from "../src/commands/shared"

// 包装函数，保持与 commands/shared.ts 一致的接口
function getLogger() { return getGlobalLogger() }
function initGlobalLogger(level: LogLevel) {
  setGlobalLogger(new Logger({ name: "Eval", level, timestamps: true, colors: false }))
}

// ============================================================================
// Types
// ============================================================================

interface HotpotQAQuery {
  _id: string
  answer: string
  question: string
  supporting_facts: [string, number][]  // [title, sentence_idx]
  context: [string, string[]][]         // [title, sentences]
}

interface MusiqueQuery {
  id: string
  answer: string
  question: string
  paragraphs: {
    idx: number
    title: string
    paragraph_text: string
    is_supporting: boolean
  }[]
  answer_aliases: string[]
  answerable: boolean
}

type Query = HotpotQAQuery | MusiqueQuery

interface TwoHopOptions {
  /** 启用两跳搜索 */
  enabled: boolean
  /** 第一跳检索的 passage 数量 */
  firstHopK: number
  /** 拼入扩展 query 的 passage 数量 */
  contextPassages: number
  /** 每个 passage 截取的最大字符数 */
  maxPassageChars: number
}

const DEFAULT_TWO_HOP: TwoHopOptions = {
  enabled: false,
  firstHopK: 20,
  contextPassages: 5,
  maxPassageChars: 500,
}

interface RecallResult {
  queryId: string
  question: string
  goldTitles: string[]
  // per-K recall
  recalls: Record<number, number>
}

interface EvalResults {
  config: {
    embedder: string
    model: string
    poolingMode: string
    hybridSearch: boolean
    reranker: boolean
    highlighter: boolean
  }
  perQuery: RecallResult[]
  pooled: Record<number, number>  // 平均 recall@k
}

// ============================================================================
// CLI args
// ============================================================================

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

// ============================================================================
// Helpers
// ============================================================================

/** 从 metadata.json 或 filename 推断 title */
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

/** 从 filePath (如 "foo.md") 还原文档标题 */
function filePathToTitle(filePath: string, titleMap: Map<string, string>): string {
  const basename = path.basename(filePath)
  if (titleMap.has(basename)) return titleMap.get(basename)!
  // fallback: 去掉 .md 后缀
  if (basename.endsWith(".md")) return basename.slice(0, -3)
  return basename
}

/** 从 query 中提取 gold 文档标题列表，支持 HotpotQA 和 Musique 两种格式 */
function extractGoldTitles(query: Query): string[] {
  const titles = new Set<string>()

  if ("supporting_facts" in query) {
    // HotpotQA 格式
    const hq = query as HotpotQAQuery
    for (const [title] of hq.supporting_facts) {
      titles.add(title)
    }
    // 有些 query 的 supporting_facts 可能不完整，用 context 补全
    for (const [title] of hq.context) {
      if (hq.supporting_facts.some(([t]) => t === title)) {
        titles.add(title)
      }
    }
  } else {
    // Musique 格式
    const mq = query as MusiqueQuery
    for (const p of mq.paragraphs) {
      if (p.is_supporting) {
        titles.add(p.title)
      }
    }
  }

  return Array.from(titles)
}

/** 获取 query 的唯一 ID，支持两种格式 */
function getQueryId(query: Query): string {
  if ("_id" in query) {
    return (query as HotpotQAQuery)._id
  }
  return (query as MusiqueQuery).id
}

/** Recherche des K à évaluer */
const DEFAULT_K_LIST = [1, 2, 5, 10, 20, 50, 100, 150, 200]

/** reranker 启用时的默认 K 列表（rerank 200 个候选太慢，只评小 K） */
const DEFAULT_K_LIST_WITH_RERANKER = [1, 2, 5, 10, 20, 50]

// ============================================================================
// Recherche et Recall
// ============================================================================

/**
 * 对单个 query 计算 Recall@K。
 * 从结果中按 filePath 分组，每篇文档取其最高分的 block 作为文档分数。
 * 按文档分数降序排列后，判断 top-K 中有多少命中 gold 文档。
 */
async function evaluateQuery(
  manager: CodeIndexManager,
  query: Query,
  titleMap: Map<string, string>,
  kList: number[],
): Promise<RecallResult> {
  const goldTitles = extractGoldTitles(query)
  const goldSet = new Set(goldTitles.map((t) => t.toLowerCase()))

  // 搜索：limit 取 kList 最大值
  const maxK = Math.max(...kList)
  const results = await manager.searchIndex(query.question, { limit: maxK })

  // 分组：filePath → 最高分
  const docScores = new Map<string, number>()
  for (const r of results) {
    if (!r.payload?.filePath) continue
    const filePath = r.payload.filePath
    const existing = docScores.get(filePath) ?? 0
    if (r.score > existing) {
      docScores.set(filePath, r.score)
    }
  }

  // 按分数降序排列文档
  const rankedDocs = Array.from(docScores.entries())
    .sort((a, b) => b[1] - a[1])

  // 将 filePath 转为 title 并排名
  const rankedTitles = rankedDocs.map(([fp]) => filePathToTitle(fp, titleMap))

  // 对每个 K 计算 recall
  const recalls: Record<number, number> = {}
  const goldCount = goldTitles.length
  for (const k of kList) {
    const topK = rankedTitles.slice(0, k)
    const hits = topK.filter((t) => goldSet.has(t.toLowerCase())).length
    recalls[k] = goldCount > 0 ? hits / goldCount : 0
  }

  return {
    queryId: getQueryId(query),
    question: query.question,
    goldTitles,
    recalls,
  }
}

// ============================================================================
// Two-Hop Search
// ============================================================================

/**
 * 两跳检索：第一跳获取上下文 passages，拼入原始 query 后做第二跳检索。
 *
 * 原理：对于多跳 QA（如 Musique），第一跳检索到的 passages 包含中间实体信息，
 * 将这些上下文拼入 query 后，LLM2Vec 的编码器能产出更精确的查询向量，
 * 从而在第二跳中检索到第一跳漏掉的关联文档。
 *
 * 流程：
 *   1) 原始 query → LLM2Vec 编码 → 检索 firstHopK 个 passages
 *   2) 取 top-contextPassages 个 passage 的文本（截断）
 *   3) 拼接 expandedQuery = 原始query + 上下文passages
 *   4) expandedQuery → LLM2Vec 编码 → 检索最终结果
 */
async function evaluateQueryTwoHop(
  manager: CodeIndexManager,
  query: Query,
  titleMap: Map<string, string>,
  kList: number[],
  options: TwoHopOptions,
  log: Logger,
): Promise<RecallResult> {
  const goldTitles = extractGoldTitles(query)
  const goldSet = new Set(goldTitles.map((t) => t.toLowerCase()))
  const maxK = Math.max(...kList)

  // 第一跳统一用 firstHopK（与 debug 脚本一致）
  const hop1Limit = options.firstHopK

  // ── 第一跳：用原始 query 检索 ──
  const firstHopResults = await manager.searchIndex(query.question, {
    limit: hop1Limit,
  })

  if (firstHopResults.length === 0) {
    log.debug(`  [two-hop] 第一跳无结果，跳过: ${query.question.slice(0, 60)}`)
    return {
      queryId: getQueryId(query),
      question: query.question,
      goldTitles,
      recalls: Object.fromEntries(kList.map((k) => [k, 0])) as Record<number, number>,
    }
  }

  // ── 构建扩展 query：正文拼接 ──
  // 取 top-N passages 的 codeChunk 正文，截断后拼接
  const contextChunks = firstHopResults
    .slice(0, options.contextPassages)
    .map((r) => {
      const text = r.payload?.codeChunk || ""
      return text.length > options.maxPassageChars
        ? text.slice(0, options.maxPassageChars) + "..."
        : text
    })
    .filter((t) => t.length > 0)

  const expandedQuery = contextChunks.length > 0
    ? `${query.question}\n\nRelevant context:\n${contextChunks.join("\n---\n")}`
    : query.question

  // ── 第二跳：用扩展 query 检索 ──
  const secondHopResults = await manager.searchIndex(expandedQuery, { limit: maxK })

  // ── 构建文档级排名 ──
  const buildDocRanks = (results: typeof firstHopResults): Map<string, number> => {
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

  let rankedTitles: string[]

  if (options.fusion === "rrf") {
    // RRF 融合：score = Σ 1/(60 + rank)
    const K = 60
    const hop1Ranks = buildDocRanks(firstHopResults)
    const hop2Ranks = buildDocRanks(secondHopResults)
    const allDocs = new Set<string>([...hop1Ranks.keys(), ...hop2Ranks.keys()])
    const fused: Array<{ fp: string; score: number }> = []
    for (const fp of allDocs) {
      let score = 0
      const r1 = hop1Ranks.get(fp)
      const r2 = hop2Ranks.get(fp)
      if (r1 !== undefined) score += 1 / (K + r1)
      if (r2 !== undefined) score += 1 / (K + r2)
      fused.push({ fp, score })
    }
    fused.sort((a, b) => b.score - a.score)
    rankedTitles = fused.map((f) => filePathToTitle(f.fp, titleMap))
  } else {
    // 非融合：只用第二跳结果
    const hop2Ranks = buildDocRanks(secondHopResults)
    rankedTitles = Array.from(hop2Ranks.keys()).map((fp) => filePathToTitle(fp, titleMap))
  }

  // ── recall 计算 ──
  const recalls: Record<number, number> = {}
  const goldCount = goldTitles.length
  for (const k of kList) {
    const topK = rankedTitles.slice(0, k)
    const hits = topK.filter((t) => goldSet.has(t.toLowerCase())).length
    recalls[k] = goldCount > 0 ? hits / goldCount : 0
  }

  return {
    queryId: getQueryId(query),
    question: query.question,
    goldTitles,
    recalls,
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = parseArgs()

  const corpusDir = args["corpus-dir"] || args["corpusDir"]
  const queriesPath = args["queries"]
  const configPath = args["config"] || path.join(process.cwd(), "autodev-config.json")
  const logLevel = (args["log-level"] || "info") as LogLevel
  const kListStr = args["k-list"]
  const kList = (kListStr ?? DEFAULT_K_LIST.join(",")).split(",").map(Number).filter((k) => k > 0)

  // 两跳搜索参数
  const twoHop: TwoHopOptions = {
    enabled: args["two-hop"] === "true",
    firstHopK: parseInt(args["first-hop-k"] || "20", 10),
    contextPassages: parseInt(args["context-passages"] || "5", 10),
    maxPassageChars: parseInt(args["max-passage-chars"] || "500", 10),
    fusion: (args["fusion"] as "none" | "rrf") || "none",
  }

  if (!corpusDir || !queriesPath) {
    console.error(`
用法: npx tsx scripts/hotpotqa-eval.ts \\
    --corpus-dir /tmp/hotpotqa-corpus \\
    --queries <hotpotqa.json> \\
    --config autodev-config.json \\
    --k-list 1,5,10,20,50,100,200 \\
    [--two-hop true] [--first-hop-k 20] [--context-passages 5] [--max-passage-chars 500]
    `)
    process.exit(1)
  }

  // 初始化 logger
  initGlobalLogger(logLevel)
  const log = getLogger()

  // 加载 title 映射
  const titleMap = loadTitleMap(corpusDir)
  log.info(`已加载 ${titleMap.size} 个文档映射`)

  // 加载 queries
  const rawQueries: any[] = JSON.parse(fs.readFileSync(queriesPath, "utf-8"))
  // 自动检测格式
  const isMusique = "paragraphs" in (rawQueries[0] || {})
  if (isMusique) {
    log.info(`检测到 Musique 格式 (${rawQueries.length} queries)`)
  } else {
    log.info(`检测到 HotpotQA 格式 (${rawQueries.length} queries)`)
  }
  const queries: Query[] = rawQueries
  const twoHopLabel = twoHop.enabled
    ? `两跳(${twoHop.fusion === "rrf" ? "RRF融合," : ""}ctx=${twoHop.contextPassages}, maxChars=${twoHop.maxPassageChars})`
    : "单跳"
  log.info(`已加载 ${queries.length} 个 query, 搜索模式: ${twoHopLabel}`)

  // 创建 CodeIndexManager
  log.info(`创建 CodeIndexManager, workspace: ${corpusDir}`)
  log.info(`配置: ${configPath}`)

  const deps = createNodeDependencies({
    workspacePath: corpusDir,
    configOptions: { configPath },
    loggerOptions: { name: "Eval", level: logLevel, timestamps: true, colors: false },
  })
  await deps.configProvider.loadConfig()

  // 如果未显式指定 k-list 且 reranker 启用，自动缩减 K（避免重排 200 个候选）
  const rawConfigPeek = await deps.configProvider.getConfig()
  const rerankerOn = rawConfigPeek?.rerankerEnabled === true
  let effectiveKList = kList
  if (rerankerOn && !kListStr && kList.length > 50) {
    effectiveKList = DEFAULT_K_LIST_WITH_RERANKER
    log.info(`检测到 reranker 启用，自动缩减 K 列表为 ${effectiveKList.join(",")}（避免重排过多候选）`)
  }

  // 注册到 project map，让 codebase cache --list 能显示项目名
  await registerProjectToCacheMap(corpusDir)

  const manager = CodeIndexManager.getInstance(deps)
  // 使用 searchOnly=true 初始化，不自动启动索引
  await manager.initialize({ searchOnly: true })

  // 检查索引状态
  const initStatus = manager.getCurrentStatus()
  if (initStatus.systemStatus !== "Indexed") {
    // 需要索引
    log.info("开始索引...")
    const tIdx0 = performance.now()
    // 先订阅 progress 事件，再启动索引，避免竞态
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const unsubscribe = manager.onProgressUpdate((data) => {
        if (settled) return
        if (data.systemStatus === "Indexed") {
          settled = true
          unsubscribe()
          const dur = ((performance.now() - tIdx0) / 1000).toFixed(1)
          log.info(`索引完成 (${dur}s)`)
          resolve()
        } else if (data.systemStatus === "Error") {
          settled = true
          unsubscribe()
          reject(new Error("索引失败"))
        }
      })
      // 如果已经 Standby（首次运行），启动索引
      if (initStatus.systemStatus === "Standby") {
        manager.startIndexing().catch(reject)
      }
      // 如果已经是 Indexing（可能被其他组件启动），等 progress 事件
    })
  } else {
    log.info("索引已存在")
  }

  // 执行所有 query 的检索
  const tSearch0 = performance.now()
  log.info("开始检索评测...")
  const perQuery: RecallResult[] = []
  let failedQueries = 0
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]
    if ((i + 1) % 10 === 0) {
      log.info(`  进度: ${i + 1}/${queries.length}`)
    }
    try {
      const result = twoHop.enabled
        ? await evaluateQueryTwoHop(manager, q, titleMap, effectiveKList, twoHop, log)
        : await evaluateQuery(manager, q, titleMap, effectiveKList)
      perQuery.push(result)
    } catch (err) {
      failedQueries++
      log.warn(`  Query ${i} 失败: ${q.question.slice(0, 60)}...`)
      if (err instanceof Error) {
        log.warn(`    ${err.message.slice(0, 100)}`)
      }
      // 恢复状态，让后续 query 能继续检索
      if (manager.getCurrentStatus().systemStatus === "Error") {
        ;(manager as any)._stateManager.setSystemState("Indexed", "Recovered")
      }
    }
  }
  if (failedQueries > 0) {
    log.warn(`${failedQueries} 个 query 检索失败，将被跳过`)
  }
  const searchDur = ((performance.now() - tSearch0) / 1000).toFixed(1)
  log.info(`检索完成 (${searchDur}s, ${queries.length - failedQueries}/${queries.length} queries)`)

  // Pooling: 对所有 query 取平均
  const pooled: Record<number, number> = {}
  for (const k of effectiveKList) {
    const sum = perQuery.reduce((acc, r) => acc + (r.recalls[k] ?? 0), 0)
    pooled[k] = queries.length > 0 ? sum / queries.length : 0
  }

  // 输出结果
  const rawConfig = await deps.configProvider.getConfig()
  // llamacpp / llamacpp-llm provider 实际使用的模型来自 GGUF 路径，不是 embedderModelId
  let actualModel = rawConfig?.embedderModelId ?? "unknown"
  if (rawConfig?.embedderProvider === "llamacpp" && rawConfig?.embedderGgufPath) {
    const ggufFile = rawConfig.embedderGgufPath.split("/").pop() || ""
    actualModel = ggufFile.replace(/\.gguf$/, "")
  } else if (rawConfig?.embedderProvider === "llamacpp-llm" && rawConfig?.embedderGgufLlmPath) {
    const ggufFile = rawConfig.embedderGgufLlmPath.split("/").pop() || ""
    actualModel = ggufFile.replace(/\.gguf$/, "")
  } else if (rawConfig?.embedderProvider === "llm2vec" && rawConfig?.embedderGgufLlm2vecPath) {
    const ggufFile = rawConfig.embedderGgufLlm2vecPath.split("/").pop() || ""
    actualModel = ggufFile.replace(/\.gguf$/, "")
  }
  // poolingMode 仅对 llamacpp-llm 生效，llamacpp 使用内置 embedding 模型（GGUF 自带 pool）
  let effectivePooling = rawConfig?.embedderPoolingMode ?? "n/a"
  if (rawConfig?.embedderProvider !== "llamacpp-llm") {
    effectivePooling = "model-builtin"
  }
  const finalResults: EvalResults = {
    config: {
      embedder: rawConfig?.embedderProvider ?? "unknown",
      model: actualModel,
      poolingMode: effectivePooling,
      hybridSearch: rawConfig?.hybridSearchEnabled ?? false,
      reranker: rawConfig?.rerankerEnabled ?? false,
      highlighter: rawConfig?.highlighterEnabled ?? false,
    },
    perQuery,
    pooled,
  }

  const datasetName = "paragraphs" in (rawQueries[0] || {}) ? "Musique" : "HotpotQA"

  console.log("\n" + "=".repeat(60))
  console.log(`  ${datasetName} Recall@K 评测结果`)
  console.log("=".repeat(60))
  console.log(`  配置: ${finalResults.config.embedder} / ${finalResults.config.model}`)
  console.log(`  Pooling: ${finalResults.config.poolingMode}`)
  console.log(`  混合搜索: ${finalResults.config.hybridSearch}`)
  console.log(`  Reranker: ${finalResults.config.reranker} (${rawConfig?.rerankerProvider ?? ""})`)
  console.log(`  Highlighter: ${finalResults.config.highlighter}`)
  console.log(`  搜索模式: ${twoHopLabel}`)
  console.log(`  Query 数: ${queries.length}`)
  console.log("-".repeat(60))
  for (const k of effectiveKList) {
    console.log(`  Recall@${String(k).padEnd(4)} = ${(pooled[k] * 100).toFixed(2)}%`)
  }
  console.log("-".repeat(60))

  // 保存详细结果
  const outPath = `${datasetName.toLowerCase()}-recall-${Date.now()}.json`
  fs.writeFileSync(outPath, JSON.stringify(finalResults, null, 2), "utf-8")
  console.log(`\n详细结果已保存: ${outPath}`)

  manager.dispose()
}

main().catch((err) => {
  console.error("评测失败:", err)
  process.exit(1)
})
