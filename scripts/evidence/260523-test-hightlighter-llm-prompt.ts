/**
 * Prompt 优化测试工具 — 精简版 (v2: 修复解析器 + 优化 Prompt)
 *
 * 只测试关键的正例/反例代码片段，复用 context 加速。
 * 用法: npx tsx _test_prompts.ts
 */
import { getLlama, LlamaChatSession, QwenChatWrapper, LlamaLogLevel } from "@realtimex/node-llama-cpp"
import * as fs from "fs"
import * as path from "path"

// ── 配置 ──────────────────────────────────────────────
// const MODEL = "/Users/anrgct/llm_models/unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-UD-Q6_K_XL.gguf"
// const MODEL = "/Users/anrgct/llm_models/unsloth/Qwen3.5-0.8B-GGUF/Qwen3.5-0.8B-Q8_0.gguf"
const MODEL = "/Users/anrgct/llm_models/openbmb/MiniCPM-V-4.6-gguf/MiniCPM-V-4_6-Q8_0.gguf"
// const MODEL = "/Users/anrgct/llm_models/unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.gguf"
// const MODEL = "/Users/anrgct/llm_models/unsloth/Qwen3.5-2B-GGUF/Qwen3.5-2B-UD-Q8_K_XL.gguf"
// const MODEL = "/Users/anrgct/llm_models/unsloth/Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf"
const DEMO_DIR = path.resolve("../demo")

function loadFile(name: string): string {
  return fs.readFileSync(path.join(DEMO_DIR, name), "utf-8")
}

function extractLines(code: string, from: number, to: number): { lines: string[]; startLine: number } {
  const allLines = code.split("\n")
  return {
    lines: allLines.slice(from - 1, to),
    startLine: from,
  }
}

function numbered(lines: string[], startLine: number): string {
  return lines.map((l, i) => `${String(startLine + i).padStart(4)}  ${l}`).join("\n")
}

// ── Prompt 变体 ───────────────────────────────────────
interface PromptVariant {
  name: string
  build: (query: string, lines: string[], startLine: number) => string
}

