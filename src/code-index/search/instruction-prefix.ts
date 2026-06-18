import { EmbedderProvider, IEmbedder } from "../interfaces"
import { getGlobalLogger } from "../../utils/logger"

// ============================================================================
// 模板常量
// ============================================================================

/** Qwen3 embedding 模型专用预填充模板（ollama provider） */
export const QWEN_PREFILL_TEMPLATE =
  "Instruct: Given a search query, retrieve relevant passages that answer the query.\nQuery: "

/** 通用 LLM embedder 指令前缀模板（llamacpp-llm provider，非 jina 模型） */
export const LLM_EMBEDDER_PREFILL_TEMPLATE =
  "Instruct: Given a search query, retrieve relevant passages that answer the query.\nQuery: "

/** jina-embeddings-v5 检索模型前缀 */
export const JINA_QUERY_PREFIX = "Query: "

/** F2LLM-v2 模型专用指令前缀模板（小模型，简短指令） */
export const F2LLM_PREFILL_TEMPLATE = "Instruct: find relevant passages\nQuery: "

/**
 * LLM2Vec-Gen-Qwen3 检索前缀模板（对齐原版 demo_quickstart.py 的 demo_retrieval）。
 *
 * 原版（llm2vec-gen/scripts/demo_quickstart.py:172-204）是非对称指令：
 *   q_instruction = "Generate a passage that best answers this question: "
 *   d_instruction = "Summarize the following passage: "
 *   q_reps = model.encode([q_instruction + q ...])
 *   d_reps = model.encode([d_instruction + d ...])
 * 注意两点：
 *   1) query/document 指令措辞不同（生成式口吻），且**都没有 "Query:"/"Document:" label**——
 *      那是 demo_llamacpp.py 第二版的写法，不是原版。
 *   2) instruction 在 encode 内部拼接在文本前面，后面没有换行/分隔符，直接跟原文。
 */
export const LLM2VEC_QUERY_PREFIX = "Generate a passage that best answers this question: "
export const LLM2VEC_DOCUMENT_PREFIX = "Summarize the following passage: "

/**
 * MiniCPM ChatML 聊天模板格式。
 * 将文本包装为完整 instruct 对话格式，利用模型的 instruct-tuned 语义空间。
 * 适用于 llamacpp-llm embedder，由 embedderUseChatTemplate 配置控制。
 *
 * 模板：<|im_start|>user\n{text}<|im_end|>\n<|im_start|>assistant\n
 */
export function wrapInChatTemplate(text: string): string {
  return `<|im_start|>user\n${text}<|im_end|>\n<|im_start|>assistant\n`
}

// ============================================================================
// 内部工具
// ============================================================================

/** 检查模型 ID 是否包含 jina-embeddings-v5 */
function _isJinaV5Model(modelId: string): boolean {
  return modelId.includes("jina-embeddings-v5")
}

/** 检查模型 ID 是否为 F2LLM 系列模型 */
function _isF2LLMModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("f2llm")
}

/** 获取 logger 实例（惰性） */
function _logger() {
  return getGlobalLogger()
}

// ============================================================================
// Query 端前缀解析
// ============================================================================

/**
 * 统一解析 query 端的前缀/预填充。
 * 覆盖所有 provider，一次调用返回完整处理后的 query。
 *
 * @param query          原始搜索查询
 * @param provider       embedder provider 名称
 * @param modelId        模型 ID（可选，用于 jina/qwen3 模型匹配）
 * @param enableLlmPrefix llamacpp-llm 指令前缀开关（仅对 llamacpp-llm 生效）
 * @returns 处理后的查询字符串
 */
