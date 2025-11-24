import { CodeIndexStateManager, IndexingState } from "../state-manager"
import { IEventBus } from "../../abstractions/core"
import { vi } from "vitest"

describe("CodeIndexStateManager", () => {
	let stateManager: CodeIndexStateManager
	let mockEventBus: IEventBus
	let emittedEvents: Array<{ event: string; data: any }>

	beforeEach(() => {
		emittedEvents = []

		// Create mock event bus
		const eventHandlers = new Map<string, Set<(data: any) => void>>()
		mockEventBus = {
			emit: vi.fn((event: string, data: any) => {
				emittedEvents.push({ event, data })
				const handlers = eventHandlers.get(event)
				if (handlers) {
					handlers.forEach(handler => handler(data))
				}
			}),
			on: vi.fn((event: string, handler: (data: any) => void) => {
				if (!eventHandlers.has(event)) {
					eventHandlers.set(event, new Set())
				}
				eventHandlers.get(event)!.add(handler)
				return () => eventHandlers.get(event)!.delete(handler)
			}),
			off: vi.fn(),
			once: vi.fn(),
		}

		stateManager = new CodeIndexStateManager(mockEventBus)
	})

	describe("constructor", () => {
		it("should initialize with default state", () => {
			expect(stateManager.state).toBe("Standby")
			expect(stateManager.getCurrentStatus()).toEqual({
				systemStatus: "Standby",
				fileStatuses: {},
				message: "",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "blocks",
			})
		})

		it("should set onProgressUpdate property to a function", () => {
			expect(typeof stateManager.onProgressUpdate).toBe("function")
		})
	})

	describe("setSystemState", () => {
		it("should update state and emit progress update", () => {
			stateManager.setSystemState("Indexing", "Starting indexing process")

			expect(stateManager.state).toBe("Indexing")
			expect(mockEventBus.emit).toHaveBeenCalledWith('progress-update', {
				systemStatus: "Indexing",
				fileStatuses: {},
				message: "Starting indexing process",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "blocks",
			})
		})

		it("should set default messages for different states", () => {
			stateManager.setSystemState("Indexed")
			expect(stateManager.getCurrentStatus().message).toBe("Index up-to-date.")

			stateManager.setSystemState("Error")
			expect(stateManager.getCurrentStatus().message).toBe("An error occurred.")

			stateManager.setSystemState("Standby")
			expect(stateManager.getCurrentStatus().message).toBe("Ready.")
		})

		it("should not emit when state doesn't change", () => {
			stateManager.setSystemState("Standby")

			// Clear previous calls
			vi.clearAllMocks()
			emittedEvents = []

			// Set same state again
			stateManager.setSystemState("Standby")

			expect(mockEventBus.emit).not.toHaveBeenCalled()
			expect(emittedEvents).toHaveLength(0)
		})
	})

	describe("reportBlockIndexingProgress", () => {
		it("should update progress and emit progress update", () => {
			stateManager.reportBlockIndexingProgress(5, 10)

			expect(stateManager.state).toBe("Indexing")
			expect(mockEventBus.emit).toHaveBeenCalledWith('progress-update', {
				systemStatus: "Indexing",
				fileStatuses: {},
				message: "Indexed 5 / 10 blocks found",
				processedItems: 5,
				totalItems: 10,
				currentItemUnit: "blocks",
			})
		})
	})

	describe("reportFileQueueProgress", () => {
		it("should update file processing progress", () => {
			stateManager.reportFileQueueProgress(3, 8, "test.js")

			expect(stateManager.state).toBe("Indexing")
			expect(mockEventBus.emit).toHaveBeenCalledWith('progress-update', {
				systemStatus: "Indexing",
				fileStatuses: {},
				message: "Processing 3 / 8 files. Current: test.js",
				processedItems: 3,
				totalItems: 8,
				currentItemUnit: "files",
			})
		})

		it("should handle completion message", () => {
			stateManager.reportFileQueueProgress(5, 5)

			expect(mockEventBus.emit).toHaveBeenCalledWith('progress-update', 
				expect.objectContaining({
					message: "Finished processing 5 files from queue.",
				})
			)
		})
	})

	describe("onProgressUpdate", () => {
		it("should allow subscribing to progress updates", () => {
			const mockHandler = vi.fn()
			const unsubscribe = stateManager.onProgressUpdate(mockHandler)

			stateManager.setSystemState("Indexing", "Test message")

			expect(mockHandler).toHaveBeenCalledWith({
				systemStatus: "Indexing",
				fileStatuses: {},
				message: "Test message",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "blocks",
			})

			// Test unsubscribe
			expect(typeof unsubscribe).toBe("function")
		})
	})

	describe("dispose", () => {
		it("should dispose without throwing", () => {
			expect(() => stateManager.dispose()).not.toThrow()
		})
	})
})