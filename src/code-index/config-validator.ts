import { CodeIndexConfig, EmbedderProvider } from "./interfaces/config"

/**
 * Configuration validation issue with structured error information
 */
export interface ValidationIssue {
  /**
   * Field path using dot notation (e.g., "embedderOpenAiApiKey", "rerankerOllamaBaseUrl")
   */
  path: string

  /**
   * Error code for programmatic handling
   * Examples: "required", "invalid_format", "missing_dependency"
   */
  code: string

  /**
   * Human-readable error message
   */
  message: string
}

/**
 * Result of configuration validation
 */
export interface ValidationResult {
  /**
   * Whether the configuration is valid (no issues)
   */
  valid: boolean

  /**
   * List of validation issues
   */
  issues: ValidationIssue[]
}

/**
 * Configuration validator that centralizes all validation logic
 */
export class ConfigValidator {
  /**
   * Validate a complete CodeIndexConfig
   * @param config The configuration to validate
   * @returns Validation result with issues if any
   */
  static validate(config: CodeIndexConfig): ValidationResult {
    const issues: ValidationIssue[] = []

    // Validate embedder configuration
    ConfigValidator.validateEmbedder(config, issues)

    // Validate Qdrant configuration
    ConfigValidator.validateQdrant(config, issues)

    // Validate reranker configuration
    ConfigValidator.validateReranker(config, issues)

    // Validate summarizer configuration (optional - only when --summarize flag is used)
    ConfigValidator.validateSummarizer(config, issues)

    // Validate basic configuration consistency
    ConfigValidator.validateBasicConsistency(config, issues)

    return {
      valid: issues.length === 0,
      issues
    }
  }

  /**
   * Validate embedder configuration based on provider
   */
  private static validateEmbedder(config: CodeIndexConfig, issues: ValidationIssue[]): void {
    const provider = config.embedderProvider

    switch (provider) {
      case 'openai':
        if (!config.embedderOpenAiApiKey) {
          issues.push({
            path: 'embedderOpenAiApiKey',
            code: 'required',
            message: 'OpenAI API key is required for OpenAI embedder'
          })
        }
        break

      case 'ollama':
        if (!config.embedderOllamaBaseUrl) {
          issues.push({
            path: 'embedderOllamaBaseUrl',
            code: 'required',
            message: 'Ollama base URL is required for Ollama embedder'
          })
        }
        break

      case 'openai-compatible':
        if (!config.embedderOpenAiCompatibleBaseUrl) {
          issues.push({
            path: 'embedderOpenAiCompatibleBaseUrl',
            code: 'required',
            message: 'Base URL is required for OpenAI Compatible embedder'
          })
        }
        if (!config.embedderOpenAiCompatibleApiKey) {
          issues.push({
            path: 'embedderOpenAiCompatibleApiKey',
            code: 'required',
            message: 'API key is required for OpenAI Compatible embedder'
          })
        }
        break

      case 'jina':
          if (!config.embedderJinaApiKey) {
            issues.push({
              path: 'embedderJinaApiKey',
              code: 'required',
              message: 'Jina API key is required for Jina embedder'
            })
          }
          break

      case 'gemini':
        if (!config.embedderGeminiApiKey) {
          issues.push({
            path: 'embedderGeminiApiKey',
            code: 'required',
            message: 'Gemini API key is required for Gemini embedder'
          })
        }
        break

      case 'mistral':
        if (!config.embedderMistralApiKey) {
          issues.push({
            path: 'embedderMistralApiKey',
            code: 'required',
            message: 'Mistral API key is required for Mistral embedder'
          })
        }
        break

      case 'vercel-ai-gateway':
        if (!config.embedderVercelAiGatewayApiKey) {
          issues.push({
            path: 'embedderVercelAiGatewayApiKey',
            code: 'required',
            message: 'Vercel AI Gateway API key is required for Vercel AI Gateway embedder'
          })
        }
        break

      case 'openrouter':
        if (!config.embedderOpenRouterApiKey) {
          issues.push({
            path: 'embedderOpenRouterApiKey',
            code: 'required',
            message: 'OpenRouter API key is required for OpenRouter embedder'
          })
        }
        break

      case 'llamacpp':
        if (!config.embedderGgufPath) {
          issues.push({
            path: 'embedderGgufPath',
            code: 'required',
            message: 'LlamaCPP model path is required for LlamaCPP embedder'
          })
        }
        break

      case 'llamacpp-llm':
        if (!config.embedderGgufLlmPath) {
          issues.push({
            path: 'embedderGgufLlmPath',
            code: 'required',
            message: 'LLM GGUF model path is required for llamacpp-llm embedder'
          })
        }
        break

      default:
        // Type safety: should never happen with TypeScript
        issues.push({
          path: 'embedderProvider',
          code: 'invalid_value',
          message: `Unknown embedder provider: ${provider}`
        })
    }
  }

