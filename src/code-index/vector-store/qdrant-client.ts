import { QdrantClient, Schemas } from "@qdrant/js-client-rest"
import { createHash } from "crypto"
import * as path from "path"
import { v5 as uuidv5 } from "uuid"
import { IVectorStore, SearchFilter, HybridSearchOptions } from "../interfaces/vector-store"
import { Payload, VectorStoreSearchResult } from "../interfaces"
import {
  DEFAULT_SEARCH_MIN_SCORE,
  DEFAULT_MAX_SEARCH_RESULTS,
  QDRANT_CODE_BLOCK_NAMESPACE
} from "../constants"
import { validateLimit, validateMinScore } from "../validate-search-params"

/**
 * Pattern Compiler for Glob-like Path Filtering
 * Compiles glob patterns to Qdrant substring filters
 */
class PatternCompiler {
  /**
   * Compiles path filters to Qdrant filter structure
   * @param pathFilters Array of path filter patterns
   * @returns Qdrant filter object
   */
  static compile(pathFilters: string[]): any {
    if (!pathFilters || pathFilters.length === 0) {
      return {}
    }

    const includePatterns = pathFilters.filter(p => !p.startsWith('!'))
    const excludePatterns = pathFilters.filter(p => p.startsWith('!')).map(p => p.slice(1))

    const filter: any = {}

    // Handle include patterns (OR semantics)
    if (includePatterns.length > 0) {
      const shouldClauses = includePatterns.flatMap(pattern =>
        this.expandPattern(pattern).map(expanded => ({
          must: this.extractSubstrings(expanded).map(s => ({
            key: "filePathLower",
            match: { text: s.toLowerCase() }
          }))
        }))
      )

      if (shouldClauses.length > 0) {
        filter.should = shouldClauses
        // Note: Qdrant's should clause defaults to OR logic, no min_should needed
      }
    }

    // Handle exclude patterns
    if (excludePatterns.length > 0) {
      const mustNotClauses = excludePatterns.flatMap(pattern =>
        this.expandPattern(pattern).map(expanded => ({
          must: this.extractSubstrings(expanded).map(s => ({
            key: "filePathLower",
            match: { text: s.toLowerCase() }
          }))
        }))
      )

      if (mustNotClauses.length > 0) {
        filter.must_not = mustNotClauses
      }
    }

    return filter
  }

  /**
   * Expands brace patterns like {a,b} into multiple patterns
   * @param pattern Input pattern
   * @returns Array of expanded patterns
   */
  private static expandPattern(pattern: string): string[] {
    const braceRegex = /{([^}]+)}/g
    let match = braceRegex.exec(pattern)

    if (!match) return [pattern]

    const options = match[1].split(',').map(opt => opt.trim()).filter(Boolean)
    const prefix = pattern.substring(0, match.index)
    const suffix = pattern.substring(match.index + match[0].length)

    return options.flatMap(option =>
      this.expandPattern(prefix + option + suffix)
    )
  }

  /**
   * Extracts substrings from a pattern by splitting on glob wildcards
   * @param pattern Input pattern
   * @returns Array of substrings to match
   */
  private static extractSubstrings(pattern: string): string[] {
    const cleanPattern = pattern.replace(/^!/, '')

    // First, remove unsupported character classes [] by removing entire segments containing them
    // Split by ** and * first to identify segments
    const segments = cleanPattern.split(/(\*\*|\*)/)

    // Process segments: keep only valid substrings (not wildcards, not character classes)
    const validParts = segments.filter(part => {
      // Remove wildcard tokens themselves (they are separators, not substrings to match)
      if (part === '**' || part === '*') return false
      if (part.length === 0) return false
      // Remove segments containing character classes [] - they are not supported
      if (part.includes('[') || part.includes(']')) return false
      // ? is treated as a regular character, keep it
      return true
    })

    // Filter out standalone path separators (only "/" or "\")
    // but keep segments that contain path separators with other content (e.g., "src/", "/b")
    return validParts.filter(part => {
      const isStandaloneSeparator = part === '/' || part === '\\'
      return !isStandaloneSeparator
    })
  }
}

/**
 * Qdrant implementation of the vector store interface
 */
export class QdrantVectorStore implements IVectorStore {
  private readonly DISTANCE_METRIC = "Cosine"
  private readonly vectorSize: number
  private readonly workspacePath: string
  private readonly qdrantUrl: string = "http://localhost:6333"

