/**
 * 行级高亮结果中的单行信息
 */
export interface HighlightLine {
  /** 原始行号（从1开始） */
  lineNumber: number
  /** 该行的文本内容 */
  text: string
  /** keep 概率分数 (0-1)，由 Pruning Head 输出 */
  score: number
  /** 是否保留该行（基于 Top-K 选取） */
  kept: boolean
}

/**
 * 单个代码块的高亮结果
 */
export interface HighlightResult {
  /** 保留的代码行（按行号排序，连续行成组，组间用 `---` 分隔符） */
  formattedText: string
  /** 所有行的详细信息 */
  lines: HighlightLine[]
  /** 原始起始行号 */
  startLine: number
  /** 原始结束行号 */
  endLine: number
  /** [debug] 每个 token 的 attention 热力图可视化字符串 */
  debugTokenView?: string
}

/** Highlighter provider 类型 */
export type HighlighterProvider = "semantic-highlight" | "llamacpp-llm" | "qrranker"

/**
 * Highlighter 配置
 */
export interface HighlighterConfig {
  enabled: boolean
  /** Provider 类型：llamacpp（专用模型）| llamacpp-llm（LLM prompt） */
  provider?: HighlighterProvider
  /** 专用 semantic-highlight GGUF 模型路径（provider=llamacpp 时使用） */
  ggufPath?: string
  /** LLM GGUF 模型路径（provider=llamacpp-llm 时使用，0.6B 小模型） */
  ggufLlmPath?: string
  /** QRRanker GGUF 模型路径（provider=qrranker 时使用，Qwen3-4B attention-based） */
  ggufQrrankerPath?: string
  /**
   * 选取模式
   * - `"topk"`: 保留分值最高的 topK 行（默认）
   * - `"threshold"`: 保留所有 score >= threshold 的行
   */
  mode?: "topk" | "threshold"
  /** 保留的 Top-K 行数（mode=topk 时生效） */
  topK?: number
  /** 保留的最低分值阈值 (0-1)，mode=threshold 时生效 */
  threshold?: number
  /** LLM provider 的并发数（默认 2） */
  concurrency?: number
}

/**
 * highlight() 调用的运行时选项（可覆盖配置级设置）
 */
export interface HighlightOptions {
  /** 选取模式 */
  mode?: "topk" | "threshold"
  /** Top-K 行数 */
  topK?: number
  /** 最低分值阈值 */
  threshold?: number
  /** [debug] 启用 token 级热力图输出 */
  debugHighlight?: boolean
  /** [internal] 来自 reranker 的预计算 per-token 分数（供 qrranker provider 复用） */
  _qrrankerPerTokenScores?: Float32Array
  /** [internal] 预计算分数对应的代码原文 */
  _qrrankerCodeText?: string
  /** [internal] 来自 reranker 的 pre-detokenized token texts（供 debug 热力图使用） */
  _qrrankerTokenTexts?: string[]
  /** [internal] 来自 reranker 的 chunk 总分 */
  _qrrankerChunkScore?: number
  /** [internal] 来自 semantic-highlight reranker 的预计算 PruningHead keep probs */
  _semanticHighlightTokenProbs?: Float32Array
  /** [internal] 预计算分数对应的代码原文（用于 token→line 字符偏移映射） */
  _semanticHighlightCodeText?: string
  /** [internal] 来自 semantic-highlight reranker 的逐个 detokenize token 文本 */
  _semanticHighlightTokenTexts?: string[]
  /** [internal] 来自 semantic-highlight reranker 的完整 input 字符串 */
  _semanticHighlightInput?: string
  /** [internal] 来自 semantic-highlight reranker 的 chunk 总分 */
  _semanticHighlightChunkScore?: number
}

/**
 * 行级语义高亮器接口
 *
 * 职责：对单个代码块做行级相关性标注，保留相关行、剪掉噪音行
 */
export interface IHighlighter {
  /**
   * 对给定代码块做行级高亮
   * @param query 搜索查询
   * @param codeChunk 代码块文本
   * @param startLine 代码块的起始行号（从1开始）
   * @param options 运行时选项（可覆盖配置级 mode/threshold/topK）
   * @returns 高亮结果，包含保留行和格式化文本
   */
  highlight(query: string, codeChunk: string, startLine: number, options?: HighlightOptions): Promise<HighlightResult>

  /**
   * 验证 highlighter 配置
   */
  validateConfiguration(): Promise<{ valid: boolean; error?: string }>

  /** Highlighter 信息 */
  get highlighterInfo(): HighlighterInfo

  /**
   * 释放 highlighter 占用的 GPU/资源
   */
  dispose?(): Promise<void>
}

export interface HighlighterInfo {
  name: string
  model: string
}
