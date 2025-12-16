/*
TODO: The following structures can be parsed by tree-sitter but lack query support:

1. Anonymous Functions (func_literal):
   (func_literal parameters: (parameter_list) body: (block ...))
   - Currently visible in goroutine and defer statements
   - Would enable capturing lambda/closure definitions

2. Map Types (map_type):
   (map_type key: (type_identifier) value: (interface_type))
   - Currently visible in struct field declarations
   - Would enable capturing map type definitions

3. Pointer Types (pointer_type):
   (pointer_type (type_identifier))
   - Currently visible in method receiver declarations
   - Would enable capturing pointer type definitions
*/

/// <reference types="../../types/vitest" />
import sampleGoContent from "./fixtures/sample-go"
import { testParseSourceCodeDefinitions } from "./helpers"
import goQuery from "../queries/go"

describe("Go Source Code Definition Tests", () => {
	let parseResult: string

	beforeAll(async () => {
		const testOptions = {
			language: "go",
			wasmFile: "tree-sitter-go.wasm",
			queryString: goQuery,
			extKey: "go",
		}

		const result = await testParseSourceCodeDefinitions("file.go", sampleGoContent, testOptions)
		expect(result).toBeDefined()
		parseResult = result as string
	})

	it("should capture key Go declarations", () => {
		expect(parseResult).toContain("# file.go")
		expect(parseResult).toMatch(/\d+--\d+ \|\s*package main/)
		expect(parseResult).toMatch(/\d+--\d+ \|\s*import \(/)
		expect(parseResult).toMatch(/\d+--\d+ \|\s*type TestInterfaceDefinition interface/)
		expect(parseResult).toMatch(/\d+--\d+ \|\s*func TestFunctionDefinition\(/)
	})

	it("should not have duplicate line ranges", () => {
		const lineRanges = parseResult.match(/\d+--\d+ \|/g) ?? []
		expect(lineRanges.length).toBeGreaterThan(1)
		expect(new Set(lineRanges).size).toBe(lineRanges.length)
	})
})
