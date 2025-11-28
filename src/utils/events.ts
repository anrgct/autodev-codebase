/**
 * Event Bus
 * Simple event system using Node.js EventEmitter
 */
import { EventEmitter } from 'events'

export type EventHandler<T = any> = (data: T) => void

export class EventBus<T = any> {
  private emitter: EventEmitter

  constructor(maxListeners: number = 100) {
    this.emitter = new EventEmitter()
    this.emitter.setMaxListeners(maxListeners)
  }

  /**
   * Subscribe to an event
   * Returns an unsubscribe function
   */
  on(event: string, handler: EventHandler<T>): () => void {
    this.emitter.on(event, handler)

    return () => {
      this.emitter.off(event, handler)
    }
  }

  /**
   * Unsubscribe from an event
   */
  off(event: string, handler: EventHandler<T>): void {
    this.emitter.off(event, handler)
  }

  /**
   * Emit an event
   */
  emit(event: string, data: T): void {
    this.emitter.emit(event, data)
  }

  /**
   * Subscribe to an event once
   * Returns an unsubscribe function
   */
  once(event: string, handler: EventHandler<T>): () => void {
    this.emitter.once(event, handler)

    return () => {
      this.emitter.off(event, handler)
    }
  }

  /**
   * Get the number of listeners for an event
   */
  listenerCount(event: string): number {
    return this.emitter.listenerCount(event)
  }

  /**
   * Remove all listeners for an event (or all events if not specified)
   */
  removeAllListeners(event?: string): void {
    this.emitter.removeAllListeners(event)
  }

  /**
   * Get all event names that have listeners
   */
  eventNames(): (string | symbol)[] {
    return this.emitter.eventNames()
  }
}

/**
 * Create a typed event bus instance
 */
export function createEventBus<T = any>(maxListeners?: number): EventBus<T> {
  return new EventBus<T>(maxListeners)
}

/**
 * Global event bus instance (singleton)
 */
let globalEventBus: EventBus | null = null

export function getGlobalEventBus<T = any>(): EventBus<T> {
  if (!globalEventBus) {
    globalEventBus = new EventBus()
  }
  return globalEventBus as EventBus<T>
}