const PROMPTS: PromptVariant[] = [
  // V1: 当前版本（纯数字格式 + 负面约束）
  {
    name: "V1-SINGLE-RANGE",
    build: (q, lines, start) => {
      return `Find lines answering: "${q}" in the code below.
Semantically related content counts (synonyms, alternative names, related concepts).
Reply format: START END  (0 0 if nothing relevant)

Do NOT flag code just because it shares keywords with the query.

Example (query "where is train method"):
10001  class Model:
10002      def train(self, data, epochs=10):
10003          return self
Reply: 10002 10003

Example (nothing relevant):
20001  @property
20002      return self.device
Reply: 0 0

--- NOW ANALYZE (ignore example line numbers, use real ones below) ---
${numbered(lines, start)}
Reply:`
    },
  },

  // V2: 复合 — 先 YES/NO 再标注
  {
    name: "V2-YESNO-THEN-RANGE",
    build: (q, lines, start) => {
      const last = start + lines.length - 1
      return `Is this code about "${q}"? First answer YES or NO. Then give line range.

YES example:
Code:
  10  def add(a,b): return a+b
  12  return result
Query: "addition function"
Answer: YES
Range: 10 10

NO example:
Code:
  10  def add(a,b): return a+b
Query: "file reading"
Answer: NO
Range: 0 0

Code (lines ${start}-${last}):
${numbered(lines, start)}
Answer:`
    },
  },

  // V3: 评分 — 给每行打分 0-2
  {
    name: "V3-SCORE-PER-LINE",
    build: (q, lines, start) => {
      return `For query "${q}", score each line: 2=highly relevant, 1=somewhat relevant, 0=not relevant.
Output one line per code line, format: LINENUM SCORE

Example:
Query: "print function"
  10  console.log("hello")
  11  return x
  12  print(value)
Scores:
10 1
11 0
12 2

Code:
${numbered(lines, start)}
Scores:`
    },
  },

  // V4: 倒排 — 先列出不匹配的行，剩下的就是匹配的
  {
    name: "V4-ELIMINATION",
    build: (q, lines, start) => {
      const last = start + lines.length - 1
      return `Your task: eliminate ALL lines that are NOT about "${q}".
List the line numbers that should be ELIMINATED.
The remaining lines will be considered as relevant.

IMPORTANT: If NO lines in the code are about "${q}", then ALL lines must be eliminated.

Example (some lines unrelated):
Query: "multiplication"
  10  x = 5 * 3
  11  print("hello")
  12  y = a * b
Eliminate: 11

Example (all lines relevant - eliminate nothing):
Query: "greeting"
  20  function greet(name) {
  21    console.log("Hi " + name)
  22  }
Eliminate: 0

Example (nothing relevant - eliminate ALL):
Query: "database connection"
  30  function greet(name) {
  31    return "Hello " + name
  32  }
Eliminate: 30-32

Code (${start}-${last}):
${numbered(lines, start)}
Eliminate:`
    },
  },

  // V5: 极简否定 — 要求输出逗号分隔的行号列表
  {
    name: "V5-NEGATIVE-ONLY",
    build: (q, lines, start) => {
      const last = start + lines.length - 1
      return `This code is NOT about "${q}". Which lines DO relate to "${q}"?
Output ONLY line numbers separated by commas (e.g., 10,12,15).
If there are none, output 0.

Code (${start}-${last}):
${numbered(lines, start)}
Relevant lines:`
    },
  },

  // V6: 使用代码原生行号
  {
    name: "V6-NATIVE-LINE-NUMBERS",
    build: (q, lines, start) => {
      const codeWithNumbers = lines.map((l, i) => `L${start + i}: ${l}`).join("\n")
      return `Which lines (L-number) in this code relate to: "${q}"?
Include lines that define, implement, reference, or describe the topic.
Answer format: LINUM1-LINUM2, or NONE

Code:
${codeWithNumbers}
Answer:`
    },
  },

  // ── V7: 极简零样本 — 无示例、"about" 替代 "answering" ──
  {
    name: "V7-MINIMAL-ABOUT",
    build: (q, lines, start) => {
      return `Is any part of this code about "${q}"?\n\nAbout = same topic or concept. Synonyms count. Different topic = not about.\n\nIf about: output START N END M (N=first relevant line, M=last relevant line)\nIf not about: output 0 0\n\nCODE:\n${numbered(lines, start)}\n\nOUTPUT:`
    },
  },

  // ── V8: 语义过滤 — 明确的 YES/NO 规则 + 反例约束 ──
  {
    name: "V8-SEMANTIC-FILTER",
    build: (q, lines, start) => {
      return `Find lines on topic: "${q}"\n\nMATCH if lines: define, implement, or describe the topic (synonyms count)\nNO MATCH if: different topic, even if some words overlap\n\nCRITICAL: Do NOT match just because a word appears.\nExample: "load_trainer" is NOT about "train method" (different concept)\nExample: "is_hub_model" is NOT about "greeting" (unrelated)\n\nOutput: two numbers (first last) or 0 0 if nothing matches.\n\nCODE:\n${numbered(lines, start)}\n\nRESULT:`
    },
  },

  // ── V9: 两步决策 — YES/NO 先行，再给范围（改进 V2 的反幻觉设计）──
  {
    name: "V9-DECISION-TWO-PASS",
    build: (q, lines, start) => {
      const last = start + lines.length - 1
      return `Q: Is code (lines ${start}-${last}) about "${q}"?\n\nAbout means same topic/concept. Different topic = not about.\n\nA: YES or NO (then range if YES)\n\nYES → START <line> END <line>\nNO → 0 0\n\nCODE:\n${numbered(lines, start)}\n\nA:`
    },
  },

  // ── V10: 话题匹配 — "topic" 替代 "about"，修复字面理解问题 ──
  {
    name: "V10-TOPIC-MATCH",
    build: (q, lines, start) => {
      return `TOPIC: "${q}"\n\nFind lines in this code matching this topic.\nMatching = defines, implements, describes, or references the concept.\nSynonyms count. Word overlap with different meaning does NOT count.\n\nOutput: START N END M (two numbers) or 0 0 if no match.\n\nCODE:\n${numbered(lines, start)}\n\nRESULT:`
    },
  },

  // ── V11: V10 + 反字面理解 — 明确说明 "where is X" = "code about X" ──
  {
    name: "V11-TOPIC-NOLITERAL",
    build: (q, lines, start) => {
      return `TOPIC: "${q}"\n\nFind code lines on this topic. Treat the query as a topic, NOT a literal question.\n"where is X" = find code about X. "how to Y" = find code that does Y.\n\nMatch = defines, implements, describes, or references the concept (synonyms count).\nNo match = different concept (word overlap alone is not enough).\n\nOutput: START N END M or 0 0\n\nCODE:\n${numbered(lines, start)}\n\nRESULT:`
    },
  },

  // ── V17: V10 + 查询归一化 — "where is X" → "X definition" ──
  {
    name: "V17-QUERY-NORM",
    build: (q, lines, start) => {
      // 轻量查询归一化：只处理 "where is X" → "X"
      const normalized = q.replace(/^where\s+is\s+/i, '')
      return `TOPIC: "${normalized}"\n\nFind lines in this code matching this topic.\nMatching = defines, implements, describes, or references the concept.\nSynonyms count. Word overlap with different meaning does NOT count.\n\nOutput: START N END M (two numbers) or 0 0 if no match.\n\nCODE:\n${numbered(lines, start)}\n\nRESULT:`
    },
  },
]

