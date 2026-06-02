/**
 * Sticky pro session store — remembers that a *conversation prefix* escalated
 * to pro, so subsequent requests sharing the same message prefix skip the
 * flash round-trip and go directly to pro.
 *
 * ## How it works
 *
 * When a flash request escalates (model emitted `<<<NEEDS_PRO>>>`), we store
 * a fingerprint of the request's messages (excluding the last user turn) as
 * the "prefix". Any future request whose messages START with this prefix will
 * match and be dispatched directly to the pro model:
 *
 * ```
 * Round 1:  messages = [sys, user_q1]
 *               ↓ upgrade to pro
 *               ↓ fingerprint([sys, user_q1]) → stored as pro
 *
 * Round 2:  messages = [sys, user_q1, asst_a1, user_q2]
 *               ↓ lookup prefixes from longest to shortest
 *               ↓ [sys, user_q1] → HIT! → direct pro
 * ```
 *
 * Each entry has a TTL so idle conversations decay back to flash automatically.
 *
 * ## Thread safety
 *
 * The store is single-threaded (Node.js event loop). No locks needed.
 */

import { createHash } from 'node:crypto'
import type { ChatCompletionMessage } from './contract'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StickyEntry {
  model: 'pro'
  expiresAt: number
}

export interface StickyStoreOptions {
  /** TTL in milliseconds (default 5 min). */
  ttlMs: number
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

const DEFAULT_CONTENT_CHARS = 200

/**
 * Produce a stable hash for a slice of messages.
 * Only `role` and the first ~200 chars of each `content` string are used;
 * tool/function payloads are ignored for fingerprint stability.
 */
function fingerprintMessages(msgs: ChatCompletionMessage[]): string {
  const simplified = msgs.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content.slice(0, DEFAULT_CONTENT_CHARS)
        : '',
  }))
  const json = JSON.stringify(simplified)
  return createHash('sha256').update(json).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class StickyStore {
  private store = new Map<string, StickyEntry>()
  private readonly ttlMs: number
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts?: StickyStoreOptions) {
    this.ttlMs = opts?.ttlMs ?? 300_000 // default 5 min
  }

  // ---- lookup ----

  /**
   * Walk the messages from longest prefix to shortest.
   * Return `'pro'` if any prefix matches an unexpired entry.
   */
  lookup(messages: ChatCompletionMessage[]): 'pro' | null {
    const now = Date.now()
    // Walk from longest prefix (messages - 1) down to length 1.
    for (let i = messages.length - 1; i >= 1; i--) {
      const key = fingerprintMessages(messages.slice(0, i))
      const entry = this.store.get(key)
      if (!entry) continue
      if (now < entry.expiresAt) {
        return entry.model
      }
      // Expired — clean up.
      this.store.delete(key)
    }
    return null
  }

  // ---- store ----

  /**
   * Record that a given message history escalated to pro.
   * The prefix is everything EXCEPT the last message (the most recent user
   * turn that triggered the escalation).
   */
  storeUpgrade(messages: ChatCompletionMessage[]): void {
    // Need at least 2 messages (e.g. system + user) to form a prefix of length >= 1.
    if (messages.length < 2) return
    const prefix = messages.slice(0, -1)
    const key = fingerprintMessages(prefix)
    this.store.set(key, {
      model: 'pro',
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  // ---- clear ----

  /**
   * Remove all prefix entries for a given message history.
   * Called when the pro model downgrades itself.
   */
  clear(messages: ChatCompletionMessage[]): void {
    for (let i = messages.length - 1; i >= 1; i--) {
      const key = fingerprintMessages(messages.slice(0, i))
      this.store.delete(key)
    }
  }

  // ---- maintenance ----

  /**
   * Start a periodic timer to evict expired entries.
   * The timer is `unref()`'d so it doesn't keep the process alive.
   */
  startCleanup(intervalMs: number = 60_000): void {
    if (this.cleanupTimer) return
    this.cleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const [k, v] of this.store) {
        if (now >= v.expiresAt) this.store.delete(k)
      }
    }, intervalMs)
    this.cleanupTimer.unref()
  }

  /** Stop the cleanup timer. */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  // ---- metrics (testing / inspection) ----

  get size(): number {
    return this.store.size
  }

  /** Clear all entries (used in tests). */
  _clearAll(): void {
    this.store.clear()
  }
}
