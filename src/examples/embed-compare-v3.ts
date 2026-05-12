#!/usr/bin/env npx tsx
/**
 * embed-compare-v3.ts - 诊断 GGUF 修复后仍然 Recall@1 < 100% 的原因
 *
 * 关键假设: MLX 路径索引和查询都用 retrieval.query（对称），
 *          GGUF 路径索引用 "Document: "、查询用 "Query: "（不对称）。
 *          不对称性是 Jina 设计意图，但可能与对称 MLX 产生差异。
 *
 * 用法:
 *   npx tsx src/examples/embed-compare-v3.ts
 */

function dot(a: number[], b: number[]): number { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[i]; return sum }
function norm(a: number[]): number { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * a[i]; return Math.sqrt(sum) }
function cosineSim(a: number[], b: number[]): number { return dot(a, b) / (norm(a) * norm(b)) }

const MLX_SERVER_URL = "http://localhost:8089/v1"
const GGUF_MODEL_PATH = "/Users/anrgct/llm_models/jinaai/jina-embeddings-v5-text-nano-retrieval-GGUF/v5-nano-retrieval-F16.gguf"

async function mlxEmbed(texts: string[], task?: string, promptName?: string): Promise<number[][]> {
  const { fetch } = await import("undici")
  const payload: any = { model: "jina-embeddings-v5-nano", input: texts }
  if (task) payload.task = task
  if (promptName) payload.prompt_name = promptName
  const resp = await fetch(`${MLX_SERVER_URL}/embeddings`, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer test" },
    body: JSON.stringify(payload),
  })
  const json = await resp.json() as any
  return json.data.map((d: any) => d.embedding)
}

async function ggufEmbed(texts: string[]): Promise<number[][]> {
  const { getLlama, LlamaLogLevel } = await import("node-llama-cpp")
  const llama = await getLlama({ logLevel: LlamaLogLevel.error })
  const model = await llama.loadModel({ modelPath: GGUF_MODEL_PATH })
  const ctx = await model.createEmbeddingContext()
  const embeddings: number[][] = []
  for (const text of texts) {
    const emb = await ctx.getEmbeddingFor(text)
    embeddings.push(Array.from(emb.vector))
  }
  return embeddings
}

function l2Normalize(v: number[]): number[] { const n = norm(v); return v.map(x => x / n) }

// ============================================================
// 模拟 12 个测试用例的 query 和 doc text
// ============================================================

const QUERIES = [
  "模型初始化时如何处理不同的模型来源",
  "如何判断一个模型字符串指向远程推理服务",
  "进行模型推理时，流式输出和命令行输出走的不同路径",
  "训练完成后更新模型权重",
  "模型导出成不同格式时支持哪些配置选项",
  "超参数调优的两种模式",
  "持久化模型文件时都保存了哪些额外信息",
  "加载 checkpoint 时保留哪些参数",
  "如何为模型注册自定义事件处理函数",
  "提取特征向量时默认使用哪一层的输出",
  "目标跟踪和普通预测推理在实现上有哪些不同",
  "不同类型任务对应的模块是怎么自动匹配的",
]

