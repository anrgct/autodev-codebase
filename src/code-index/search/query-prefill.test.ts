import { applyQueryPrefill, QWEN_PREFILL_TEMPLATE } from "./query-prefill"

describe("applyQueryPrefill", () => {
	describe("qwen3-embedding models with ollama provider", () => {
		test("should apply prefill to qwen3-embedding:0.6b model", () => {
			const query = "test function"
			const result = applyQueryPrefill(query, "ollama", "qwen3-embedding:0.6b")
			
			expect(result).toBe(QWEN_PREFILL_TEMPLATE + query)
		})

		test("should apply prefill to qwen3-embedding:4b model", () => {
			const query = "async await pattern"
			const result = applyQueryPrefill(query, "ollama", "qwen3-embedding:4b")
			
			expect(result).toContain("Instruct: Given a codebase search query, retrieve relevant code snippets or document that answer the query.")
			expect(result).toContain("Query: async await pattern")
		})

		test("should apply prefill to qwen3-embedding:8b model", () => {
			const query = "database connection"
			const result = applyQueryPrefill(query, "ollama", "qwen3-embedding:8b")
			
			expect(result).toContain("Instruct:")
			expect(result).toContain("Query: database connection")
		})
	})

	describe("non-qwen models should not be affected", () => {
		test("should not apply prefill to nomic-embed-text model", () => {
			const query = "test function"
			const result = applyQueryPrefill(query, "ollama", "nomic-embed-text")
			
			expect(result).toBe(query)
		})

		test("should not apply prefill to mxbai-embed-large model", () => {
			const query = "typescript interface"
			const result = applyQueryPrefill(query, "ollama", "mxbai-embed-large")
			
			expect(result).toBe(query)
		})
	})

	describe("non-ollama providers should not be affected", () => {
		test("should not apply prefill for openai provider", () => {
			const query = "test function"
			const result = applyQueryPrefill(query, "openai", "text-embedding-3-small")
			
			expect(result).toBe(query)
		})

		test("should not apply prefill for gemini provider", () => {
			const query = "test function"
			const result = applyQueryPrefill(query, "gemini", "text-embedding-004")
			
			expect(result).toBe(query)
		})

		test("should not apply prefill for mistral provider", () => {
			const query = "test function"
			const result = applyQueryPrefill(query, "mistral", "codestral-embed-2505")
			
			expect(result).toBe(query)
		})

		test("should not apply prefill for openai-compatible provider", () => {
			const query = "test function"
			const result = applyQueryPrefill(query, "openai-compatible", "text-embedding-3-small")
			
			expect(result).toBe(query)
		})
	})

	describe("edge cases", () => {
		test("should not apply prefill when modelId is undefined", () => {
			const query = "test function"
			const result = applyQueryPrefill(query, "ollama", undefined)
			
			expect(result).toBe(query)
		})

		test("should not apply prefill when modelId is empty string", () => {
			const query = "test function"
			const result = applyQueryPrefill(query, "ollama", "")
			
			expect(result).toBe(query)
		})

		test("should not apply prefill to qwen model with wrong pattern", () => {
			const query = "test function"
			const result = applyQueryPrefill(query, "ollama", "qwen-embedding") // Missing '3' and ':'
			
			expect(result).toBe(query)
		})
	})

	describe("prevent duplicate prefill", () => {
		test("should not apply prefill when query already starts with the template", () => {
			const prefillQuery = QWEN_PREFILL_TEMPLATE + "existing query"
			const result = applyQueryPrefill(prefillQuery, "ollama", "qwen3-embedding:0.6b")
			
			expect(result).toBe(prefillQuery)
		})

		test("should apply prefill when query contains Instruct: and Query: but not at start", () => {
			const partialPrefillQuery = "user says: Instruct: Some instruction Query: some query"
			const result = applyQueryPrefill(partialPrefillQuery, "ollama", "qwen3-embedding:0.6b")
			
			expect(result).toBe(QWEN_PREFILL_TEMPLATE + partialPrefillQuery)
		})

		test("should apply prefill when query contains only Instruct: but not Query:", () => {
			const partialPrefillQuery = "Instruct: Some instruction"
			const result = applyQueryPrefill(partialPrefillQuery, "ollama", "qwen3-embedding:0.6b")
			
			expect(result).toBe(QWEN_PREFILL_TEMPLATE + partialPrefillQuery)
		})

		test("should apply prefill when query contains only Query: but not Instruct:", () => {
			const partialPrefillQuery = "Query: existing query"
			const result = applyQueryPrefill(partialPrefillQuery, "ollama", "qwen3-embedding:0.6b")
			
			expect(result).toBe(QWEN_PREFILL_TEMPLATE + partialPrefillQuery)
		})
	})

	describe("complex query examples", () => {
		test("should handle multi-line queries correctly", () => {
			const query = "find async functions\nwith error handling"
			const result = applyQueryPrefill(query, "ollama", "qwen3-embedding:4b")
			
			expect(result).toContain("Instruct: Given a codebase search query, retrieve relevant code snippets or document that answer the query.")
			expect(result).toContain("Query: find async functions\nwith error handling")
		})

		test("should handle queries with special characters", () => {
			const query = "React.useEffect() dependency array [state, props]"
			const result = applyQueryPrefill(query, "ollama", "qwen3-embedding:8b")
			
			expect(result).toContain("Instruct:")
			expect(result).toContain("Query: React.useEffect() dependency array [state, props]")
		})
	})
})