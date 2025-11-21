import { QdrantClient, Schemas } from "@qdrant/js-client-rest"
import { createHash } from "crypto"
import * as path from "path"
import { getWorkspacePath } from "../../utils/path"
import { IVectorStore, SearchFilter } from "../interfaces/vector-store"
import { Payload, VectorStoreSearchResult } from "../interfaces"
import { MAX_SEARCH_RESULTS, SEARCH_MIN_SCORE, MAX_LIST_FILES_LIMIT } from "../constants"
import { match } from "assert"

/**
 * Qdrant implementation of the vector store interface
 */
export class QdrantVectorStore implements IVectorStore {
	private readonly QDRANT_URL = "http://localhost:6333"
	private readonly vectorSize!: number
	private readonly DISTANCE_METRIC = "Cosine"

	private client: QdrantClient
	private readonly collectionName: string

	/**
	 * Creates a new Qdrant vector store
	 * @param workspacePath Path to the workspace
	 * @param url Optional URL to the Qdrant server
	 * @param apiKey Optional API key for Qdrant authentication
	 */
	constructor(workspacePath: string, url: string, vectorSize: number, apiKey?: string) {
		// For HTTP connections with API key, we need to construct the client in a way
		// that it will send the Authorization header properly
		const fullUrl = url ?? this.QDRANT_URL;

		// Create client options with URL
		const clientOptions: any = {
			url: fullUrl,
		};

		// Add User-Agent header first
		clientOptions.headers = {
			"User-Agent": "Roo-Code",
		};

		// For API key authentication, add both the apiKey option and Authorization header
		// This addresses the issue where the library may not send the Authorization header
		// properly over HTTP connections by ensuring it's explicitly included in requests
		if (apiKey) {
			// Add API key to client options
			clientOptions.apiKey = apiKey;

			// Ensure Authorization header is properly set for cases where the library
			// doesn't automatically add it for HTTP connections
			clientOptions.headers["Authorization"] = `Bearer ${apiKey}`;
		}

		this.client = new QdrantClient(clientOptions);

		// Generate collection name from workspace path
		const hash = createHash("sha256").update(workspacePath).digest("hex");
		this.vectorSize = vectorSize;
		this.collectionName = `ws-${hash.substring(0, 16)}`;
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
					},
				})
				created = true
			} else {
				// Collection exists, check vector size
				const existingVectorSize = collectionInfo.config?.params?.vectors?.size
				if (existingVectorSize === this.vectorSize) {
					created = false // Exists and correct
				} else {
					// Exists but wrong vector size, recreate
					console.warn(
						`[QdrantVectorStore] Collection ${this.collectionName} exists with vector size ${existingVectorSize}, but expected ${this.vectorSize}. Recreating collection.`,
					)
					await this.client.deleteCollection(this.collectionName) // Known to exist
					await this.client.createCollection(this.collectionName, {
						vectors: {
							size: this.vectorSize,
							distance: this.DISTANCE_METRIC,
						},
					})
					created = true
				}
			}



			// Create index for filePath to support range queries for directoryPrefix filtering
			try {
				await this.client.createPayloadIndex(this.collectionName, {
					field_name: "filePath",
					field_schema: "keyword",
				})
			} catch (indexError: any) {
				const errorMessage = (indexError?.message || "").toLowerCase()
				if (!errorMessage.includes("already exists")) {
					console.warn(
						`[QdrantVectorStore] Could not create payload index for filePath on ${this.collectionName}. Details:`,
						indexError?.message || indexError,
					)
				}
			}
			return created
		} catch (error: any) {
			console.error(
				`[QdrantVectorStore] Failed to initialize Qdrant collection "${this.collectionName}":`,
				error?.message || error,
			)
			throw error
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
					const segments = point.payload['filePath'].split(path.sep).filter(Boolean)
					const pathSegments = segments.reduce(
						(acc: Record<string, string>, segment: string, index: number) => {
							acc[index.toString()] = segment
							return acc
						},
						{},
					)
					return {
						...point,
						payload: {
							...point.payload,
							pathSegments,
						},
					}
				}
				return point
			})

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
	 * @param filter Search filter options
	 * @returns Promise resolving to search results
	 */
	async search(
		queryVector: number[],
		filter?: SearchFilter,
	): Promise<VectorStoreSearchResult[]> {
		try {
			const { pathFilters, minScore, limit = MAX_SEARCH_RESULTS } = filter || {}
			let qdrantFilter: any = undefined

			// Build filter based on pathFilters
			if (pathFilters && pathFilters.length > 0) {
				// Use pathFilters - treat all as text patterns that can match any part of file paths
				const shouldConditions = pathFilters.map(pattern => ({
					key: "filePath",
					match: {
						text: pattern.replace(/\\/g, '/'), // Normalize path separators
					}
				}))

				qdrantFilter = {
					should: shouldConditions,
				}
			}

			const searchRequest = {
				query: queryVector,
				filter: qdrantFilter,
				score_threshold: minScore ?? SEARCH_MIN_SCORE,
				limit: limit,
				params: {
					hnsw_ef: 128,
					exact: false,
				},
				with_payload: true,
			}
			console.log("🔍[QdrantVectorStore] Search request:", JSON.stringify({...searchRequest, query:"[query vector]"}))

			const operationResult = await this.client.query(this.collectionName, searchRequest)
			const filteredPoints = operationResult.points.filter((p) => this.isPayloadValid(p.payload))

			return filteredPoints.map(point => ({
				id: point.id,
				score: point.score,
				payload: point.payload as Payload
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
			const filter = {
				should: filePaths.map((filePath) => ({
					key: "filePath",
					match: {
						value: filePath,
					},
				})),
			}

			await this.client.delete(this.collectionName, {
				filter,
				wait: true,
			})
		} catch (error) {
			console.error("Failed to delete points by file paths:", error)
			throw error
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
}