  /**
   * Validate Qdrant vector store configuration
   */
  private static validateQdrant(config: CodeIndexConfig, issues: ValidationIssue[]): void {
    if (!config.qdrantUrl) {
      issues.push({
        path: 'qdrantUrl',
        code: 'required',
        message: 'Qdrant URL is required for vector storage'
      })
    }
  }

  /**
   * Validate reranker configuration
   */
  private static validateReranker(config: CodeIndexConfig, issues: ValidationIssue[]): void {
    if (config.rerankerEnabled) {
      if (!config.rerankerProvider) {
        issues.push({
          path: 'rerankerProvider',
          code: 'required',
          message: 'Reranker provider is required when reranker is enabled'
        })
        return
      }

      if (config.rerankerProvider === 'ollama') {
        if (!config.rerankerOllamaBaseUrl) {
          issues.push({
            path: 'rerankerOllamaBaseUrl',
            code: 'required',
            message: 'Ollama base URL is required for ollama reranker'
          })
        }
        if (!config.rerankerOllamaModelId) {
          issues.push({
            path: 'rerankerOllamaModelId',
            code: 'required',
            message: 'Ollama model ID is required for ollama reranker'
          })
        }
        return
      }

      if (config.rerankerProvider === 'openai-compatible') {
        if (!config.rerankerOpenAiCompatibleBaseUrl) {
          issues.push({
            path: 'rerankerOpenAiCompatibleBaseUrl',
            code: 'required',
            message: 'OpenAI-compatible base URL is required for openai-compatible reranker'
          })
        }
        if (!config.rerankerOpenAiCompatibleModelId) {
          issues.push({
            path: 'rerankerOpenAiCompatibleModelId',
            code: 'required',
            message: 'OpenAI-compatible model ID is required for openai-compatible reranker'
          })
        }
        // Note: API key may be optional for local servers
        return
      }

      if (config.rerankerProvider === 'llamacpp') {
        // ConfigValidator only checks provider validity for llamacpp reranker.
        // Model path validation is handled at creation time in service-factory.
        return
      }

      if (config.rerankerProvider === 'llamacpp-llm') {
        // ConfigValidator only checks provider validity for llamacpp-llm reranker.
        // Model path validation is handled at creation time in service-factory.
        return
      }

      if (config.rerankerProvider === 'qrranker') {
        // QR-based reranker using attention head scoring.
        // Model path validation is handled at creation time in service-factory.
        return
      }

      if (config.rerankerProvider === 'semantic-highlight') {
        // Semantic highlight reranker using embedding similarity.
        // Model path validation is handled at creation time in service-factory.
        return
      }

      // Unknown provider
      issues.push({
        path: 'rerankerProvider',
        code: 'invalid',
        message: `Unknown reranker provider: ${config.rerankerProvider}`
      })
    }
  }

  /**
   * Validate summarizer configuration
   * Note: This validation is optional and only performed when --summarize flag is actually used.
   * It doesn't block other operations if summarizer config is incomplete.
   */
  private static validateSummarizer(config: CodeIndexConfig, issues: ValidationIssue[]): void {
    // Only validate if summarizer provider is specified
    if (!config.summarizerProvider) {
      return
    }

    // Validate provider is supported
    if (config.summarizerProvider !== 'ollama' && config.summarizerProvider !== 'openai-compatible' && config.summarizerProvider !== 'llamacpp') {
      issues.push({
        path: 'summarizerProvider',
        code: 'invalid_value',
        message: `Unsupported summarizer provider: ${config.summarizerProvider}. Supported: 'ollama', 'openai-compatible', 'llamacpp'.`
      })
      return
    }

    // For ollama provider, validate required fields
    if (config.summarizerProvider === 'ollama') {
      if (!config.summarizerOllamaBaseUrl) {
        issues.push({
          path: 'summarizerOllamaBaseUrl',
          code: 'required',
          message: 'Ollama base URL is required for summarizer when provider is ollama'
        })
      }

      if (!config.summarizerOllamaModelId) {
        issues.push({
          path: 'summarizerOllamaModelId',
          code: 'required',
          message: 'Ollama model ID is required for summarizer when provider is ollama'
        })
      }
    }

    // For openai-compatible provider, validate required fields
    if (config.summarizerProvider === 'openai-compatible') {
      if (!config.summarizerOpenAiCompatibleBaseUrl) {
        issues.push({
          path: 'summarizerOpenAiCompatibleBaseUrl',
          code: 'required',
          message: 'OpenAI-compatible base URL is required for summarizer when provider is openai-compatible'
        })
      }

      if (!config.summarizerOpenAiCompatibleModelId) {
        issues.push({
          path: 'summarizerOpenAiCompatibleModelId',
          code: 'required',
          message: 'OpenAI-compatible model ID is required for summarizer when provider is openai-compatible'
        })
      }

      // Note: API key is optional for local servers (e.g., LM Studio)
    }

    // Validate language if specified
    if (config.summarizerLanguage) {
      if (config.summarizerLanguage !== 'English' && config.summarizerLanguage !== 'Chinese') {
        issues.push({
          path: 'summarizerLanguage',
          code: 'invalid_value',
          message: `Invalid language: ${config.summarizerLanguage}. Must be 'English' or 'Chinese'.`
        })
      }
    }
  }