export function resolveQueryPrefix(
  query: string,
  provider: EmbedderProvider,
  modelId?: string,
  enableLlmPrefix?: boolean,
): string {
  const log = _logger()

  // ── 1. llamacpp（专用 embedding 模型） ──────────────
  if (provider === "llamacpp") {
    if (modelId && _isJinaV5Model(modelId)) {
      if (query.startsWith(JINA_QUERY_PREFIX)) return query
      const result = JINA_QUERY_PREFIX + query
      log.debug(`[Prefix] resolveQueryPrefix(llamacpp, jina): "${result.slice(0, 120)}..."`)
      return result
    }
    return query
  }

  // ── 1b. llm2vec（LLM2Vec-Gen，非对称前缀，始终应用） ──
  // 模型按指令训练，查询端必须以 "…Query: " 结尾（demo_llamacpp.py INSTRUCT_QUERY）。
  // 与 enableLlmPrefix 无关：该开关只控 llamacpp-llm。
  if (provider === "llm2vec") {
    if (query.startsWith(LLM2VEC_QUERY_PREFIX)) return query
    const result = LLM2VEC_QUERY_PREFIX + query
    log.debug(`[Prefix] resolveQueryPrefix(llm2vec): "${result.slice(0, 120)}..."`)
    return result
  }

  // ── 2. llamacpp-llm（通用 LLM embedder） ───────────
  if (provider === "llamacpp-llm") {
    if (!enableLlmPrefix) {
      log.debug(`[Prefix] resolveQueryPrefix(llamacpp-llm): skipped (enableLlmPrefix=false)`)
      return query
    }

    // jina 模型：加简洁 "Query: " 前缀
    if (modelId && _isJinaV5Model(modelId)) {
      if (query.startsWith(JINA_QUERY_PREFIX)) return query
      const result = JINA_QUERY_PREFIX + query
      log.debug(`[Prefix] resolveQueryPrefix(llamacpp-llm, jina): "${result.slice(0, 120)}..."`)
      return result
    }

    // F2LLM 模型：使用自定义简短指令
    if (modelId && _isF2LLMModel(modelId)) {
      if (query.startsWith(F2LLM_PREFILL_TEMPLATE)) return query
      const result = F2LLM_PREFILL_TEMPLATE + query
      log.debug(`[Prefix] resolveQueryPrefix(llamacpp-llm, f2llm): "${result.slice(0, 120)}..."`)
      return result
    }

    // 非 jina 模型：加完整指令模板
    if (query.startsWith(LLM_EMBEDDER_PREFILL_TEMPLATE)) return query
    const result = LLM_EMBEDDER_PREFILL_TEMPLATE + query
    log.debug(`[Prefix] resolveQueryPrefix(llamacpp-llm, instruction): "${result.slice(0, 120)}..."`)
    return result
  }

  // ── 3. ollama + qwen3-embedding ─────────────────────
  if (provider === "ollama" && modelId) {
    const qwenRegex = /^qwen3-embedding:/
    if (qwenRegex.test(modelId)) {
      if (query.startsWith(QWEN_PREFILL_TEMPLATE)) return query
      const result = QWEN_PREFILL_TEMPLATE + query
      log.debug(`[Prefix] resolveQueryPrefix(ollama, qwen3): "${result.slice(0, 120)}..."`)
      return result
    }
  }

  // ── 4. 其他 provider：无前缀 ────────────────────────
  log.debug(`[Prefix] resolveQueryPrefix(${provider}): no prefix (modelId=${modelId ?? "undefined"})`)
  return query
}

// ============================================================================
// Document 端前缀解析
// ============================================================================

/**
 * 解析索引（document）端的前缀。
 * 从 IEmbedder 实例中提取 provider/modelId 信息，返回对应前缀。
 *
 * @param embedder embedder 实例
 * @returns 前缀字符串，不需要时返回 undefined
 */
export function resolveDocumentPrefix(embedder: IEmbedder): string | undefined {
  const log = _logger()
  const provider = embedder.embedderInfo.name

  // llm2vec：非对称 Document 前缀（与 demo_llamacpp.py INSTRUCT_DOC 一致）。
  // 始终返回 "…Document: "，不受 enableLlmPrefix 控制（模型按指令训练）。
  if (provider === "llm2vec") {
    log.debug(`[Prefix] resolveDocumentPrefix(llm2vec): "…Document: "`)
    return LLM2VEC_DOCUMENT_PREFIX
  }

  // document 端前缀仅对 llamacpp / llamacpp-llm 的 jina 模型有意义
  if (provider !== "llamacpp" && provider !== "llamacpp-llm") {
    return undefined
  }

  // llamacpp-llm：由 enableLlmPrefix 开关控制
  if (provider === "llamacpp-llm") {
    if (!embedder.enableLlmPrefix) {
      log.debug(`[Prefix] resolveDocumentPrefix(llamacpp-llm): disabled by enableLlmPrefix`)
      return undefined
    }
  }

  // 通过 (as any) 提取 modelId（各 embedder 实现字段名不一致）
  const anyEmbedder = embedder as any
  const modelId: string | undefined =
    anyEmbedder.modelPath // LlamaCppEmbedder / LlamaCppLlmEmbedder
    || anyEmbedder.defaultModelId
    || anyEmbedder.modelId

  if (!modelId) return undefined

  // 直接匹配
  if (_isJinaV5Model(modelId)) {
    log.debug(`[Prefix] resolveDocumentPrefix(${provider}): "Query: " (jina model)`)
    return JINA_QUERY_PREFIX
  }

  // GGUF 文件路径提取文件名后再匹配
  const modelFileName = modelId.split("/").pop()?.split(".")[0] || modelId
  if (_isJinaV5Model(modelFileName)) {
    log.debug(`[Prefix] resolveDocumentPrefix(${provider}): "Query: " (jina model, from path)`)
    return JINA_QUERY_PREFIX
  }

  log.debug(`[Prefix] resolveDocumentPrefix(${provider}): no prefix needed (${modelFileName})`)
  return undefined
}
