import { readFile } from "fs/promises"
import { createHash } from "crypto"
import * as path from "path"
import * as treeSitter from "web-tree-sitter"
import { LanguageParser, loadRequiredLanguageParsers } from "../../tree-sitter/languageParser"
import { parseMarkdown } from "../../tree-sitter/markdownParser"
import { ICodeParser, CodeBlock, ParentContainer } from "../interfaces"
import { scannerExtensions, shouldUseFallbackChunking } from "../shared/supported-extensions"
import { MAX_BLOCK_CHARS, MIN_BLOCK_CHARS, MIN_CHUNK_REMAINDER_CHARS, MAX_CHARS_TOLERANCE_FACTOR } from "../constants"

/**
 * Node types that represent "leaf" definitions - functions/methods that should not drill down
 * to children when oversized. Instead, they should be chunked by lines to preserve implementation.
 *
 * Container types like class_declaration, module, namespace are NOT included here,
 * as they should continue to drill down to process their members.
 */
const LEAF_DEFINITION_TYPES = new Set([
  // JavaScript/TypeScript
  'function_declaration',
  'function_definition',
  'method_definition',
  'arrow_function',
  'function_expression',
  // Python
  'function_definition',
  // Go
  'function_declaration',
  'method_declaration',
  // Rust
  'function_item',
  // Java/C#/C++
  'method_declaration',
  'constructor_declaration',
  'function_definition',
  // Ruby
  'method',
  // PHP
  'function_definition',
  'method_declaration',
])

/**
 * Markdown header information for building parent chains
 */
interface MarkdownHeader {
  level: number
  text: string
  line: number
}

/**
 * Implementation of the code parser interface
 */
export class CodeParser implements ICodeParser {
  private loadedParsers: LanguageParser = {}
  private pendingLoads: Map<string, Promise<LanguageParser>> = new Map()
  // Markdown files are now supported using the custom markdown parser
  // which extracts headers and sections for semantic indexing

  /**
   * Parses a code file into code blocks
   * @param filePath Path to the file to parse
   * @param options Optional parsing options
   * @returns Promise resolving to array of code blocks
   */
  async parseFile(
    filePath: string,
    options?: {
      content?: string
      fileHash?: string
    },
  ): Promise<CodeBlock[]> {
    // Get file extension
    const ext = path.extname(filePath).toLowerCase()

    // Skip if not a supported language
    if (!this.isSupportedLanguage(ext)) {
      return []
    }

    // Get file content
    let content: string
    let fileHash: string

    if (options?.content) {
      content = options.content
      fileHash = options.fileHash || this.createFileHash(content)
    } else {
      try {
        content = await readFile(filePath, "utf8")
        fileHash = this.createFileHash(content)
      } catch (error) {
        console.error(`Error reading file ${filePath}:`, error)
        return []
      }
    }

    // Parse the file
    return this.parseContent(filePath, content, fileHash)
  }

  /**
   * Checks if a language is supported
   * @param extension File extension
   * @returns Boolean indicating if the language is supported
   */
  private isSupportedLanguage(extension: string): boolean {
    return scannerExtensions.includes(extension)
  }

  /**
   * Creates a hash for a file
   * @param content File content
   * @returns Hash string
   */
  private createFileHash(content: string): string {
    return createHash("sha256").update(content).digest("hex")
  }