  private client: QdrantClient
  private readonly collectionName: string

  /**
   * Creates a new Qdrant vector store
   * @param workspacePath Path to the workspace (for backward compatibility, can be first or second parameter)
   * @param urlOrVectorSize Either the URL to Qdrant server or the vector size (for backward compatibility)
   * @param vectorSizeOrApiKey Either the vector size or API key (for backward compatibility)
   * @param apiKey Optional API key (for backward compatibility)
   */
  constructor(workspacePath: string, urlOrVectorSize: string | number, vectorSizeOrApiKey?: number | string, apiKey?: string) {
    // Handle backward compatibility: (workspacePath, url, vectorSize, apiKey)
    let url: string
    let vectorSize: number

    if (typeof urlOrVectorSize === "string") {
      // Old signature: (workspacePath, url, vectorSize, apiKey?)
      url = urlOrVectorSize
      vectorSize = vectorSizeOrApiKey as number
    } else {
      // New signature: (workspacePath, vectorSize, url?, apiKey?)
      url = this.qdrantUrl
      vectorSize = urlOrVectorSize
      if (typeof vectorSizeOrApiKey === "string") {
        apiKey = vectorSizeOrApiKey
      }
    }

    // Store the resolved URL for our property
    this.qdrantUrl = url
    this.workspacePath = workspacePath
    this.vectorSize = vectorSize

    try {
      const urlObj = new URL(url)
      this.client = new QdrantClient({
        url: urlObj.toString(),
        apiKey,
        headers: {
          "User-Agent": "AutoDev",
        },
      })
    } catch (error) {
      console.warn(`[QdrantVectorStore] Invalid URL provided: ${url}. Falling back to default.`)
      this.client = new QdrantClient({
        url: this.qdrantUrl,
        apiKey,
        headers: {
          "User-Agent": "AutoDev",
        },
      })
    }

    // Generate collection name from workspace path
    const hash = createHash("sha256").update(workspacePath).digest("hex")
    this.collectionName = `ws-${hash.substring(0, 16)}`
  }