  /**
   * Validate basic configuration consistency
   */
  private static validateBasicConsistency(config: CodeIndexConfig, issues: ValidationIssue[]): void {
    // Validate score ranges
    if (config.vectorSearchMinScore !== undefined && (config.vectorSearchMinScore < 0 || config.vectorSearchMinScore > 1)) {
      issues.push({
        path: 'vectorSearchMinScore',
        code: 'invalid_range',
        message: 'Search minimum score must be between 0 and 1'
      })
    }

    if (config.rerankerMinScore !== undefined && config.rerankerMinScore < 0) {
      issues.push({
        path: 'rerankerMinScore',
        code: 'invalid_range',
        message: 'Reranker minimum score must be non-negative'
      })
    }

    // Validate batch sizes
    if (config.rerankerBatchSize !== undefined && config.rerankerBatchSize <= 0) {
      issues.push({
        path: 'rerankerBatchSize',
        code: 'invalid_range',
        message: 'Reranker batch size must be positive'
      })
    }

    if (config.rerankerConcurrency !== undefined && config.rerankerConcurrency <= 0) {
      issues.push({
        path: 'rerankerConcurrency',
        code: 'invalid_range',
        message: 'Reranker concurrency must be positive'
      })
    }

    if (config.rerankerMaxRetries !== undefined && config.rerankerMaxRetries < 0) {
      issues.push({
        path: 'rerankerMaxRetries',
        code: 'invalid_range',
        message: 'Reranker max retries must be non-negative'
      })
    }

    if (config.rerankerRetryDelayMs !== undefined && config.rerankerRetryDelayMs < 0) {
      issues.push({
        path: 'rerankerRetryDelayMs',
        code: 'invalid_range',
        message: 'Reranker retry delay must be non-negative'
      })
    }

    if (config.vectorSearchMaxResults !== undefined && config.vectorSearchMaxResults <= 0) {
      issues.push({
        path: 'vectorSearchMaxResults',
        code: 'invalid_range',
        message: 'Search maximum results must be positive'
      })
    }

    if (config.embedderConcurrency !== undefined && config.embedderConcurrency <= 0) {
      issues.push({
        path: 'embedderConcurrency',
        code: 'invalid_range',
        message: 'Embedder concurrency must be positive'
      })
    }

    // Validate embedderPoolingLayer type
    if (config.embedderPoolingLayer !== undefined &&
        config.embedderPoolingLayer !== "last" &&
        typeof config.embedderPoolingLayer !== "number" &&
        typeof config.embedderPoolingLayer !== "string") {
      issues.push({
        path: 'embedderPoolingLayer',
        code: 'invalid_value',
        message: `Invalid pooling layer: ${config.embedderPoolingLayer}. Must be "last", a number (positive/negative), or a fraction string like "2/3".`
      })
    } else if (typeof config.embedderPoolingLayer === "string" && config.embedderPoolingLayer !== "last") {
      // Fraction format: "2/3", "3/4", etc.
      if (!/^\d+\/\d+$/.test(config.embedderPoolingLayer)) {
        issues.push({
          path: 'embedderPoolingLayer',
          code: 'invalid_value',
          message: `Invalid pooling layer string: "${config.embedderPoolingLayer}". Use fraction format like "2/3" or "last".`
        })
      }
    }

    // Validate embedderQueryPoolingLayer type (same rules as embedderPoolingLayer)
    if (config.embedderQueryPoolingLayer !== undefined &&
        config.embedderQueryPoolingLayer !== "last" &&
        typeof config.embedderQueryPoolingLayer !== "number" &&
        typeof config.embedderQueryPoolingLayer !== "string") {
      issues.push({
        path: 'embedderQueryPoolingLayer',
        code: 'invalid_value',
        message: `Invalid query pooling layer: ${config.embedderQueryPoolingLayer}. Must be "last", a number, or a fraction string like "2/3".`
      })
    } else if (typeof config.embedderQueryPoolingLayer === "string" && config.embedderQueryPoolingLayer !== "last") {
      if (!/^\d+\/\d+$/.test(config.embedderQueryPoolingLayer)) {
        issues.push({
          path: 'embedderQueryPoolingLayer',
          code: 'invalid_value',
          message: `Invalid query pooling layer string: "${config.embedderQueryPoolingLayer}". Use fraction format like "2/3" or "last".`
        })
      }
    }

    // Validate embedderPoolingMode enum
    if (config.embedderPoolingMode !== undefined &&
        config.embedderPoolingMode !== "late-chunking" &&
        config.embedderPoolingMode !== "last-token" &&
        config.embedderPoolingMode !== "mean" &&
        config.embedderPoolingMode !== "qr-weighted") {
      issues.push({
        path: 'embedderPoolingMode',
        code: 'invalid_value',
        message: `Invalid pooling mode: ${config.embedderPoolingMode}. Must be "late-chunking", "last-token", "mean", or "qr-weighted".`
      })
    }

    // Validate embedderLlmInstructionPrefix type
    if (config.embedderLlmInstructionPrefix !== undefined &&
        typeof config.embedderLlmInstructionPrefix !== "boolean") {
      issues.push({
        path: 'embedderLlmInstructionPrefix',
        code: 'invalid_type',
        message: `embedderLlmInstructionPrefix must be a boolean, got: ${typeof config.embedderLlmInstructionPrefix}`
      })
    }

    // Validate embedderUseChatTemplate type
    if (config.embedderUseChatTemplate !== undefined &&
        typeof config.embedderUseChatTemplate !== "boolean") {
      issues.push({
        path: 'embedderUseChatTemplate',
        code: 'invalid_type',
        message: `embedderUseChatTemplate must be a boolean, got: ${typeof config.embedderUseChatTemplate}`
      })
    }

    // Validate embedder batch sizes
    if (config.embedderOllamaBatchSize !== undefined && config.embedderOllamaBatchSize <= 0) {
      issues.push({
        path: 'embedderOllamaBatchSize',
        code: 'invalid_range',
        message: 'Embedder Ollama batch size must be positive'
      })
    }

    if (config.embedderOpenAiBatchSize !== undefined && config.embedderOpenAiBatchSize <= 0) {
      issues.push({
        path: 'embedderOpenAiBatchSize',
        code: 'invalid_range',
        message: 'Embedder OpenAI batch size must be positive'
      })
    }

    if (config.embedderOpenAiCompatibleBatchSize !== undefined && config.embedderOpenAiCompatibleBatchSize <= 0) {
      issues.push({
        path: 'embedderOpenAiCompatibleBatchSize',
        code: 'invalid_range',
        message: 'Embedder OpenAI Compatible batch size must be positive'
      })
    }

    if (config.embedderGeminiBatchSize !== undefined && config.embedderGeminiBatchSize <= 0) {
      issues.push({
        path: 'embedderGeminiBatchSize',
        code: 'invalid_range',
        message: 'Embedder Gemini batch size must be positive'
      })
    }

    if (config.embedderMistralBatchSize !== undefined && config.embedderMistralBatchSize <= 0) {
      issues.push({
        path: 'embedderMistralBatchSize',
        code: 'invalid_range',
        message: 'Embedder Mistral batch size must be positive'
      })
    }

    if (config.embedderOpenRouterBatchSize !== undefined && config.embedderOpenRouterBatchSize <= 0) {
      issues.push({
        path: 'embedderOpenRouterBatchSize',
        code: 'invalid_range',
        message: 'Embedder OpenRouter batch size must be positive'
      })
    }

    if (config.embedderJinaBatchSize !== undefined && config.embedderJinaBatchSize <= 0) {
      issues.push({
        path: 'embedderJinaBatchSize',
        code: 'invalid_range',
        message: 'Embedder Jina batch size must be positive'
      })
    }
  }
}