  /**
   * Parses file content into code blocks
   * @param filePath Path to the file
   * @param content File content
   * @param fileHash File hash
   * @returns Array of code blocks
   */
  private async parseContent(filePath: string, content: string, fileHash: string): Promise<CodeBlock[]> {
    const ext = path.extname(filePath).slice(1).toLowerCase()
    const seenSegmentHashes = new Set<string>()

    // Handle markdown files specially
    if (ext === "md" || ext === "markdown") {
      return this.parseMarkdownContent(filePath, content, fileHash, seenSegmentHashes)
    }

    // Check if this extension should use fallback chunking
    if (shouldUseFallbackChunking(`.${ext}`)) {
      return this._performFallbackChunking(filePath, content, fileHash, seenSegmentHashes)
    }

    // Check if we already have the parser loaded
    if (!this.loadedParsers[ext]) {
      const pendingLoad = this.pendingLoads.get(ext)
      if (pendingLoad) {
        try {
          await pendingLoad
        } catch (error) {
          console.error(`Error in pending parser load for ${filePath}:`, error)
          return []
        }
      } else {
        const loadPromise = loadRequiredLanguageParsers([filePath])
        this.pendingLoads.set(ext, loadPromise)
        try {
          const newParsers = await loadPromise
          if (newParsers) {
            this.loadedParsers = { ...this.loadedParsers, ...newParsers }
          }
        } catch (error) {
          console.error(`Error loading language parser for ${filePath}:`, error)
          return []
        } finally {
          this.pendingLoads.delete(ext)
        }
      }
    }

    const language = this.loadedParsers[ext]
    if (!language) {
      console.warn(`No parser available for file extension: ${ext}`)
      return []
    }

    const tree = language.parser.parse(content)
    // We don't need to get the query string from languageQueries since it's already loaded
    // in the language object
    const captures = language.query.captures(tree.rootNode)
    // Check if captures are empty
    if (!captures || captures.length === 0) {
      if (content.length >= MIN_BLOCK_CHARS) {
        // Perform fallback chunking if content is large enough
        const blocks = this._performFallbackChunking(filePath, content, fileHash, seenSegmentHashes)
        return blocks
      } else {
        // Return empty if content is too small for fallback
        return []
      }
    }

    const results: CodeBlock[] = []

    // Process captures if not empty - build a map to track node identifiers
    const nodeIdentifierMap = new Map<treeSitter.SyntaxNode, string>()

    // Extract identifiers from captures
    for (const capture of captures) {
      if (capture.name === "name" || capture.name === "property.name.definition") {
        // Find the *closest* definition node that fully contains this name node.
        // When multiple definition nodes match (e.g. class + method), we prefer the
        // one with the smallest span so that method names don't get attached to
        // the outer class/container.
        const candidateDefinitions = captures.filter((c) => {
          if (!c.name.includes("definition")) return false
          const defNode = c.node
          const nameNode = capture.node
          if (!defNode || !nameNode) return false
          return (
            defNode.startPosition.row <= nameNode.startPosition.row &&
            defNode.endPosition.row >= nameNode.endPosition.row
          )
        })

        if (candidateDefinitions.length > 0) {
          const definitionCapture = candidateDefinitions.reduce((best, current) => {
            const bestSpan =
              best.node.endPosition.row - best.node.startPosition.row
            const currentSpan =
              current.node.endPosition.row - current.node.startPosition.row
            return currentSpan < bestSpan ? current : best
          })

          // For JSON properties, remove quotes from the identifier
          let identifier = capture.node.text
          if (
            capture.name === "property.name.definition" &&
            identifier.startsWith("\"") &&
            identifier.endsWith("\"")
          ) {
            identifier = identifier.slice(1, -1)
          }
          nodeIdentifierMap.set(definitionCapture.node, identifier)
        }
      }
    }

    const queue: treeSitter.SyntaxNode[] = captures
      .filter((capture: any) => capture.name.includes('definition'))
      .map((capture: any) => capture.node)

    while (queue.length > 0) {
      const currentNode = queue.shift()!
      // const lineSpan = currentNode.endPosition.row - currentNode.startPosition.row + 1 // Removed as per lint error

      // Check if the node meets the minimum character requirement
      if (currentNode.text && currentNode.text.length >= MIN_BLOCK_CHARS) {
        // If it also exceeds the maximum character limit, try to break it down
        if (currentNode.text.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR) {
          // Check if this is a "leaf" definition (function/method) that should not drill down
          const isLeafDefinition = LEAF_DEFINITION_TYPES.has(currentNode.type)

          if (isLeafDefinition) {
            // For functions/methods: chunk by lines instead of drilling down to children
            // This ensures implementation is captured, not just docstrings
            const chunkedBlocks = this._chunkDefinitionNodeByLines(
              currentNode,
              filePath,
              fileHash,
              seenSegmentHashes,
              nodeIdentifierMap,
            )
            results.push(...chunkedBlocks)
          } else if (currentNode.children && currentNode.children.length > 0) {
            // For containers (classes, modules): drill down to process members
            queue.push(...currentNode.children)
          } else {
            // For other leaf nodes: chunk by lines
            const chunkedBlocks = this._chunkLeafNodeByLines(
              currentNode,
              filePath,
              fileHash,
              seenSegmentHashes,
              nodeIdentifierMap,
            )
            results.push(...chunkedBlocks)
          }
        } else {
          // Node meets min chars and is within max chars, create a block
          const identifier = nodeIdentifierMap.get(currentNode) ||
            currentNode.childForFieldName("name")?.text ||
            currentNode.children?.find((c) => c.type === "identifier")?.text ||
            null
          const type = currentNode.type
          const start_line = currentNode.startPosition.row + 1
          const end_line = currentNode.endPosition.row + 1
          const content = currentNode.text
          const contentPreview = content.slice(0, 100)
          const segmentHash = createHash("sha256")
            .update(`${filePath}-${start_line}-${end_line}-${content.length}-${contentPreview}`)
            .digest("hex")

          if (!seenSegmentHashes.has(segmentHash)) {
            seenSegmentHashes.add(segmentHash)

            // Build parent chain and hierarchy display
            const parentChain = this.buildParentChain('tree-sitter', currentNode, nodeIdentifierMap)
            const hierarchyDisplay = this.buildHierarchyDisplay(parentChain, identifier, type)

            results.push({
              file_path: filePath,
              identifier,
              type,
              start_line,
              end_line,
              content,
              segmentHash,
              fileHash,
              chunkSource: 'tree-sitter',
              parentChain,
              hierarchyDisplay,
            })
          }
        }
      }
      // Nodes smaller than MIN_BLOCK_CHARS are ignored
    }

    return this.deduplicateBlocks(results)
  }

