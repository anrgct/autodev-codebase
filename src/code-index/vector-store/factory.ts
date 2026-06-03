import { IVectorStore } from "../interfaces/vector-store"
import { CodeIndexConfig } from "../interfaces/config"
import { QdrantVectorStore } from "./qdrant-client"
import { SQLiteVectorStore } from "./sqlite-store"
import { Logger } from "../../utils/logger"

type LoggerLike = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

/**
 * Resolve which vector store backend the caller wants, applying the
 * documented fallback rules:
 *
 *   1. Explicit `vectorStoreBackend` value wins.
 *   2. Otherwise, if a `qdrantUrl` is set, default to "qdrant" (legacy
 *      behaviour: a pre-existing user with a Qdrant URL in their config
 *      should not silently switch to SQLite).
 *   3. Otherwise, default to "sqlite" (the new zero-config default).
 */
export function resolveVectorStoreBackend(config: Pick<CodeIndexConfig, 'vectorStoreBackend' | 'qdrantUrl'>): 'qdrant' | 'sqlite' {
  const explicit = config.vectorStoreBackend
  if (explicit === 'qdrant' || explicit === 'sqlite') {
    return explicit
  }
  if (config.qdrantUrl) {
    return 'qdrant'
  }
  return 'sqlite'
}

/**
 * Factory that produces an `IVectorStore` from the current configuration.
 * The orchestrator (and tests) call this instead of `new`-ing a backend
 * directly so that the backend choice lives in exactly one place.
 *
 * Both backends are required to be import-safe; the Qdrant client only
 * touches `@qdrant/js-client-rest` when its `initialize()` runs, and the
 * SQLite store only loads `better-sqlite3` + `sqlite-vec` when the
 * sqlite backend is selected. That keeps the cost of unused backends at
 * near-zero (just an import + a class definition).
 */
export function createVectorStore(
  config: CodeIndexConfig,
  workspacePath: string,
  vectorSize: number,
  embedderProvider: string,
  embedderModelId: string,
  logger?: LoggerLike,
): IVectorStore {
  const backend = resolveVectorStoreBackend(config)

  switch (backend) {
    case 'qdrant': {
      if (!config.qdrantUrl) {
        throw new Error(
          'Qdrant vector store backend selected but no qdrantUrl is configured. ' +
          'Either set qdrantUrl or switch vectorStoreBackend to "sqlite".'
        )
      }
      // QdrantVectorStore's constructor is overloaded — pass the URL
      // first (the legacy shape) so existing callers and tests do not
      // need updating. New code should treat this factory as the only
      // entry point.
      return new QdrantVectorStore(
        workspacePath,
        config.qdrantUrl,
        vectorSize,
        config.qdrantApiKey,
        logger,
        embedderProvider,
        embedderModelId,
      )
    }
    case 'sqlite':
      return new SQLiteVectorStore(workspacePath, vectorSize, embedderProvider, embedderModelId, logger)
    default: {
      const exhaustive: never = backend
      throw new Error(`Unknown vector store backend: ${exhaustive as string}`)
    }
  }
}