// ── 解析器（重写：修复所有已知 Bug）──────────────────
function parse(resp: string, startLine: number, endLine: number): { start: number; end: number } | null {
  let cleaned = resp.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim()
  if (!cleaned) return null

  // ── 0. 明确否定 ──
  // ⚠️ 注意：必须在 START/END 匹配之后，因为模型可能先输出有效范围再输出 0 0

  // ── 0a. 优先匹配 "START N END M" 或 "START N M END" 格式（V7/V9/V10 常见输出）──
  let startEndMatch = cleaned.match(/START\s+(\d+)\s+END\s+(\d+)/i)
  if (!startEndMatch) {
    startEndMatch = cleaned.match(/START\s+(\d+)\s+(\d+)\s*END/i)
  }
  if (startEndMatch) {
    const s = parseInt(startEndMatch[1], 10)
    const e = parseInt(startEndMatch[2], 10)
    if (s > 0 && e > 0 && s >= startLine && e <= endLine && s <= e) {
      return { start: s, end: e }
    }
  }

  // "NONE" 单独一行，或 "0 0" / "0,0" 格式
  if (/^\s*(NONE|0\s*[,\s]\s*0)\s*$/im.test(cleaned)) return null

  // ── 0b. V4 容错: 裸 "None" = 全部相关（V5 用 "0" 表示无相关，不在此处理）──
  const firstLine = cleaned.split(/\n/)[0].trim()
  if (/^\s*none\s*$/i.test(firstLine)) {
    return { start: startLine, end: endLine }
  }

  // ── 1. V4: ELIMINATION 模式（必须在 rangeMatch 之前处理！）──
  const elimMatch = cleaned.match(/eliminate\s*:?\s*(.+)/is)
  if (elimMatch) {
    const elimPart = elimMatch[1].split(/\n/)[0].trim()  // 只取第一行

    // "None" 或 "0" → 所有行都相关，不消除任何行
    if (/^(none|0)$/i.test(elimPart)) {
      return { start: startLine, end: endLine }
    }

    // 解析要消除的行号：支持 "912-934" 范围和 "38, 39, 40" 逗号分隔
    const eliminated = new Set<number>()
    // 先按逗号/空格分割 token
    const tokens = elimPart.split(/[\s,]+/).filter(Boolean)
    for (const tok of tokens) {
      const rangeM = tok.match(/^(\d+)\s*[-–]\s*(\d+)$/)
      if (rangeM) {
        const from = parseInt(rangeM[1], 10)
        const to = parseInt(rangeM[2], 10)
        for (let n = from; n <= to; n++) eliminated.add(n)
      } else {
        const n = parseInt(tok, 10)
        if (n > 0) eliminated.add(n)
      }
    }

    // 如果消除了 80%+ 的行 → 认为没有相关内容
    const totalLines = endLine - startLine + 1
    if (eliminated.size >= totalLines * 0.8) return null

    const kept: number[] = []
    for (let ln = startLine; ln <= endLine; ln++) {
      if (!eliminated.has(ln)) kept.push(ln)
    }
    if (kept.length === 0) return null
    return { start: Math.min(...kept), end: Math.max(...kept) }
  }

  // ── 2. V3: SCORE-PER-LINE 模式（必须在 generic pairs 之前处理）──
  // 检测 "LINENUM SCORE" 格式（score 为 0/1/2）
  const scoreLines = cleaned.match(/\b(\d+)\s+([012])\b/g)
  if (scoreLines && scoreLines.length >= 3) {
    const kept: number[] = []
    for (const sl of scoreLines) {
      const m = sl.match(/\b(\d+)\s+([012])\b/)
      if (!m) continue
      const lineNum = parseInt(m[1], 10)
      const score = parseInt(m[2], 10)
      if (score >= 1 && lineNum >= startLine && lineNum <= endLine) {
        kept.push(lineNum)
      }
    }
    // 只有当至少 30% 的代码行被打分且不全为 0 时才信任
    const coverageRatio = scoreLines.length / (endLine - startLine + 1)
    if (coverageRatio >= 0.3) {
      if (kept.length === 0) return null
      return { start: Math.min(...kept), end: Math.max(...kept) }
    }
    // 覆盖率不够，继续尝试其他解析方式
  }

  // ── 3. V5: 逗号分隔的数字列表（如 "2,3,4" 或 "179, 181, 183"）──
  // 扫描所有行（不仅首行），因为模型常在第一行解释、第二行列数字
  const allLines = cleaned.split(/\n/)
  for (const line of allLines) {
    const tl = line.trim()
    // 纯逗号/空格分隔的数字行
    if (/^[\d,\s]+$/.test(tl) && /\d/.test(tl)) {
      const nums = tl.split(/[\s,]+/).map(Number).filter(n => n > 0)
      if (nums.length >= 1 && nums[0] !== 0) {
        const validNums = nums.filter(n => n >= startLine && n <= endLine)
        if (validNums.length > 0) {
          return { start: Math.min(...validNums), end: Math.max(...validNums) }
        }
      }
      if (nums.length === 1 && nums[0] === 0) return null
    }
  }

  // 也检测 "2, 3, 4" 这种嵌入在文本中的（非纯数字行）
  // 优先检测 "lines N to M" 或 "lines N through M" 模式
  const linesToMatch = cleaned.match(/lines?\s+(\d+)\s+(?:to|through|[-–])\s+(\d+)/i)
  if (linesToMatch) {
    const s = parseInt(linesToMatch[1], 10)
    const e = parseInt(linesToMatch[2], 10)
    if (s >= startLine && e <= endLine && s <= e) {
      return { start: s, end: e }
    }
  }

  const csvNumsMatch = cleaned.match(/(\d+[\s,]*){2,}/)
  if (csvNumsMatch && !scoreLines) {
    const nums = csvNumsMatch[0].split(/[\s,]+/).map(Number).filter(n => n > 0)
    const validNums = nums.filter(n => n >= startLine && n <= endLine)
    if (validNums.length >= 2) {
      return { start: Math.min(...validNums), end: Math.max(...validNums) }
    }
  }

  // ── 4. 范围格式 "Lxxx-Lyyy" 或 "xxx-yyy" ──
  const rangeMatch = cleaned.match(/L?(\d+)\s*[-–]\s*L?(\d+)/)
  if (rangeMatch) {
    const s = parseInt(rangeMatch[1], 10)
    const e = parseInt(rangeMatch[2], 10)
    if (s === 0 || e === 0) return null
    if (s >= startLine && e <= endLine && s <= e) {
      return { start: s, end: e }
    }
  }

  // ── 5. 通用数字对 "X Y"（修复：不因 e=0 而 return null）──
  const pairs = cleaned.match(/\b(\d+)\s+(\d+)\b/g)
  if (pairs) {
    for (let i = pairs.length - 1; i >= 0; i--) {
      const m = pairs[i].match(/(\d+)\s+(\d+)/)
      if (!m) continue
      const s = parseInt(m[1], 10)
      const e = parseInt(m[2], 10)
      // 跳过无效对：0 值或顺序不对
      if (s === 0 || e === 0) continue
      if (s > e) continue
      if (s >= startLine && e <= endLine) {
        return { start: s, end: e }
      }
    }
  }

  // ── 6. V5 备用: "Relating to: X Y" 前缀 ──
  const relatingMatch = cleaned.match(/relating\s+to[^:]*:?\s*([\d,\s]+)/i)
  if (relatingMatch) {
    const nums = relatingMatch[1].split(/[\s,]+/).map(Number).filter(n => n > 0)
    if (nums.length === 0 || nums[0] === 0) return null
    const validNums = nums.filter(n => n >= startLine && n <= endLine)
    if (validNums.length > 0) {
      return { start: Math.min(...validNums), end: Math.max(...validNums) }
    }
    return null
  }

  // ── 7. YES/NO 检测（最后的 fallback）──
  const hasNo = /\bno\b/i.test(cleaned)
  const hasYes = /\byes\b/i.test(cleaned)
  if (hasYes && !hasNo) {
    // 找 YES 之后的有效行号
    const afterYes = cleaned.split(/\byes\b/i)[1] || cleaned
    const anyNum = afterYes.match(/\b(\d+)\b/g)
    if (anyNum) {
      const n = parseInt(anyNum[0], 10)
      if (n >= startLine && n <= endLine) {
        return { start: n, end: n }
      }
    }
  }
  if (hasNo && !hasYes) return null

  return null
}

