/**
 * Summarizer request interface
 */
export interface SummarizerRequest {
	/**
	 * Complete code content to summarize (NOT truncated)
	 */
	content: string

	/**
	 * Complete document content for context (optional)
	 * When provided, gives the model full file context to generate better summaries
	 */
	document?: string

	/**
	 * Output language for the summary
	 */
	language: 'English' | 'Chinese'

	/**
	 * Type of code (e.g., 'class', 'function', 'method')
	 */
	codeType: string

	/**
	 * Optional name of the code element (e.g., 'Model', '__init__')
	 */
	codeName?: string

	/**
	 * Optional file path for context (filename only)
	 */
	filePath?: string
}

/**
 * Summarizer result interface
 */
export interface SummarizerResult {
	/**
	 * Generated summary text
	 */
	summary: string

	/**
	 * Actual language used for the summary
	 */
	language: string
}

/**
 * Summarizer information interface
 */
export interface SummarizerInfo {
	/**
	 * Provider name (e.g., 'ollama')
	 */
	name: string

	/**
	 * Model ID
	 */
	model: string
}

/**
 * Summarizer configuration interface
 */
export interface SummarizerConfig {
	/**
	 * Provider type (v1 only supports 'ollama')
	 */
	provider: 'ollama'

	/**
	 * Ollama base URL (for ollama provider)
	 */
	ollamaBaseUrl?: string

	/**
	 * Ollama model ID (for ollama provider)
	 */
	ollamaModelId?: string

	/**
	 * Language for summaries
	 */
	language?: 'English' | 'Chinese'
}

/**
 * Summarizer interface
 * All summarizer implementations must implement this interface
 */
export interface ISummarizer {
	/**
	 * Generate a summary for the given code content
	 * @throws Error if summarization fails (caller should handle gracefully)
	 */
	summarize(request: SummarizerRequest): Promise<SummarizerResult>

	/**
	 * Validate the summarizer configuration
	 */
	validateConfiguration(): Promise<{ valid: boolean; error?: string }>

	/**
	 * Get summarizer information
	 */
	get summarizerInfo(): SummarizerInfo
}
