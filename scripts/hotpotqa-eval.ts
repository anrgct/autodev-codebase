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
  setGlobalLogger(new Logger({ name: "Eval", level, timestamps: false, colors: false }))
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
// Main
// ============================================================================

async function main() {
  const args = parseArgs()

  const corpusDir = args["corpus-dir"] || args["corpusDir"]
  const queriesPath = args["queries"]
  const configPath = args["config"] || path.join(process.cwd(), "autodev-config.json")
  const logLevel = (args["log-level"] || "info") as LogLevel
  const kListStr = args["k-list"] || DEFAULT_K_LIST.join(",")
  const kList = kListStr.split(",").map(Number).filter((k) => k > 0)

  if (!corpusDir || !queriesPath) {
    console.error(`
用法: npx tsx scripts/hotpotqa-eval.ts \
    --corpus-dir /tmp/hotpotqa-corpus \
    --queries <hotpotqa.json> \
    --config autodev-config.json \
    --k-list 1,5,10,20,50,100,200
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
  log.info(`已加载 ${queries.length} 个 query`)

  // 创建 CodeIndexManager
  log.info(`创建 CodeIndexManager, workspace: ${corpusDir}`)
  log.info(`配置: ${configPath}`)

  const deps = createNodeDependencies({
    workspacePath: corpusDir,
    configOptions: { configPath },
    loggerOptions: { name: "Eval", level: logLevel, timestamps: false, colors: false },
  })
  await deps.configProvider.loadConfig()

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
    // 先订阅 progress 事件，再启动索引，避免竞态
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const unsubscribe = manager.onProgressUpdate((data) => {
        if (settled) return
        if (data.systemStatus === "Indexed") {
          settled = true
          unsubscribe()
          log.info("索引完成")
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
  log.info("开始检索评测...")
  const perQuery: RecallResult[] = []
  let failedQueries = 0
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]
    if ((i + 1) % 10 === 0) {
      log.info(`  进度: ${i + 1}/${queries.length}`)
    }
    try {
      const result = await evaluateQuery(manager, q, titleMap, kList)
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

  // Pooling: 对所有 query 取平均
  const pooled: Record<number, number> = {}
  for (const k of kList) {
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
      reranker: false,
      highlighter: false,
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
  console.log(`  Query 数: ${queries.length}`)
  console.log("-".repeat(60))
  for (const k of kList) {
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