// 简化的 doc texts（模拟 generateBlockEmbeddingText 输出）
const DOCS = [
  // #1
  `File: model.py\nName: [function_definition]__init__\nParent: [class_definition]Model\n\ndef __init__(self, model="yolo11n.pt", task=None, verbose=False):\n    self.model = model\n    self._check_is_hub_model(model)`,
  // #2
  `File: model.py\nName: [function_definition]is_triton_model\nParent: [class_definition]Model\n\n@staticmethod\ndef is_triton_model(model: str) -> bool:\n    return model.startswith("http")`,
  // #3
  `File: model.py\nName: [function_definition]predict_cli\nParent: [class_definition]Model\n\ndef predict_cli(self, source=None, **kwargs):\n    return self.predict(source, stream=True)`,
  // #4
  `File: model.py\nName: [function_definition]train\nParent: [class_definition]Model\n\ndef train(self, **kwargs):\n    self.model = attempt_load_one_weight(best_pt)`,
  // #5
  `File: model.py\nName: [function_definition]export\nParent: [class_definition]Model\n\ndef export(self, format="torchscript", half=False, int8=False, **kwargs):`,
  // #6
  `File: model.py\nName: [function_definition]tune\nParent: [class_definition]Model\n\ndef tune(self, use_ray=False, **kwargs):\n    if use_ray: run_ray_tune()`,
  // #7
  `File: model.py\nName: [function_definition]save\nParent: [class_definition]Model\n\ndef save(self, filename="model.pt"):\n    info={"license":"AGPL-3.0 License"}`,
  // #8
  `File: model.py\nName: [function_definition]_reset_ckpt_args\nParent: [class_definition]Model\n\n@staticmethod\ndef _reset_ckpt_args(args: dict) -> dict:\n    include={"imgsz","data","task"}`,
  // #9
  `File: model.py\nName: [function_definition]add_callback\nParent: [class_definition]Model\n\ndef add_callback(self, event, callback):\n    self.callbacks[event].append(callback)`,
  // #10
  `File: model.py\nName: [function_definition]embed\nParent: [class_definition]Model\n\ndef embed(self, img, layers=None):\n    return self.model.model[-2].output`,
  // #11
  `File: model.py\nName: [function_definition]track\nParent: [class_definition]Model\n\ndef track(self, source, persist=False, tracker="botsort.yaml"):\n    self.register_tracker(tracker)`,
  // #12
  `File: model.py\nName: [function_definition]_smart_load\nParent: [class_definition]Model\n\ndef _smart_load(self, key):\n    return task_map[task][key]`,
]