  private async getCollectionInfo(): Promise<Schemas["CollectionInfo"] | null> {
    try {
      const collectionInfo = await this.client.getCollection(this.collectionName)
      return collectionInfo
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.warn(
          `[QdrantVectorStore] Warning during getCollectionInfo for "${this.collectionName}". Collection may not exist or another error occurred:`,
          error.message,
        )
      }
      return null
    }
  }

  /**
   * Detect whether an error indicates that the target collection does not exist.
   * Qdrant REST client wraps errors in ApiError objects with status/data fields.
   */
  private isCollectionNotFoundError(error: unknown): boolean {
    const err: any = error
    const statusCode = err?.status
    if (statusCode === 404) {
      return true
    }

    const message = (err?.message || "").toString().toLowerCase()
    if (message.includes("collection") && message.includes("not found")) {
      return true
    }

    const dataError = (err?.data?.status?.error || "").toString().toLowerCase()
    if (dataError.includes("collection") && dataError.includes("doesn't exist")) {
      return true
    }

    return false
  }

  /**
   * Initializes the vector store
   * @returns Promise resolving to boolean indicating if a new collection was created
   */
  async initialize(): Promise<boolean> {
    let created = false
    try {
      const collectionInfo = await this.getCollectionInfo()

      if (collectionInfo === null) {
        // Collection info not retrieved (assume not found or inaccessible), create it
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: this.vectorSize,
            distance: this.DISTANCE_METRIC,
            on_disk: true,
          },
          hnsw_config: {
            m: 64,
            ef_construct: 512,
            on_disk: true,
          },
          sparse_vectors: {
            "bm25": {
              index: {
                on_disk: true,
              },
              modifier: "idf",
            },
          },
        })
        created = true
      } else {
        // Collection exists, check vector size
        const vectorsConfig = collectionInfo.config?.params?.vectors
        let existingVectorSize: number

        if (typeof vectorsConfig === "number") {
          existingVectorSize = vectorsConfig
        } else if (
          vectorsConfig &&
          typeof vectorsConfig === "object" &&
          "size" in vectorsConfig &&
          typeof vectorsConfig.size === "number"
        ) {
          existingVectorSize = vectorsConfig.size
        } else {
          existingVectorSize = 0 // Fallback for unknown configuration
        }

        if (existingVectorSize === this.vectorSize) {
            // Check if sparse_vectors are configured (needed for hybrid BM25 search)
            const sparseVectorsConfig = (collectionInfo.config?.params as any)?.sparse_vectors
            if (!sparseVectorsConfig || Object.keys(sparseVectorsConfig).length === 0) {
              console.warn(
                `[QdrantVectorStore] Collection ${this.collectionName} exists but lacks sparse_vectors config. Recreating to enable hybrid search.`,
              )
              created = await this._recreateCollectionWithNewDimension(existingVectorSize)
            } else {
              created = false // Exists and correct
            }
        } else {
          // Exists but wrong vector size, recreate with enhanced error handling
          created = await this._recreateCollectionWithNewDimension(existingVectorSize)
        }
      }

      // Create payload indexes
      await this._createPayloadIndexes()
      return created
    } catch (error: any) {
      const errorMessage = error?.message || error

      // If this is already a vector dimension mismatch error (identified by custom property), re-throw it as-is
      if (error instanceof Error && (error as any).cause !== undefined) {
        throw error
      }

      // Otherwise, provide a more user-friendly error message that includes the original error
      throw new Error(
        `Failed to connect to Qdrant at ${this.qdrantUrl}: ${errorMessage}. Please ensure Qdrant is running and accessible.`,
      )
    }
  }

  /**
   * Recreates the collection with a new vector dimension, handling failures gracefully.
   * @param existingVectorSize The current vector size of the existing collection
   * @returns Promise resolving to boolean indicating if a new collection was created
   */
  private async _recreateCollectionWithNewDimension(existingVectorSize: number): Promise<boolean> {
    console.warn(
      `[QdrantVectorStore] Collection ${this.collectionName} exists with vector size ${existingVectorSize}, but expected ${this.vectorSize}. Recreating collection.`,
    )

    let deletionSucceeded = false
    let recreationAttempted = false

    try {
      // Step 1: Attempt to delete the existing collection
      console.log(`[QdrantVectorStore] Deleting existing collection ${this.collectionName}...`)
      await this.client.deleteCollection(this.collectionName)
      deletionSucceeded = true
      console.log(`[QdrantVectorStore] Successfully deleted collection ${this.collectionName}`)

      // Step 2: Wait a brief moment to ensure deletion is processed
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Step 3: Verify the collection is actually deleted
      const verificationInfo = await this.getCollectionInfo()
      if (verificationInfo !== null) {
        throw new Error("Collection still exists after deletion attempt")
      }

      // Step 4: Create the new collection with correct dimensions
      console.log(
        `[QdrantVectorStore] Creating new collection ${this.collectionName} with vector size ${this.vectorSize}...`,
      )
      recreationAttempted = true
      await this.client.createCollection(this.collectionName, {
        vectors: {
          size: this.vectorSize,
          distance: this.DISTANCE_METRIC,
          on_disk: true,
        },
        hnsw_config: {
          m: 64,
          ef_construct: 512,
          on_disk: true,
        },
        sparse_vectors: {
          "bm25": {
            index: {
              on_disk: true,
            },
            modifier: "idf",
          },
        },
      })
      console.log(`[QdrantVectorStore] Successfully created new collection ${this.collectionName}`)
      return true
    } catch (recreationError) {
      const errorMessage = recreationError instanceof Error ? recreationError.message : String(recreationError)

      // Provide detailed error context based on what stage failed
      let contextualErrorMessage: string
      if (!deletionSucceeded) {
        contextualErrorMessage = `Failed to delete existing collection with vector size ${existingVectorSize}. ${errorMessage}`
      } else if (!recreationAttempted) {
        contextualErrorMessage = `Deleted existing collection but failed verification step. ${errorMessage}`
      } else {
        contextualErrorMessage = `Deleted existing collection but failed to create new collection with vector size ${this.vectorSize}. ${errorMessage}`
      }

      console.error(
        `[QdrantVectorStore] CRITICAL: Failed to recreate collection ${this.collectionName} for dimension change (${existingVectorSize} -> ${this.vectorSize}). ${contextualErrorMessage}`,
      )

      // Create a comprehensive error message for the user
      const dimensionMismatchError = new Error(
        `Vector dimension mismatch detected and auto-recovery failed. ${contextualErrorMessage}`,
      )

      // Preserve the original error context using custom property
      ;(dimensionMismatchError as any).cause = recreationError
      throw dimensionMismatchError
    }
  }

  /**
   * Creates payload indexes for the collection, handling errors gracefully.
   */
  private async _createPayloadIndexes(): Promise<void> {
    // Create index for the 'type' field to enable metadata filtering
    try {
      await this.client.createPayloadIndex(this.collectionName, {
        field_name: "type",
        field_schema: "keyword",
      })
    } catch (indexError: any) {
      const errorMessage = (indexError?.message || "").toLowerCase()
      if (!errorMessage.includes("already exists")) {
        console.warn(
          `[QdrantVectorStore] Could not create payload index for type on ${this.collectionName}. Details:`,
          indexError?.message || indexError,
        )
      }
    }

    // Create indexes for pathSegments fields
    for (let i = 0; i <= 4; i++) {
      try {
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: `pathSegments.${i}`,
          field_schema: "keyword",
        })
      } catch (indexError: any) {
        const errorMessage = (indexError?.message || "").toLowerCase()
        if (!errorMessage.includes("already exists")) {
          console.warn(
            `[QdrantVectorStore] Could not create payload index for pathSegments.${i} on ${this.collectionName}. Details:`,
            indexError?.message || indexError,
          )
        }
      }
    }

    // Create index for filePathLower field for case-insensitive path filtering
    try {
      await this.client.createPayloadIndex(this.collectionName, {
        field_name: "filePathLower",
        field_schema: "keyword",
      })
    } catch (indexError: any) {
      const errorMessage = (indexError?.message || "").toLowerCase()
      if (!errorMessage.includes("already exists")) {
        console.warn(
          `[QdrantVectorStore] Could not create payload index for filePathLower on ${this.collectionName}. Details:`,
          indexError?.message || indexError,
        )
      }
    }
  }

  /**
   * Upserts points into the vector store
   * @param points Array of points to upsert
   */
  async upsertPoints(
    points: Array<{
      id: string
      vector: number[]
      payload: Record<string, any>
    }>,
  ): Promise<void> {
    try {
      const processedPoints = points.map((point) => {
        if (point.payload?.['filePath']) {
          const filePath = point.payload['filePath']
          const segments = filePath.split(path.sep).filter(Boolean)
          const pathSegments = segments.reduce(
            (acc: Record<string, string>, segment: string, index: number) => {
              acc[index.toString()] = segment
              return acc
            },
            {},
          )

          // Generate segmentHash for content-based identification
          const content = point.payload['codeChunk'] || ''
          const segmentHash = createHash('md5')
            .update(`${filePath}:${point.payload['startLine'] || 0}:${point.payload['endLine'] || 0}:${content}`)
            .digest('hex')

          // Generate deterministic ID based on segmentHash
          const pointId = uuidv5(segmentHash, QDRANT_CODE_BLOCK_NAMESPACE)

          // Validate vector before wrapping
          if (!point.vector || !Array.isArray(point.vector) || point.vector.length === 0) {
            throw new Error(
              `Invalid vector for point ${pointId}: ${typeof point.vector}, ` +
              `length=${(point.vector as any)?.length}, isArray=${Array.isArray(point.vector)}`
            )
          }
          if (point.vector.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
            const badIdx = point.vector.findIndex(v => typeof v !== 'number' || !Number.isFinite(v))
            throw new Error(
              `Non-finite value in vector for point ${pointId}: index ${badIdx}, value=${point.vector[badIdx]}`
            )
          }

          return {
            ...point,
            id: pointId,
            vector: {
              "": point.vector, // Unnamed = dense vector
              "bm25": {
                text: content,
                model: "qdrant/bm25",
              },
            },
            payload: {
              ...point.payload,
              pathSegments,
              segmentHash,
            },
          }
        }
        return point
      })

      // Debug: log first point structure for diagnosis
      if (processedPoints.length > 0) {
        const sample = processedPoints[0]
        const vectorKeys = Object.keys(sample.vector as Record<string, unknown>)
        console.log(
          `[QdrantVectorStore] Upserting ${processedPoints.length} points. ` +
          `Sample point id=${String(sample.id).slice(0, 16)}..., ` +
          `vector keys=[${vectorKeys.join(',')}], ` +
          `vector[\"\"] length=${((sample.vector as any)?.[""] as number[])?.length}, ` +
          `bm25 text length=${String((sample.vector as any)?.["bm25"]?.text || '').length}`
        )
      }

      await this.client.upsert(this.collectionName, {
        points: processedPoints,
        wait: true,
      })
    } catch (error) {
      console.error("Failed to upsert points:", error)
      throw error
    }
  }

  /**
   * Checks if a payload is valid
   * @param payload Payload to check
   * @returns Boolean indicating if the payload is valid
   */
  private isPayloadValid(payload: Record<string, unknown> | null | undefined): payload is Payload {
    if (!payload) {
      return false
    }
    const validKeys = ["filePath", "codeChunk", "startLine", "endLine"]
    const hasValidKeys = validKeys.every((key) => key in payload)
    return hasValidKeys
  }

  /**
   * Searches for similar vectors
   * @param queryVector Vector to search for
   * @param filter Optional search filter options
   * @param hybridOptions Optional hybrid search options (BM25 sparse vector)
   * @returns Promise resolving to search results
   */
    async search(
      queryVector: number[],
      filter?: SearchFilter,
      hybridOptions?: HybridSearchOptions,
    ): Promise<VectorStoreSearchResult[]> {
      try {
        // Build Qdrant filter using PatternCompiler for pathFilters
        let qdrantFilter: any = undefined

        // Use PatternCompiler to compile path filters
        if (filter?.pathFilters && filter.pathFilters.length > 0) {
          qdrantFilter = PatternCompiler.compile(filter.pathFilters)
        }

      // 合并现有的metadata排除
      const metadataExclusion = {
        must_not: [{ key: "type", match: { value: "metadata" } }],
      }

      const finalFilter = qdrantFilter
        ? { ...qdrantFilter, must_not: [...(qdrantFilter.must_not || []), ...metadataExclusion.must_not] }
        : metadataExclusion

      const validatedMinScore = validateMinScore(filter?.minScore)
      const validatedLimit = validateLimit(filter?.limit)

      // Determine whether to use hybrid search (dense + sparse BM25)
      const useHybrid = hybridOptions?.enabled !== false && hybridOptions?.rawQuery

      let searchRequest: any

      if (useHybrid) {
        // Hybrid search: prefetch with dense + sparse (BM25), fused via RRF
        const denseWeight = hybridOptions?.denseWeight ?? 1.0
        const sparseWeight = hybridOptions?.sparseWeight ?? 0.3
        const totalWeight = denseWeight + sparseWeight

        // Allocate limits with enough candidates for RRF fusion.
        // Prefetch must return at least validatedLimit each, otherwise RRF has
        // too few candidates to fill the final limit (Qdrant doc: "prefetches
        // must have a limit of at least limit + offset of the main query").
        const prefetchBase = Math.max(validatedLimit, validatedLimit * 2)
        const denseLimit = Math.max(1, Math.ceil(prefetchBase * denseWeight / totalWeight))
        const sparseLimit = Math.max(1, Math.ceil(prefetchBase * sparseWeight / totalWeight))

        searchRequest = {
            query: { fusion: "rrf" },
            prefetch: [
              {
                query: queryVector,
                using: "", // Unnamed = dense vector
                filter: finalFilter,
                limit: denseLimit,
                params: {
                  hnsw_ef: 128,
                  exact: false,
                },
              },
              {
                query: {
                  text: hybridOptions.rawQuery,
                  model: "qdrant/bm25",
                },
                using: "bm25", // Named = BM25 sparse vector
                filter: finalFilter,
                limit: sparseLimit,
              },
            ],
            limit: validatedLimit,
            // NOTE: score_threshold intentionally omitted for hybrid RRF queries.
            // RRF produces fused scores on a completely different scale than raw
            // cosine similarity, so the configured minScore (typically 0.1-0.4)
            // would incorrectly filter out most results. The final result count
            // is controlled by outer limit anyway.
            with_payload: true,
          }
      } else {
        // Pure dense search (original behavior)
        searchRequest = {
          query: queryVector,
          filter: finalFilter,
          score_threshold: validatedMinScore,
          limit: validatedLimit,
          params: {
            hnsw_ef: 128,
            exact: false,
          },
          with_payload: true,
        }
      }

      const operationResult = await this.client.query(this.collectionName, searchRequest)
      const filteredPoints = operationResult.points.filter((p) => this.isPayloadValid(p.payload))

      return filteredPoints.map((point) => ({
        id: point.id,
        score: point.score,
        payload: point.payload as Payload,
      })) as VectorStoreSearchResult[]
    } catch (error) {
      console.error("Failed to search points:", error)
      throw error
    }
  }

  /**
   * Deletes points by file path
   * @param filePath Path of the file to delete points for
   */
  async deletePointsByFilePath(filePath: string): Promise<void> {
    return this.deletePointsByMultipleFilePaths([filePath])
  }

  async deletePointsByMultipleFilePaths(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) {
      return
    }

    try {
      // First check if the collection exists
      const collectionExists = await this.collectionExists()
      if (!collectionExists) {
        console.warn(
          `[QdrantVectorStore] Skipping deletion - collection "${this.collectionName}" does not exist`,
        )
        return
      }

      const workspaceRoot = this.workspacePath

      // Build filters using pathSegments to match the indexed fields
      const filters = filePaths.map((filePath) => {
        // IMPORTANT: Use the relative path to match what's stored in upsertPoints
        // upsertPoints stores the relative filePath, not the absolute path
        const relativePath = path.isAbsolute(filePath) ? path.relative(workspaceRoot, filePath) : filePath

        // Normalize the relative path
        const normalizedRelativePath = path.normalize(relativePath)

        // Split the path into segments like we do in upsertPoints
        const segments = normalizedRelativePath.split(path.sep).filter(Boolean)

        // Create a filter that matches all segments of the path
        // This ensures we only delete points that match the exact file path
        const mustConditions = segments.map((segment, index) => ({
          key: `pathSegments.${index}`,
          match: { value: segment },
        }))

        return { must: mustConditions }
      })

      // Use 'should' to match any of the file paths (OR condition)
      const filter = filters.length === 1 ? filters[0] : { should: filters }

      await this.client.delete(this.collectionName, {
        filter,
        wait: true,
      })
    } catch (error: any) {
      // Extract more detailed error information
      const errorMessage = error?.message || String(error)
      const errorStatus = error?.status || error?.response?.status || error?.statusCode
      const errorDetails = error?.response?.data || error?.data || ""

      console.error(`[QdrantVectorStore] Failed to delete points by file paths:`, {
        error: errorMessage,
        status: errorStatus,
        details: errorDetails,
        collection: this.collectionName,
        fileCount: filePaths.length,
        // Include first few file paths for debugging (avoid logging too many)
        samplePaths: filePaths.slice(0, 3),
      })
    }
  }

  /**
   * Deletes the entire collection.
   */
  async deleteCollection(): Promise<void> {
    try {
      // Check if collection exists before attempting deletion to avoid errors
      if (await this.collectionExists()) {
        await this.client.deleteCollection(this.collectionName)
      }
    } catch (error) {
      console.error(`[QdrantVectorStore] Failed to delete collection ${this.collectionName}:`, error)
      throw error // Re-throw to allow calling code to handle it
    }
  }

  /**
   * Clears all points from the collection
   */
  async clearCollection(): Promise<void> {
    try {
      await this.client.delete(this.collectionName, {
        filter: {
          must: [],
        },
        wait: true,
      })
    } catch (error) {
      if (this.isCollectionNotFoundError(error)) {
        console.warn(
          `[QdrantVectorStore] clearCollection: collection ${this.collectionName} does not exist, treating as already empty.`,
        )
        return
      }
      console.error("Failed to clear collection:", error)
      throw error
    }
  }

  /**
   * Checks if the collection exists
   * @returns Promise resolving to boolean indicating if the collection exists
   */
  async collectionExists(): Promise<boolean> {
    const collectionInfo = await this.getCollectionInfo()
    return collectionInfo !== null
  }

  async getAllFilePaths(): Promise<string[]> {
    try {
      const allFilePaths = new Set<string>()
      let nextPageOffset: Schemas["ExtendedPointId"] | undefined = undefined

      do {
        const response: Schemas["ScrollResult"] = await this.client.scroll(this.collectionName, {
          limit: 250,
          with_payload: ["filePath"],
          with_vector: false,
          offset: nextPageOffset,
        })

        for (const point of response.points) {
          if (point.payload?.['filePath'] && typeof point.payload['filePath'] === 'string') {
            allFilePaths.add(point.payload['filePath'])
          }
        }

        nextPageOffset = response.next_page_offset as Schemas["ExtendedPointId"] | undefined
      } while (nextPageOffset)

      return Array.from(allFilePaths)
    } catch (error) {
      // console.error("[QdrantVectorStore] Failed to get all file paths:", error)
      // In case of an error (e.g., collection not found), return an empty array
      // This prevents the reconciliation process from accidentally deleting everything
      // if Qdrant is temporarily unavailable.
      return []
    }
  }

  /**
   * Checks if the collection exists and has indexed points
   * @returns Promise resolving to boolean indicating if the collection exists and has points
   */
  async hasIndexedData(): Promise<boolean> {
    try {
      const collectionInfo = await this.getCollectionInfo()
      if (!collectionInfo) {
        return false
      }
      // Check if the collection has any points indexed
      const pointsCount = collectionInfo.points_count ?? 0
      if (pointsCount === 0) {
        return false
      }

      // Check if the indexing completion marker exists
      // Use a deterministic UUID generated from a constant string
      const metadataId = uuidv5("__indexing_metadata__", QDRANT_CODE_BLOCK_NAMESPACE)
      const metadataPoints = await this.client.retrieve(this.collectionName, {
        ids: [metadataId],
      })

      // If marker exists, use it to determine completion status
      if (metadataPoints.length > 0) {
        return metadataPoints[0].payload?.['indexing_complete'] === true
      }

      // Backward compatibility: No marker exists (old index or pre-marker version)
      // Fall back to old logic - assume complete if collection has points
      console.log(
        "[QdrantVectorStore] No indexing metadata marker found. Using backward compatibility mode (checking points_count > 0).",
      )
      return pointsCount > 0
    } catch (error) {
      console.warn("[QdrantVectorStore] Failed to check if collection has data:", error)
      return false
    }
  }

  /**
   * Marks the indexing process as complete by storing metadata
   * Should be called after a successful full workspace scan or incremental scan
   */
  async markIndexingComplete(): Promise<void> {
    try {
      // Create a metadata point with a deterministic UUID to mark indexing as complete
      // Use uuidv5 to generate a consistent UUID from a constant string
      const metadataId = uuidv5("__indexing_metadata__", QDRANT_CODE_BLOCK_NAMESPACE)

      await this.client.upsert(this.collectionName, {
        points: [
          {
            id: metadataId,
            vector: new Array(this.vectorSize).fill(0),
            payload: {
              type: "metadata",
              indexing_complete: true,
              completed_at: Date.now(),
            },
          },
        ],
        wait: true,
      })
      console.log("[QdrantVectorStore] Marked indexing as complete")
    } catch (error) {
      if (this.isCollectionNotFoundError(error)) {
        console.warn(
          `[QdrantVectorStore] markIndexingComplete: collection ${this.collectionName} does not exist, skipping metadata update.`,
        )
        return
      }
      console.error("[QdrantVectorStore] Failed to mark indexing as complete:", error)
      throw error
    }
  }

  /**
   * Marks the indexing process as incomplete by storing metadata
   * Should be called at the start of indexing to indicate work in progress
   */
  async markIndexingIncomplete(): Promise<void> {
    try {
      // Create a metadata point with a deterministic UUID to mark indexing as incomplete
      // Use uuidv5 to generate a consistent UUID from a constant string
      const metadataId = uuidv5("__indexing_metadata__", QDRANT_CODE_BLOCK_NAMESPACE)

      await this.client.upsert(this.collectionName, {
        points: [
          {
            id: metadataId,
            vector: new Array(this.vectorSize).fill(0),
            payload: {
              type: "metadata",
              indexing_complete: false,
              started_at: Date.now(),
            },
          },
        ],
        wait: true,
      })
      console.log("[QdrantVectorStore] Marked indexing as incomplete (in progress)")
    } catch (error) {
      if (this.isCollectionNotFoundError(error)) {
        console.warn(
          `[QdrantVectorStore] markIndexingIncomplete: collection ${this.collectionName} does not exist, skipping metadata update.`,
        )
        return
      }
      console.error("[QdrantVectorStore] Failed to mark indexing as incomplete:", error)
      throw error
    }
  }
}