  /**
   * Common helper function to chunk text by lines, avoiding tiny remainders.
   */
  private _chunkTextByLines(
    lines: string[],
    filePath: string,
    fileHash: string,

    chunkType: string,
    seenSegmentHashes: Set<string>,
    baseStartLine: number = 1, // 1-based start line of the *first* line in the `lines` array
    options?: {
      /**
       * Optional identifier (e.g. markdown header text) to attach to all
       * produced chunks. When omitted, `identifier` defaults to null.
       */
      identifier?: string | null
      /**
       * Optional parent chain describing the logical hierarchy for the
       * chunks (used primarily for markdown sections).
       */
      parentChain?: ParentContainer[]
      /**
       * Optional pre-computed hierarchy display string.
       */
      hierarchyDisplay?: string | null
      /**
       * Optional override for the chunkSource. When omitted we keep the
       * existing defaults of 'fallback' and 'line-segment'.
       */
      chunkSourceOverride?: CodeBlock["chunkSource"]
    },
  ): CodeBlock[] {
    const identifier = options?.identifier ?? null
    const parentChain = options?.parentChain ?? []
    const hierarchyDisplay = options?.hierarchyDisplay ?? null
    const chunkSourceOverride = options?.chunkSourceOverride

    const chunks: CodeBlock[] = []
    let currentChunkLines: string[] = []
    let currentChunkLength = 0
    let chunkStartLineIndex = 0 // 0-based index within the `lines` array
    const effectiveMaxChars = MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR

    const finalizeChunk = (endLineIndex: number) => {
      if (currentChunkLength >= MIN_BLOCK_CHARS && currentChunkLines.length > 0) {
        const chunkContent = currentChunkLines.join("\n")
        const startLine = baseStartLine + chunkStartLineIndex
        const endLine = baseStartLine + endLineIndex
        const contentPreview = chunkContent.slice(0, 100)
        const segmentHash = createHash("sha256")
          .update(`${filePath}-${startLine}-${endLine}-${chunkContent.length}-${contentPreview}`)
          .digest("hex")

        if (!seenSegmentHashes.has(segmentHash)) {
          seenSegmentHashes.add(segmentHash)
          chunks.push({
            file_path: filePath,
            identifier,
            type: chunkType,
            start_line: startLine,
            end_line: endLine,
            content: chunkContent,
            segmentHash,
            fileHash,
            chunkSource: chunkSourceOverride ?? "fallback",
            parentChain,
            hierarchyDisplay,
          })
        }
      }
      currentChunkLines = []
      currentChunkLength = 0
      chunkStartLineIndex = endLineIndex + 1
    }

    const createSegmentBlock = (segment: string, originalLineNumber: number, startCharIndex: number) => {
      const segmentPreview = segment.slice(0, 100)
      const segmentHash = createHash("sha256")
        .update(
          `${filePath}-${originalLineNumber}-${originalLineNumber}-${startCharIndex}-${segment.length}-${segmentPreview}`,
        )
        .digest("hex")

      if (!seenSegmentHashes.has(segmentHash)) {
        seenSegmentHashes.add(segmentHash)
        chunks.push({
          file_path: filePath,
          identifier,
          type: `${chunkType}_segment`,
          start_line: originalLineNumber,
          end_line: originalLineNumber,
          content: segment,
          segmentHash,
          fileHash,
          chunkSource: chunkSourceOverride ?? "line-segment",
          parentChain,
          hierarchyDisplay,
        })
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineLength = line.length + (i < lines.length - 1 ? 1 : 0) // +1 for newline, except last line
      const originalLineNumber = baseStartLine + i

      // Handle oversized lines (longer than effectiveMaxChars)
      // We allow some tolerance for chunk sizing, and only split single lines
      // when they exceed the tolerated max.
      if (lineLength > effectiveMaxChars) {
        // Finalize any existing normal chunk before processing the oversized line
        if (currentChunkLines.length > 0) {
          finalizeChunk(i - 1)
        }

        // Split the oversized line into segments
        let remainingLineContent = line
        let currentSegmentStartChar = 0
        while (remainingLineContent.length > 0) {
          const segment = remainingLineContent.substring(0, MAX_BLOCK_CHARS)
          remainingLineContent = remainingLineContent.substring(MAX_BLOCK_CHARS)
          createSegmentBlock(segment, originalLineNumber, currentSegmentStartChar)
          currentSegmentStartChar += MAX_BLOCK_CHARS
        }
        continue
      }

      // Handle normally sized lines
      if (currentChunkLength > 0 && currentChunkLength + lineLength > effectiveMaxChars) {
        // Re-balancing Logic
        let splitIndex = i - 1
        let remainderLength = 0
        for (let j = i; j < lines.length; j++) {
          remainderLength += lines[j].length + (j < lines.length - 1 ? 1 : 0)
        }

        if (
          currentChunkLength >= MIN_BLOCK_CHARS &&
          remainderLength < MIN_CHUNK_REMAINDER_CHARS &&
          currentChunkLines.length > 1
        ) {
          for (let k = i - 2; k >= chunkStartLineIndex; k--) {
            const potentialChunkLines = lines.slice(chunkStartLineIndex, k + 1)
            const potentialChunkLength = potentialChunkLines.join("\n").length + 1
            const potentialNextChunkLines = lines.slice(k + 1)
            const potentialNextChunkLength = potentialNextChunkLines.join("\n").length + 1

            if (
              potentialChunkLength >= MIN_BLOCK_CHARS &&
              potentialNextChunkLength >= MIN_CHUNK_REMAINDER_CHARS
            ) {
              splitIndex = k
              break
            }
          }
        }

        finalizeChunk(splitIndex)

        if (i >= chunkStartLineIndex) {
          currentChunkLines.push(line)
          currentChunkLength += lineLength
        } else {
          i = chunkStartLineIndex - 1
          continue
        }
      } else {
        currentChunkLines.push(line)
        currentChunkLength += lineLength
      }
    }

    // Process the last remaining chunk
    if (currentChunkLines.length > 0) {
      finalizeChunk(lines.length - 1)
    }

    return chunks
  }

  private _performFallbackChunking(
    filePath: string,
    content: string,
    fileHash: string,
    seenSegmentHashes: Set<string>,
  ): CodeBlock[] {
    const lines = content.split("\n")
    return this._chunkTextByLines(lines, filePath, fileHash, "fallback_chunk", seenSegmentHashes)
  }

  private _chunkLeafNodeByLines(
    node: treeSitter.SyntaxNode,
    filePath: string,
    fileHash: string,
    seenSegmentHashes: Set<string>,
    nodeIdentifierMap: Map<treeSitter.SyntaxNode, string>
  ): CodeBlock[] {
    if (!node.text) {
      console.warn(`Node text is undefined for ${node.type} in ${filePath}`)
      return []
    }
    const lines = node.text.split("\n")
    const baseStartLine = node.startPosition.row + 1

    // Build parent chain and hierarchy display to preserve context
    // For non-definition nodes (like string_content), we still want to show
    // which class/function they belong to
    const parentChain = this.buildParentChain('tree-sitter', node, nodeIdentifierMap)
    const identifier = null // Leaf nodes like string_content don't have their own identifier
    const type = node.type
    const hierarchyDisplay = this.buildHierarchyDisplay(parentChain, identifier, type)

    return this._chunkTextByLines(
      lines,
      filePath,
      fileHash,
      type,
      seenSegmentHashes,
      baseStartLine,
      {
        identifier,
        parentChain,
        hierarchyDisplay,
        chunkSourceOverride: 'tree-sitter'
      }
    )
  }

  /**
   * Chunks a definition node (function/method) by lines while preserving metadata.
   * This method is used for oversized leaf definition nodes to ensure their entire
   * implementation is captured, not just docstrings or large child nodes.
   */
  private _chunkDefinitionNodeByLines(
    node: treeSitter.SyntaxNode,
    filePath: string,
    fileHash: string,
    seenSegmentHashes: Set<string>,
    nodeIdentifierMap: Map<treeSitter.SyntaxNode, string>
  ): CodeBlock[] {
    if (!node.text) {
      console.warn(`Node text is undefined for ${node.type} in ${filePath}`)
      return []
    }

    const lines = node.text.split("\n")
    const baseStartLine = node.startPosition.row + 1

    // Extract definition metadata to preserve across all chunks
    const identifier = nodeIdentifierMap.get(node) ||
      node.childForFieldName("name")?.text ||
      node.children?.find((c) => c.type === "identifier")?.text ||
      null
    const type = node.type
    const parentChain = this.buildParentChain('tree-sitter', node, nodeIdentifierMap)
    const hierarchyDisplay = this.buildHierarchyDisplay(parentChain, identifier, type)

    // Call line chunking with metadata so all chunks share the same hierarchy
    return this._chunkTextByLines(
      lines,
      filePath,
      fileHash,
      type,
      seenSegmentHashes,
      baseStartLine,
      {
        identifier,
        parentChain,
        hierarchyDisplay,
        chunkSourceOverride: 'tree-sitter'
      }
    )
  }

  /**
   * Removes blocks that are contained within other blocks to avoid duplication
   */
  private deduplicateBlocks(blocks: CodeBlock[]): CodeBlock[] {
    const sourceOrder = ['tree-sitter', 'fallback', 'line-segment']
    blocks.sort((a, b) =>
      sourceOrder.indexOf(a.chunkSource) - sourceOrder.indexOf(b.chunkSource)
    )

    const result: CodeBlock[] = []
    for (const block of blocks) {
      const isDuplicate = result.some(existing =>
        this.isBlockContained(block, existing)
      )
      if (!isDuplicate) {
        result.push(block)
      }
    }
    return result
  }

  /**
   * Builds the parent chain for a given tree-sitter node
   */
  /**
   * 统一的parentChain构建入口
   */
  private buildParentChain(
    context: 'tree-sitter' | 'markdown',
    ...args: any[]
  ): ParentContainer[] {
    if (context === 'markdown') {
      return this.buildMarkdownParentChain(...args as [MarkdownHeader, MarkdownHeader[]])
    } else {
      return this.buildTreeSitterParentChain(...args as [treeSitter.SyntaxNode, Map<treeSitter.SyntaxNode, string>])
    }
  }

  /**
   * 原有方法重命名 - tree-sitter专用
   */
  private buildTreeSitterParentChain(
    node: treeSitter.SyntaxNode,
    nodeIdentifierMap: Map<treeSitter.SyntaxNode, string>
  ): ParentContainer[] {
    const parentChain: ParentContainer[] = []

    // Container node types that we want to track in the hierarchy
    const containerTypes = new Set([
      'class_declaration', 'class_definition',
      'interface_declaration', 'interface_definition',
      'namespace_declaration', 'namespace_definition',
      'module_declaration', 'module_definition',
      'function_declaration', 'function_definition', 'method_definition',
      'object_expression', 'object_pattern',
      'object', 'pair', // JSON objects and properties
      'program', 'source_file'
    ])

    let currentNode = node.parent
    while (currentNode) {
      // Skip non-container nodes
      if (!containerTypes.has(currentNode.type)) {
        currentNode = currentNode.parent
        continue
      }

      // Skip program/source_file as they're too generic
      if (currentNode.type === 'program' || currentNode.type === 'source_file') {
        currentNode = currentNode.parent
        continue
      }

      // Try to get identifier from various sources
      let identifier = nodeIdentifierMap.get(currentNode) || null

      if (!identifier) {
        // Try to extract identifier from the node structure
        identifier = this.extractNodeIdentifier(currentNode)
      }

      // Only add to chain if we found a meaningful identifier
      if (identifier) {
        parentChain.unshift({ // Add to beginning to maintain correct order
          identifier: identifier,
          type: this.normalizeNodeType(currentNode.type)
        })
      }

      currentNode = currentNode.parent
    }

    return parentChain
  }

  /**
   * Markdown专用的parentChain构建方法
   * 基于header层级关系构建虚拟的父子关系
   */
  private buildMarkdownParentChain(
    currentHeader: MarkdownHeader,
    headerStack: MarkdownHeader[]
  ): ParentContainer[] {
    const parentChain: ParentContainer[] = []

    // 找到当前header的直接父级
    const parentLevel = currentHeader.level - 1
    if (parentLevel < 1) {
      return parentChain // h1没有父级
    }

    // 从栈顶开始查找最近的父级header
    for (let i = headerStack.length - 1; i >= 0; i--) {
      const header = headerStack[i]
      if (header.level === parentLevel) {
        // 找到直接父级，添加到parentChain
        parentChain.push({
          identifier: header.text,
          // 使用更简洁的display类型，避免hierarchyDisplay过长
          type: this.getMarkdownDisplayType(header.level),
        })

        // 递归查找父级的父级
        const grandParentChain = this.buildMarkdownParentChain(header, headerStack.slice(0, i))
        parentChain.unshift(...grandParentChain)
        break
      }
    }

    return parentChain
  }

  /**
   * 为Markdown header提供统一的、精简的展示类型
   * 例如：h1 -> "header_1"
   */
  private getMarkdownDisplayType(level: number): string {
    return `header_${level}`
  }

  /**
   * Extracts identifier from a tree-sitter node using various strategies
   */
  private extractNodeIdentifier(node: treeSitter.SyntaxNode): string | null {
    // Try field-based extraction first
    const nameField = node.childForFieldName("name")
    if (nameField) {
      let name = nameField.text
      // Remove quotes from JSON properties
      if (name.startsWith('"') && name.endsWith('"')) {
        name = name.slice(1, -1)
      }
      return name
    }

    // Try to find identifier child nodes
    const identifierChild = node.children?.find(child =>
      child.type === "identifier" ||
      child.type === "type_identifier" ||
      child.type === "property_identifier"
    )
    if (identifierChild) {
      let name = identifierChild.text
      // Remove quotes from JSON properties
      if (name.startsWith('"') && name.endsWith('"')) {
        name = name.slice(1, -1)
      }
      return name
    }

    // For JSON pairs, try to get the key
    if (node.type === 'pair' && node.children && node.children.length > 0) {
      const key = node.children[0]
      if (key) {
        let name = key.text
        // Remove quotes from JSON keys
        if (name.startsWith('"') && name.endsWith('"')) {
          name = name.slice(1, -1)
        }
        return name
      }
    }

    return null
  }

  /**
   * Normalizes node types to more readable format
   */
  private normalizeNodeType(nodeType: string): string {
    const typeMap: Record<string, string> = {
      'class_declaration': 'class',
      'class_definition': 'class',
      'interface_declaration': 'interface',
      'interface_definition': 'interface',
      'namespace_declaration': 'namespace',
      'namespace_definition': 'namespace',
      'module_declaration': 'module',
      'module_definition': 'module',
      'function_declaration': 'function',
      'function_definition': 'function',
      'method_definition': 'method',
      'object_expression': 'object',
      'object_pattern': 'object',
      'object': 'object',
      'pair': 'property'
    }

    return typeMap[nodeType] || nodeType
  }

  /**
   * Builds hierarchy display string from parent chain
   */
  private buildHierarchyDisplay(parentChain: ParentContainer[], currentIdentifier: string | null, currentType: string): string | null {
    const parts: string[] = []

    // Add parent parts
    for (const parent of parentChain) {
      parts.push(`${parent.type} ${parent.identifier}`)
    }

    // Add current node if it has an identifier
    if (currentIdentifier) {
      const normalizedCurrentType = this.normalizeNodeType(currentType)
      parts.push(`${normalizedCurrentType} ${currentIdentifier}`)
    }

    return parts.length > 0 ? parts.join(' > ') : null
  }

  /**
   * 为Markdown section构建hierarchyDisplay
   */
  private buildMarkdownHierarchyDisplay(
    parentChain: ParentContainer[],
    currentHeader: MarkdownHeader
  ): string {
    const parts: string[] = []

    // 添加父级链（这里的type已经是精简后的header_X）
    for (const parent of parentChain) {
      parts.push(`${parent.type} ${parent.identifier}`)
    }

    // 添加当前header（使用精简后的header_X）
    parts.push(`${this.getMarkdownDisplayType(currentHeader.level)} ${currentHeader.text}`)

    return parts.join(' > ')
  }

  /**
   * 更新header栈，保持正确的层级关系
   */
  private updateHeaderStack(headerStack: MarkdownHeader[], newHeader: MarkdownHeader): MarkdownHeader[] {
    // 移除所有大于或等于当前层级的header（同级或更低级的header需要被替换）
    while (headerStack.length > 0 && headerStack[headerStack.length - 1].level >= newHeader.level) {
      headerStack.pop()
    }

    // 添加新的header
    headerStack.push(newHeader)

    return headerStack
  }

  /**
   * Checks if block1 is contained within block2
   */
  private isBlockContained(block1: CodeBlock, block2: CodeBlock): boolean {
    return block1.file_path === block2.file_path &&
      block1.start_line >= block2.start_line &&
      block1.end_line <= block2.end_line &&
      block2.content.includes(block1.content)
  }

  /**
   * Helper method to process markdown content sections with consistent chunking logic
   */
  private processMarkdownSection(
    lines: string[],
    filePath: string,
    fileHash: string,
    type: string,
    seenSegmentHashes: Set<string>,
    startLine: number,
    identifier: string | null = null,
    parentChain: ParentContainer[] = [],
    hierarchyDisplay: string | null = null,
  ): CodeBlock[] {
    const content = lines.join("\n")

    if (content.trim().length < MIN_BLOCK_CHARS) {
      return []
    }

    // Check if content needs chunking (either total size or individual line size)
    const needsChunking =
      content.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR ||
      lines.some((line) => line.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR)

    if (needsChunking) {
      // Apply chunking for large content or oversized lines
      return this._chunkTextByLines(
        lines,
        filePath,
        fileHash,
        type,
        seenSegmentHashes,
        startLine,
        {
          identifier,
          parentChain,
          hierarchyDisplay,
          // Ensure markdown sections keep a consistent source label even
          // when they are internally chunked.
          chunkSourceOverride: "markdown",
        },
      )
    }

    // Create a single block for normal-sized content with no oversized lines
    const endLine = startLine + lines.length - 1
    const contentPreview = content.slice(0, 100)
    const segmentHash = createHash("sha256")
      .update(`${filePath}-${startLine}-${endLine}-${content.length}-${contentPreview}`)
      .digest("hex")

    if (!seenSegmentHashes.has(segmentHash)) {
      seenSegmentHashes.add(segmentHash)
      return [
        {
          file_path: filePath,
          identifier,
          type,
          start_line: startLine,
          end_line: endLine,
          content,
          segmentHash,
          fileHash,
          chunkSource: 'markdown',
          parentChain,
          hierarchyDisplay,
        },
      ]
    }

    return []
  }

  private parseMarkdownContent(
    filePath: string,
    content: string,
    fileHash: string,
    seenSegmentHashes: Set<string>,
  ): CodeBlock[] {
    const lines = content.split("\n")
    const markdownCaptures = parseMarkdown(content) || []

    if (markdownCaptures.length === 0) {
      // No headers found, process entire content
      return this.processMarkdownSection(lines, filePath, fileHash, "markdown_content", seenSegmentHashes, 1)
    }

    const results: CodeBlock[] = []
    let lastProcessedLine = 0

    // 维护一个header栈来跟踪层级关系
    const headerStack: MarkdownHeader[] = []

    // Process content before the first header
    if (markdownCaptures.length > 0) {
      const firstHeaderLine = markdownCaptures[0].node.startPosition.row
      if (firstHeaderLine > 0) {
        const preHeaderLines = lines.slice(0, firstHeaderLine)
        const preHeaderBlocks = this.processMarkdownSection(
          preHeaderLines,
          filePath,
          fileHash,
          "markdown_content",
          seenSegmentHashes,
          1,
          null, // 没有identifier
          [],   // 空的parentChain
          null, // 没有hierarchyDisplay
        )
        results.push(...preHeaderBlocks)
      }
    }

    // Process markdown captures (headers and sections)
    for (let i = 0; i < markdownCaptures.length; i += 2) {
      const nameCapture = markdownCaptures[i]
      // Ensure we don't go out of bounds when accessing the next capture
      if (i + 1 >= markdownCaptures.length) break
      const definitionCapture = markdownCaptures[i + 1]

      if (!definitionCapture) continue

      const startLine = definitionCapture.node.startPosition.row + 1
      const endLine = definitionCapture.node.endPosition.row + 1
      const sectionLines = lines.slice(startLine - 1, endLine)

      // Extract header level for type classification
      const headerMatch = nameCapture.name.match(/\.h(\d)$/)
      const headerLevel = headerMatch ? parseInt(headerMatch[1]) : 1
      const headerText = nameCapture.node.text

      // 创建当前header对象
      const currentHeader: MarkdownHeader = {
        level: headerLevel,
        text: headerText,
        line: startLine
      }

      // 构建parentChain - 在更新栈之前使用当前栈来查找父级
      const parentChain = this.buildMarkdownParentChain(currentHeader, headerStack)

      // 更新header栈
      this.updateHeaderStack(headerStack, currentHeader)

      // 构建hierarchyDisplay
      const hierarchyDisplay = this.buildMarkdownHierarchyDisplay(parentChain, currentHeader)

      const sectionBlocks = this.processMarkdownSection(
        sectionLines,
        filePath,
        fileHash,
        `markdown_header_h${headerLevel}`,
        seenSegmentHashes,
        startLine,
        headerText,
        parentChain,
        hierarchyDisplay,
      )
      results.push(...sectionBlocks)

      lastProcessedLine = endLine
    }

    // Process any remaining content after the last header section
    if (lastProcessedLine < lines.length) {
      const remainingLines = lines.slice(lastProcessedLine)
      const remainingBlocks = this.processMarkdownSection(
        remainingLines,
        filePath,
        fileHash,
        "markdown_content",
        seenSegmentHashes,
        lastProcessedLine + 1,
        null,
        [],   // 剩余内容没有特定的父级
        null, // 剩余内容没有层级显示
      )
      results.push(...remainingBlocks)
    }

    return results
  }
}

// Export a singleton instance for convenience
export const codeParser = new CodeParser()