async function main() {
  console.log()
  console.log("═".repeat(100))
  console.log("  对称 vs 不对称 prompt 对召回率的影响")
  console.log("═".repeat(100))

  // ── 4 种嵌入策略 ──
  console.log("\n  [1/5] 获取 4 种策略的嵌入...")

  // 策略 A: MLX - 对称 retrieval.query（当前 MLX 行为）
  const mlxQA = await mlxEmbed(QUERIES, "retrieval", "query")
  const mlxDA = await mlxEmbed(DOCS, "retrieval", "query")

  // 策略 B: MLX - 不对称 retrieval.query / retrieval.passage（正确 Jina 用法）
  const mlxQB = await mlxEmbed(QUERIES, "retrieval", "query")
  const mlxDB = await mlxEmbed(DOCS, "retrieval", "passage")

  // 策略 C: GGUF - 不对称 Query:/Document:（当前 GGUF 行为）
  const ggufQC = await ggufEmbed(QUERIES.map(q => "Query: " + q))
  const ggufDC = await ggufEmbed(DOCS.map(d => "Document: " + d))

  // 策略 D: GGUF - 对称 Query:/Query:（模拟 MLX 对称行为）
  const ggufQD = await ggufEmbed(QUERIES.map(q => "Query: " + q))
  const ggufDD = await ggufEmbed(DOCS.map(d => "Query: " + d))

  console.log("        ✓ 完成")

  // ── 计算 Recall@1 ──
  console.log("\n  [2/5] 计算各策略的 query-doc 相似度矩阵...")

  interface StratResult {
    name: string
    recall1: number
    mrr: number
    avgDiag: number
    avgOffDiag: number
    details: string[]
  }

  function evalStrategy(name: string, qVecs: number[][], dVecs: number[][]): StratResult {
    const N = qVecs.length
    let recall1Hits = 0
    let mrrSum = 0
    let diagSum = 0
    let offDiagCount = 0
    let offDiagSum = 0
    const details: string[] = []

    for (let i = 0; i < N; i++) {
      // 计算 query i 对所有 doc 的相似度
      const sims = dVecs.map((d, j) => ({ j, sim: cosineSim(qVecs[i], d) }))
      sims.sort((a, b) => b.sim - a.sim)

      const rank = sims.findIndex(s => s.j === i) + 1
      if (rank === 1) recall1Hits++
      mrrSum += 1 / rank
      diagSum += cosineSim(qVecs[i], dVecs[i])

      // off-diagonal
      for (const s of sims) {
        if (s.j !== i) { offDiagSum += s.sim; offDiagCount++ }
      }

      if (rank > 1) {
        const top3 = sims.slice(0, 3).map(s => `doc#${s.j+1}=${s.sim.toFixed(3)}`).join(", ")
        details.push(`  Q#${i+1} → rank#${rank}  top3=[${top3}]  (diag=${cosineSim(qVecs[i], dVecs[i]).toFixed(3)})`)
      }
    }

    return {
      name,
      recall1: (recall1Hits / N * 100),
      mrr: mrrSum / N,
      avgDiag: diagSum / N,
      avgOffDiag: offDiagSum / offDiagCount,
      details,
    }
  }

  const results = [
    evalStrategy("A: MLX  对称 (Q:query, D:query)     [当前MLX]", mlxQA, mlxDA),
    evalStrategy("B: MLX  不对称(Q:query, D:passage)  [Jina正确用法]", mlxQB, mlxDB),
    evalStrategy("C: GGUF 不对称(Q:Query:, D:Document:) [当前GGUF]", ggufQC, ggufDC),
    evalStrategy("D: GGUF 对称  (Q:Query:, D:Query:)    [模拟MLX]", ggufQD, ggufDD),
  ]

  // ── 输出结果 ──
  console.log()
  console.log(`  ${"策略".padEnd(52)} ${"Recall@1".padStart(10)} ${"MRR".padStart(8)} ${"AvgDiag".padStart(10)} ${"AvgOffDiag".padStart(12)}`)
  console.log("  " + "─".repeat(92))
  for (const r of results) {
    console.log(`  ${r.name.padEnd(52)} ${r.recall1.toFixed(1).padStart(8)}% ${r.mrr.toFixed(4).padStart(8)} ${r.avgDiag.toFixed(4).padStart(10)} ${r.avgOffDiag.toFixed(4).padStart(12)}`)
  }
  console.log("  " + "─".repeat(92))

  // ── 非 #1 的详情 ──
  for (const r of results) {
    if (r.details.length > 0) {
      console.log(`\n  ${r.name} 非#1 案例:`)
      for (const d of r.details) console.log(d)
    }
  }

  // ── 额外验证: L2 归一化对结果的影响 ──
  console.log("\n  [3/5] L2 归一化影响...")
  const ggufQCNorm = ggufQC.map(v => l2Normalize(v))
  const ggufDCNorm = ggufDC.map(v => l2Normalize(v))
  const rNorm = evalStrategy("C': GGUF 不对称 + L2归一化", ggufQCNorm, ggufDCNorm)
  console.log(`  ${"策略".padEnd(52)} ${"Recall@1".padStart(10)} ${"MRR".padStart(8)} ${"AvgDiag".padStart(10)} ${"AvgOffDiag".padStart(12)}`)
  console.log("  " + "─".repeat(92))
  console.log(`  ${rNorm.name.padEnd(52)} ${rNorm.recall1.toFixed(1).padStart(8)}% ${rNorm.mrr.toFixed(4).padStart(8)} ${rNorm.avgDiag.toFixed(4).padStart(10)} ${rNorm.avgOffDiag.toFixed(4).padStart(12)}`)

  // ── 检查 MLX 对称 vs GGUF 对称是否一致 ──
  console.log("\n  [4/5] 跨模型一致性检查 (MLX 对称 vs GGUF 对称)...")
  for (let i = 0; i < QUERIES.length; i++) {
    const qCross = cosineSim(mlxQA[i], ggufQD[i])
    const dCross = cosineSim(mlxDA[i], ggufDD[i])
    if (qCross < 0.99 || dCross < 0.99) {
      console.log(`  ⚠ Q#${i+1} cross=${qCross.toFixed(4)}  D#${i+1} cross=${dCross.toFixed(4)}`)
    }
  }
  console.log("  (无输出即所有 cross > 0.99，跨模型一致)")

  console.log()
}

main().catch(err => { console.error(err); process.exit(1) })