// ── 运行测试 ──────────────────────────────────────────
async function run() {
  const modelPy = loadFile("model.py")
  const helloJs = loadFile("hello.js")
  const appJs = loadFile("app.js")
  const readme = loadFile("README.md")

  // 定义测试片段：(代码, 查询, 应该匹配?)
  const snippets: Array<{
    label: string
    code: { lines: string[]; startLine: number }
    queries: string[]
    shouldMatch: boolean
  }> = [
    // === 正例：train 方法 ===
    {
      label: "train-method-def",
      code: extractLines(modelPy, 736, 770),
      queries: ["where is the train method", "train method definition"],
      shouldMatch: true,
    },
    // === 正例：hello.js greet ===
    {
      label: "hello-greet",
      code: extractLines(helloJs, 1, 5),
      queries: ["how to greet a user", "greeting function"],
      shouldMatch: true,
    },
    // === 正例：is_triton ===
    {
      label: "is-triton",
      code: extractLines(modelPy, 178, 201),
      queries: ["check if model is triton", "triton server check"],
      shouldMatch: true,
    },
    // === 反例：device 属性（不相关） ===
    {
      label: "device-property",
      code: extractLines(modelPy, 912, 934),
      queries: ["where is the train method", "how to greet a user"],
      shouldMatch: false,
    },
    // === 反例：is_hub 方法（不相关） ===
    {
      label: "is-hub",
      code: extractLines(modelPy, 203, 223),
      queries: ["where is the train method", "how to greet a user"],
      shouldMatch: false,
    },
    // === 反例：README ===
    {
      label: "readme-search-examples",
      code: extractLines(readme, 38, 51),
      queries: ["where is the train method", "check if model is triton"],
      shouldMatch: false,
    },
    // === 反例：app.js ===
    {
      label: "app-js",
      code: extractLines(appJs, 1, Math.min(30, appJs.split("\n").length)),
      queries: ["where is the train method", "check if model is triton"],
      shouldMatch: false,
    },
    // === tricky 反例：_smart_load（含 "trainer" 关键字但不相关） ===
    {
      label: "smart-load-tricky",
      code: extractLines(modelPy, 1064, 1097),
      queries: ["where is the train method"],
      shouldMatch: false,
    },
    // === tricky 反例：task_map（含 "model,trainer" 关键字但不相关） ===
    {
      label: "task-map-tricky",
      code: extractLines(modelPy, 1100, 1128),
      queries: ["where is the train method"],
      shouldMatch: false,
    },
  ]

  console.log("╔══════════════════════════════════════════════════════════════╗")
  console.log("║        LLM Prompt 测试 — 代码高亮器 (v3)                      ║")
  console.log("╚══════════════════════════════════════════════════════════════╝")
  console.log(`Model: ${path.basename(MODEL)}`)
  console.log(`Variants: ${PROMPTS.length} | Snippets: ${snippets.length}`)

  // 支持环境变量 ONLY= 来单独跑某个变体
  const onlyVariant = process.env.ONLY || ""
  const variantsToRun = onlyVariant
    ? PROMPTS.filter(v => v.name.includes(onlyVariant))
    : PROMPTS
  if (onlyVariant) {
    console.log(`🔬 Filtered to variant: ${onlyVariant} (${variantsToRun.length} matched)`)
  }

  const llama = await getLlama({ logLevel: LlamaLogLevel.disabled })
  const model = await llama.loadModel({ modelPath: MODEL })

  // 汇总统计
  const stats = new Map<string, { tp: number; tn: number; fp: number; fn: number; total: number }>()

  for (const variant of variantsToRun) {
    // 每个 variant 创建独立的 context 以避免 sequence 池耗尽
    const ctx = await model.createContext({ contextSize: 8192, sequences: 30 })
    try {
      const st = { tp: 0, tn: 0, fp: 0, fn: 0, total: 0 }
      console.log(`\n\n┌${"─".repeat(76)}┐`)
      console.log(`│  ${variant.name.padEnd(72)}│`)
      console.log(`└${"─".repeat(76)}┘`)

      for (const snippet of snippets) {
        for (const query of snippet.queries) {
          st.total++
          const prompt = variant.build(query, snippet.code.lines, snippet.code.startLine)
          const seq = ctx.getSequence()
          try {
            const cw = new QwenChatWrapper({ variation: "3.5", thoughts: "discourage" })
            const session = new LlamaChatSession({ contextSequence: seq, chatWrapper: cw })
            const resp = await session.prompt(prompt, { maxTokens: 300, temperature: 0.0 })
            const chEnd = snippet.code.startLine + snippet.code.lines.length - 1
            const result = parse(resp, snippet.code.startLine, chEnd)
            const matched = result !== null

            // 判断正误
            let status: string
            if (snippet.shouldMatch && matched) { status = "TP ✅"; st.tp++ }
            else if (snippet.shouldMatch && !matched) { status = "FN ❌"; st.fn++ }
            else if (!snippet.shouldMatch && matched) { status = "FP ❌"; st.fp++ }
            else { status = "TN ✅"; st.tn++ }

            const rawShort = resp.replace(/\n/g, "\\n").substring(0, 500)
            const resultStr = result ? `L${result.start}-${result.end}` : "NONE"
            console.log(`  ${status.padEnd(8)} [${snippet.label.padEnd(22)}] "${query.substring(0, 40).padEnd(40)}" → ${resultStr.padEnd(12)} | ${rawShort}`)
          } finally {
            seq.dispose()
          }
        }
      }

      const accuracy = ((st.tp + st.tn) / st.total * 100).toFixed(0)
      const precision = st.tp + st.fp > 0 ? (st.tp / (st.tp + st.fp) * 100).toFixed(0) : "-"
      const recall = st.tp + st.fn > 0 ? (st.tp / (st.tp + st.fn) * 100).toFixed(0) : "-"
      console.log(`  ────────────────────────────────────────────────────────────`)
      console.log(`  Accuracy=${accuracy}%  Precision=${precision}%  Recall=${recall}%  TP=${st.tp} TN=${st.tn} FP=${st.fp} FN=${st.fn}`)
      stats.set(variant.name, st)
    } finally {
      // ctx will be GC'd
    }
  }

  // ── 最终排名 ──
  console.log(`\n\n┌${"─".repeat(76)}┐`)
  console.log(`│  FINAL RANKING                                              │`)
  console.log(`└${"─".repeat(76)}┘`)
  const ranked = [...stats.entries()]
    .map(([name, s]) => ({ name, accuracy: (s.tp + s.tn) / s.total, s }))
    .sort((a, b) => b.accuracy - a.accuracy)
  for (const r of ranked) {
    const acc = (r.accuracy * 100).toFixed(0)
    const pre = r.s.tp + r.s.fp > 0 ? (r.s.tp / (r.s.tp + r.s.fp) * 100).toFixed(0) : "-"
    const rec = r.s.tp + r.s.fn > 0 ? (r.s.tp / (r.s.tp + r.s.fn) * 100).toFixed(0) : "-"
    console.log(`  ${acc.padStart(3)}%  ${r.name.padEnd(30)} P=${pre.padStart(3)}% R=${rec.padStart(3)}%  TP=${r.s.tp} TN=${r.s.tn} FP=${r.s.fp} FN=${r.s.fn}`)
  }
}

run().catch(console.error)
