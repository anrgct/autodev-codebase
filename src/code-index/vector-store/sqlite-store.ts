import Database from "better-sqlite3"
import { createHash } from "crypto"
import * as os from "os"
import * as path from "path"
import * as fs from "fs"
import { getLoadablePath } from "sqlite-vec"
import {
  IVectorStore,
  PointStruct,
  SearchFilter,
  HybridSearchOptions,
  VectorStoreSearchResult,
} from "../interfaces/vector-store"
import { Payload } from "../interfaces"
import { validateLimit, validateMinScore } from "../validate-search-params"
import { Logger } from "../../utils/logger"
import { compilePathFilters, compilePathFiltersToSql } from "./path-filter"

type LoggerLike = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

// Internal statement set used by `SQLiteVectorStore`. Typed as a single
// shape (rather than `Record<string, Statement>`) so the
// `noPropertyAccessFromIndexSignature` rule lets us use `stmt.foo`.
// Adding a new statement is a one-liner here.
interface PreparedStatements {
  insertChunk: Database.Statement
  lookupRowid: Database.Statement
  insertVec: Database.Statement
  deleteById: Database.Statement
  deleteChunk: Database.Statement
  deleteVec: Database.Statement
  getMeta: Database.Statement
  upsertMeta: Database.Statement
  getAllFilePaths: Database.Statement
  countChunks: Database.Statement
}

/**
 * Default base location for SQLite-backed vector stores.
 * Lives under the existing `~/.autodev-cache/` cache root so the data sits
 * next to the other autodev caches (summary-cache, dependency-cache, etc.).
 */
const DEFAULT_CACHE_BASE = path.join(os.homedir(), '.autodev-cache', 'vector-store')

/**
 * Overfetch multiplier used by the KNN path: when a path-filter is active,
 * we overfetch this many times the requested limit, then post-filter, then
 * RRF-fuse. The Qdrant backend has native pre-filter so it does not need
 * this — sqlite-vec 0.1.x does not.
 */
const DEFAULT_OVERFETCH = 5

/**
 * Bind a `Float32Array` (or plain number array) of vector dimensions into the
 * binary blob form sqlite-vec expects: `dim` little-endian float32 values,
 * with no length prefix. The vec0 virtual table infers the dimension from
 * the column schema (`float[N]`) and the row's blob length; the blob must
 * be exactly N * 4 bytes. (Earlier versions of this code included a 4-byte
 * dim prefix, which sqlite-vec reads as an extra value, producing the
 * "received 17 instead of 16" error.)
 */
function vectorToBlob(vec: ArrayLike<number>): Buffer {
  const dim = vec.length
  const buf = Buffer.alloc(dim * 4)
  for (let i = 0; i < dim; i++) {
    buf.writeFloatLE(vec[i], i * 4)
  }
  return buf
}

/**
 * Local SQLite implementation of the `IVectorStore` interface.
 *
 * Storage layout:
 *   ~/.autodev-cache/vector-store/{workspaceHash}/index.db
 *
 * Tables:
 *   - chunks         — original payload (file_path, code_chunk, line range, segment_hash, file_path_lower)
 *   - vec_chunks     — sqlite-vec virtual table over the embedding (cosine distance)
 *   - fts_chunks     — FTS5 virtual table with content=chunks (no text duplication)
 *   - indexing_meta  — singleton row tracking completeness + embedding_dim
 *
 * Hybrid search uses RRF fusion over dense KNN + BM25 FTS ranks, identical
 * shape to the Qdrant backend. Path filters are applied as a post-filter on
 * the KNN results (sqlite-vec has no pre-filter support), using the shared
 * PathFilter compiler for glob semantics parity with Qdrant.
 */
export class SQLiteVectorStore implements IVectorStore {
  private readonly workspacePath: string
  private readonly vectorSize: number
  private readonly embedderProvider: string
  private readonly embedderModelId: string
  private readonly logger: LoggerLike

  private db: Database.Database | null = null
  private readonly dbPath: string
  private readonly collectionName: string

  // Pre-compiled statements; recreated in `initialize()`.
  private stmt!: PreparedStatements

  /**
   * @param workspacePath absolute path to the workspace root (used for the
   *   collection name and the on-disk location)
   * @param vectorSize embedding dimension (must match what the embedder
   *   actually produces; otherwise the schema is dropped and rebuilt on
   *   `initialize()`)
   * @param logger optional logger
   * @param dbPath override the on-disk `.db` path. Used by tests so they
   *   can point at a tmpdir. Production callers should leave this unset.
   */
  constructor(
    workspacePath: string,
    vectorSize: number,
    embedderProvider: string,
    embedderModelId: string,
    logger?: LoggerLike,
    dbPath?: string,
  ) {
    this.workspacePath = workspacePath
    this.vectorSize = vectorSize
    this.embedderProvider = embedderProvider
    this.embedderModelId = embedderModelId
    this.logger = logger ?? new Logger({ name: 'SQLiteVectorStore' })

    const hash = createHash("sha256").update(workspacePath).digest("hex")
    this.collectionName = `ws-${hash.substring(0, 16)}`

    this.dbPath = dbPath ?? path.join(DEFAULT_CACHE_BASE, this.collectionName, 'index.db')
  }

  /** Where the SQLite file lives on disk. Useful for debugging. */
  public getDbPath(): string {
    return this.dbPath
  }

  /** Workspace-derived collection identifier. Same shape as the Qdrant one. */
  public getCollectionName(): string {
    return this.collectionName
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async initialize(): Promise<boolean> {
    this._ensureDir()

    // Open the database file. If the dimension stored in the previous
    // session's `indexing_meta` no longer matches the configured one, we
    // drop every table and rebuild from scratch — the dimension is encoded
    // into the sqlite-vec schema, so we have no other option.
    const db = new Database(this.dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('busy_timeout = 5000')
    db.pragma('cache_size = -32000')
    db.pragma('mmap_size = 268435456')
    db.pragma('temp_store = MEMORY')

    this._loadVectorExtension(db)

    // Migrate schema for existing databases that don't have the new columns
    this._ensureMetaSchema(db)

    const existingDim = this._readEmbeddingDim(db)
    let created = false

    if (existingDim !== null && existingDim !== this.vectorSize) {
      this.logger.warn(
        `Embedding dimension changed (${existingDim} → ${this.vectorSize}). ` +
        `Dropping existing vector store and rebuilding.`
      )
      this._dropAllTables(db)
      created = true
    } else if (existingDim !== null) {
      // Check for embedder provider/model change (only when dimension didn't
      // already trigger a rebuild). Different providers/models may produce
      // vectors with the same dimension but fundamentally different embedding
      // spaces — the old vectors would produce garbage search results.
      const existingProvider = this._readMetaString(db, 'embedder_provider')
      if (existingProvider !== null && existingProvider !== this.embedderProvider) {
        this.logger.warn(
          `Embedder provider changed (${existingProvider} → ${this.embedderProvider}). ` +
          `Dropping existing vector store and rebuilding.`
        )
        this._dropAllTables(db)
        created = true
      } else {
        const existingModelId = this._readMetaString(db, 'embedder_model_id')
        if (existingModelId !== null && existingModelId !== this.embedderModelId) {
          this.logger.warn(
            `Embedder model changed (${existingModelId} → ${this.embedderModelId}). ` +
            `Dropping existing vector store and rebuilding.`
          )
          this._dropAllTables(db)
          created = true
        } else if (!this._ftsSchemaIsCurrent(db)) {
          // The dimension is right but the FTS5 schema is from an older
          // version. The external-content column name is bound at CREATE
          // VIRTUAL TABLE time and cannot be altered in place — we have to
          // drop and rebuild. Hit by the v1→v2 migration: fts_chunks.column
          // was renamed from `content` to `code_chunk` to match the source
          // table column name (the original mismatch left docsize at 0 and
          // every BM25 query returning 0 rows).
          this.logger.warn(
            `FTS5 schema is out of date. Dropping and rebuilding to apply the latest schema.`,
          )
          this._dropAllTables(db)
          created = true
        }
      }
    }

    if (!this._tablesExist(db)) {
      this._createSchema(db)
      created = true
    }

    // Insert/update the meta row with the current provider and model info.
    // This is the analogue of Qdrant's `type=metadata` marker point but
    // lives in a dedicated table so it never pollutes search results.
    this._ensureMetaRow(db, this.vectorSize)

    this.db = db
    this._prepareStatements()

    if (created) {
      this.logger.info(
        `[SQLiteVectorStore] Collection initialized (new). dimension=${this.vectorSize}, ` +
        `provider=${this.embedderProvider}, model=${this.embedderModelId}`
      )
    } else {
      this.logger.debug(
        `[SQLiteVectorStore] Collection opened (existing). dimension=${this.vectorSize}, ` +
        `provider=${this.embedderProvider}`
      )
    }

    return created
  }

  /**
   * Open the sqlite-vec extension. We call this before any DDL/DML so the
   * `vec0` virtual table module is registered. The library throws on
   * unsupported platforms (linux x64, darwin arm64/x64, win32 x64) — we
   * surface that as a clear error to the caller.
   */
  private _loadVectorExtension(db: Database.Database): void {
    try {
      const extPath = getLoadablePath()
      db.loadExtension(extPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to load sqlite-vec extension for SQLiteVectorStore: ${msg}. ` +
        `Supported platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64.`
      )
    }
  }

  /**
   * Add `embedder_provider` and `embedder_model_id` columns to the
   * `indexing_meta` table for databases created before v1.x that only
   * had `embedding_dim`. Safe to call repeatedly — ALTER TABLE ADD COLUMN
   * is a no-op if the column already exists (we catch the error).
   */
  private _ensureMetaSchema(db: Database.Database): void {
    for (const col of ['embedder_provider', 'embedder_model_id']) {
      try {
        db.exec(`ALTER TABLE indexing_meta ADD COLUMN ${col} TEXT`)
      } catch {
        // Column already exists
      }
    }
  }

  /** Read the embedding dimension persisted in `indexing_meta`, or null if absent. */
  private _readEmbeddingDim(db: Database.Database): number | null {
    try {
      const row = db.prepare('SELECT embedding_dim FROM indexing_meta WHERE id = 1').get() as
        | { embedding_dim: number | null }
        | undefined
      if (!row || row.embedding_dim === null || row.embedding_dim === undefined) {
        return null
      }
      return row.embedding_dim
    } catch {
      // Table doesn't exist yet — first run.
      return null
    }
  }

  /**
   * Read a TEXT column from `indexing_meta` safely. Returns null if the
   * column doesn't exist (old schema before migration) or the value is
   * NULL / missing.
   */
  private _readMetaString(db: Database.Database, column: string): string | null {
    try {
      const row = db.prepare(
        `SELECT ${column} FROM indexing_meta WHERE id = 1`
      ).get() as Record<string, unknown> | undefined
      if (!row || row[column] === null || row[column] === undefined) return null
      return String(row[column])
    } catch {
      return null
    }
  }

  /** Insert/update the singleton row with current dimension, provider and model. Safe to call repeatedly. */
  private _ensureMetaRow(db: Database.Database, embeddingDim: number): void {
    // By the time we reach here, the `indexing_meta` table is guaranteed to
    // exist — either it was already present (with `embedder_provider` and
    // `embedder_model_id` columns added by `_ensureMetaSchema`), or
    // `_createSchema` just created it with the full schema.  The simple
    // upsert below is therefore always sufficient and the previous
    // try/catch fallback was unreachable dead code.
    db.prepare(`
      INSERT INTO indexing_meta(id, complete, embedding_dim, embedder_provider, embedder_model_id)
      VALUES (1, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        embedding_dim=excluded.embedding_dim,
        embedder_provider=excluded.embedder_provider,
        embedder_model_id=excluded.embedder_model_id
    `).run(embeddingDim, this.embedderProvider, this.embedderModelId)
  }

  /** Cheap probe: do our three core tables already exist? */
  private _tablesExist(db: Database.Database): boolean {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table') AND name IN ('chunks', 'indexing_meta')"
    ).get()
    return !!row
  }

  /**
   * Verify the FTS5 schema matches the current code: the first column of
   * `fts_chunks` must be named `code_chunk` (matching the source table
   * column) so that the external-content lookup works. If a rowid's
   * `code_chunk` is empty, the FTS5 external-content mapping is broken
   * and every BM25 query returns 0 rows.
   */
  private _ftsSchemaIsCurrent(db: Database.Database): boolean {
    try {
      const row = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fts_chunks'",
      ).get() as { sql: string } | undefined
      if (!row) return false
      // The CREATE VIRTUAL TABLE statement lists columns before options.
      // The first listed column is the one FTS5 will read from the
      // content table — it must be named `code_chunk`.
      return /\(\s*code_chunk\b/.test(row.sql)
    } catch {
      return false
    }
  }

  /** Drop every table this class owns. Used for the dimension-mismatch path. */
  private _dropAllTables(db: Database.Database): void {
    db.exec(`
      DROP TRIGGER IF EXISTS chunks_ai;
      DROP TRIGGER IF EXISTS chunks_ad;
      DROP TRIGGER IF EXISTS chunks_au;
      DROP TABLE IF EXISTS fts_chunks;
      DROP TABLE IF EXISTS vec_chunks;
      DROP TABLE IF EXISTS chunks;
      DROP TABLE IF EXISTS indexing_meta;
    `)
  }

  /** Create the full schema (chunks, vec_chunks, fts_chunks, indexing_meta + triggers). */
  private _createSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        file_path TEXT NOT NULL,
        code_chunk TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        segment_hash TEXT NOT NULL,
        file_path_lower TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_id ON chunks(id);
      CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_file_path_lower ON chunks(file_path_lower);

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        embedding float[${this.vectorSize}] distance_metric=cosine
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
        code_chunk,
        file_path UNINDEXED,
        content='chunks',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2 tokenchars ''_.$'''
      );

      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO fts_chunks(rowid, code_chunk, file_path) VALUES (new.rowid, new.code_chunk, new.file_path);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO fts_chunks(fts_chunks, rowid, code_chunk, file_path) VALUES('delete', old.rowid, old.code_chunk, old.file_path);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO fts_chunks(fts_chunks, rowid, code_chunk, file_path) VALUES('delete', old.rowid, old.code_chunk, old.file_path);
        INSERT INTO fts_chunks(rowid, code_chunk, file_path) VALUES (new.rowid, new.code_chunk, new.file_path);
      END;

      CREATE TABLE IF NOT EXISTS indexing_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        complete INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER,
        started_at INTEGER,
        embedding_dim INTEGER,
        embedder_provider TEXT,
        embedder_model_id TEXT
      );
    `)
  }

  private _prepareStatements(): void {
    const db = this.db!
    this.stmt = {
      // Order matters in upsertPoints: chunks first, then vec_chunks. The
      // FTS5 index is kept in sync by the chunks triggers, so we do not
      // touch fts_chunks here.
      // We use ON CONFLICT(id) so an existing row's rowid is preserved —
      // sqlite-vec's KNN is keyed on rowid, so we cannot churn rowids on
      // updates. The rowid is captured separately via lastInsertRowid /
      // a follow-up SELECT so the binding type matches what vec_chunks
      // expects (a plain integer).
      insertChunk: db.prepare(`
        INSERT INTO chunks (id, file_path, code_chunk, start_line, end_line, segment_hash, file_path_lower)
        VALUES (@id, @filePath, @codeChunk, @startLine, @endLine, @segmentHash, @filePathLower)
        ON CONFLICT(id) DO UPDATE SET
          file_path=excluded.file_path,
          code_chunk=excluded.code_chunk,
          start_line=excluded.start_line,
          end_line=excluded.end_line,
          segment_hash=excluded.segment_hash,
          file_path_lower=excluded.file_path_lower
      `),
      lookupRowid: db.prepare(`SELECT rowid FROM chunks WHERE id = ?`),
      // Cast ? to INTEGER because better-sqlite3 binds JS Numbers as REAL,
      // and sqlite-vec insists on an integer primary key. A cast keeps the
      // parameter binding ergonomic (Number) while satisfying the type
      // check.
      insertVec: db.prepare(`
        INSERT OR REPLACE INTO vec_chunks (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)
      `),
      deleteById: db.prepare(`DELETE FROM chunks WHERE id = ?`),
      deleteChunk: db.prepare(`DELETE FROM chunks WHERE rowid = CAST(? AS INTEGER)`),
      deleteVec: db.prepare(`DELETE FROM vec_chunks WHERE rowid = CAST(? AS INTEGER)`),
      getMeta: db.prepare(`SELECT complete, completed_at, started_at, embedding_dim FROM indexing_meta WHERE id = 1`),
      upsertMeta: db.prepare(`
        INSERT INTO indexing_meta(id, complete, completed_at, started_at, embedding_dim)
        VALUES (1, @complete, @completed_at, @started_at, @embedding_dim)
        ON CONFLICT(id) DO UPDATE SET
          complete=excluded.complete,
          completed_at=excluded.completed_at,
          started_at=excluded.started_at,
          embedding_dim=excluded.embedding_dim
      `),
      getAllFilePaths: db.prepare(`SELECT DISTINCT file_path FROM chunks`),
      countChunks: db.prepare(`SELECT COUNT(*) AS c FROM chunks`),
    }
  }

  private _ensureOpen(): Database.Database {
    if (!this.db) {
      throw new Error('SQLiteVectorStore used before initialize()')
    }
    return this.db
  }

  private _ensureDir(): void {
    const dir = path.dirname(this.dbPath)
    fs.mkdirSync(dir, { recursive: true })
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  IVectorStore — CRUD
  // ─────────────────────────────────────────────────────────────────────────

  async upsertPoints(points: PointStruct[]): Promise<void> {
    if (points.length === 0) return
    const db = this._ensureOpen()

    const insertAll = db.transaction((rows: PointStruct[]) => {
      for (const p of rows) {
        const filePath = p.payload?.['filePath']
        if (!filePath) {
          throw new Error(`Point ${p.id} missing filePath payload`)
        }
        const codeChunk: string = p.payload['codeChunk'] ?? ''
        const startLine: number = p.payload['startLine'] ?? 0
        const endLine: number = p.payload['endLine'] ?? 0
        const segmentHash: string = p.payload['segmentHash'] ?? String(p.id)
        const filePathLower = filePath.toLowerCase()

        this.stmt.insertChunk.run({
          id: String(p.id),
          filePath,
          codeChunk,
          startLine,
          endLine,
          segmentHash,
          filePathLower,
        })
        // Resolve the rowid for the (possibly updated) chunks row. We use
        // a SELECT instead of RETURNING so the binding comes back as a
        // plain number — better-sqlite3's BigInt mode otherwise hands us
        // a BigInt, and sqlite-vec insists on a regular int.
        const row = this.stmt.lookupRowid.get(String(p.id)) as { rowid: number }
        this.stmt.insertVec.run(row.rowid, vectorToBlob(p.vector))
      }
    })

    try {
      insertAll(points)
    } catch (err) {
      this.logger.error('SQLiteVectorStore.upsertPoints failed', err)
      throw err
    }
  }

  async deletePointsByFilePath(filePath: string): Promise<void> {
    return this.deletePointsByMultipleFilePaths([filePath])
  }

  async deletePointsByMultipleFilePaths(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return
    const db = this._ensureOpen()

    // Match on the stored (case-sensitive) file_path. We do not normalise
    // to a relative path here — the caller's stored payload already is the
    // relative path. The Qdrant backend does the same normalisation in its
    // own filter; we rely on the caller to pass the same key it passed at
    // upsert time.
    const placeholders = filePaths.map(() => '?').join(',')
    const ids = db
      .prepare(`SELECT rowid FROM chunks WHERE file_path IN (${placeholders})`)
      .all(...filePaths) as { rowid: number }[]

    if (ids.length === 0) return

    const del = db.transaction((rows: { rowid: string | number }[]) => {
      for (const { rowid } of rows) {
        this.stmt.deleteChunk.run(rowid)
        this.stmt.deleteVec.run(rowid)
      }
    })
    del(ids)
  }

  async clearCollection(): Promise<void> {
    const db = this._ensureOpen()
    const clear = db.transaction(() => {
      db.exec('DELETE FROM vec_chunks; DELETE FROM chunks;')
      // FTS5 external content table is repopulated by the AFTER DELETE
      // triggers on `chunks`, so deleting from `chunks` is enough.
      db.prepare('UPDATE indexing_meta SET complete = 0 WHERE id = 1').run()
    })
    clear()
  }

  async deleteCollection(): Promise<void> {
    if (this.db) {
      this._dropAllTables(this.db)
      this.db.close()
      this.db = null
    }
    // Remove the file and any -wal/-shm sidecars so a re-initialize is
    // a clean slate.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const p = this.dbPath + suffix
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p)
        } catch (err) {
          this.logger.warn(`Failed to remove ${p}: ${(err as Error).message}`)
        }
      }
    }
  }

  async collectionExists(): Promise<boolean> {
    return fs.existsSync(this.dbPath) && this._tablesExist(this._ensureOpen())
  }

  async getAllFilePaths(): Promise<string[]> {
    // If the store has not been initialised yet (e.g. reconcileIndex
    // runs before startIndexing), behave like the Qdrant backend and
    // return an empty list — there is nothing in the index to reconcile.
    if (!this.db) return []
    try {
      const rows = this.stmt.getAllFilePaths.all() as { file_path: string }[]
      return rows.map((r) => r.file_path)
    } catch (err) {
      // Mirror the Qdrant `getAllFilePaths` policy: any read error
      // (missing table, locked db, …) is treated as "no data" so the
      // reconciler does not mistakenly delete real files.
      this.logger.warn(`getAllFilePaths failed, returning []: ${(err as Error).message}`)
      return []
    }
  }

  async hasIndexedData(): Promise<boolean> {
    // Same defensive posture as `getAllFilePaths`: before initialise
    // we have no data to report. Returning false (instead of throwing)
    // keeps callers like reconcileIndex / hasIndexedData from blowing up
    // when the orchestrator is set up but the store has not been
    // opened yet.
    if (!this.db) return false
    try {
      const meta = this.stmt.getMeta.get() as
        | { complete: number; completed_at: number | null; started_at: number | null; embedding_dim: number | null }
        | undefined

      if (!meta) return false

      // Backward-compat: if the meta row is missing the explicit `complete`
      // flag, fall back to the chunk count.
      const count = (this.stmt.countChunks.get() as { c: number }).c
      if (count === 0) return false
      if (meta.complete === 1) return true
      // Schema was created with the new field; if complete is 0 we have data
      // but indexing is not finished. Treat that as "has data" so the
      // orchestrator can decide whether to keep going or rebuild.
      return true
    } catch (err) {
      this.logger.warn(`hasIndexedData failed, returning false: ${(err as Error).message}`)
      return false
    }
  }

  async markIndexingComplete(): Promise<void> {
    const db = this._ensureOpen()
    this.stmt.upsertMeta.run({
      complete: 1,
      completed_at: Date.now(),
      started_at: null,
      embedding_dim: this.vectorSize,
    })
    this.logger.info('Marked indexing as complete')
  }

  async markIndexingIncomplete(): Promise<void> {
    const db = this._ensureOpen()
    this.stmt.upsertMeta.run({
      complete: 0,
      completed_at: null,
      started_at: Date.now(),
      embedding_dim: this.vectorSize,
    })
    this.logger.info('Marked indexing as incomplete (in progress)')
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  IVectorStore — search (the hard one)
  // ─────────────────────────────────────────────────────────────────────────

  async search(
    queryVector: number[],
    filter?: SearchFilter,
    hybridOptions?: HybridSearchOptions,
  ): Promise<VectorStoreSearchResult[]> {
    const db = this._ensureOpen()
    const validatedMinScore = validateMinScore(filter?.minScore)
    const validatedLimit = validateLimit(filter?.limit)
    const useHybrid = hybridOptions?.enabled !== false && !!hybridOptions?.rawQuery

    const compiled = compilePathFilters(filter?.pathFilters)
    const pathSql = compilePathFiltersToSql(compiled)

    if (useHybrid) {
      return this._hybridSearch(db, queryVector, hybridOptions!.rawQuery!, {
        denseWeight: hybridOptions?.denseWeight ?? 1.0,
        sparseWeight: hybridOptions?.sparseWeight ?? 0.3,
        limit: validatedLimit,
        pathSql: pathSql.sql,
        pathParams: pathSql.params,
        minScore: validatedMinScore,
      })
    }

    return this._denseSearch(db, queryVector, {
      limit: validatedLimit,
      pathSql: pathSql.sql,
      pathParams: pathSql.params,
      minScore: validatedMinScore,
    })
  }

  // ── dense-only path (mirror of the Qdrant `score_threshold` branch) ──

  private _denseSearch(
    db: Database.Database,
    queryVector: number[],
    opts: { limit: number; pathSql: string; pathParams: string[]; minScore: number },
  ): VectorStoreSearchResult[] {
    // KNN with overfetch, then post-filter on path, then slice.
    const overfetch = Math.max(opts.limit * DEFAULT_OVERFETCH, opts.limit + 1)
    const knnRows = db.prepare(`
      SELECT rowid, distance
      FROM vec_chunks
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(vectorToBlob(queryVector), overfetch) as { rowid: string | number; distance: number }[]

    if (knnRows.length === 0) return []

    const rowids = knnRows.map((r) => r.rowid)
    const placeholders = rowids.map(() => '?').join(',')
    const payloadRows = db.prepare(`
      SELECT rowid, id, file_path AS filePath, code_chunk AS codeChunk,
             start_line AS startLine, end_line AS endLine, segment_hash AS segmentHash
      FROM chunks
      WHERE rowid IN (${placeholders}) AND ${opts.pathSql}
    `).all(...rowids, ...opts.pathParams) as Array<{
      rowid: string | number
      id: string
      filePath: string
      codeChunk: string
      startLine: number
      endLine: number
      segmentHash: string
    }>

    const payloadByRowid = new Map<string | number, typeof payloadRows[number]>()
    for (const r of payloadRows) payloadByRowid.set(r.rowid, r)

    const out: VectorStoreSearchResult[] = []
    for (const { rowid, distance } of knnRows) {
      const payload = payloadByRowid.get(rowid)
      if (!payload) continue // excluded by path filter
      // distance_metric=cosine returns distance in [0, 2]. Normalise to
      // a "score" in [0, 1] so the caller's minScore (typically 0.1-0.4)
      // behaves the same as it did against Qdrant.
      const score = 1 - distance
      if (score < opts.minScore) continue
      out.push({
        id: payload.id,
        score,
        payload: {
          filePath: payload.filePath,
          codeChunk: payload.codeChunk,
          startLine: payload.startLine,
          endLine: payload.endLine,
          segmentHash: payload.segmentHash,
        } as Payload,
      })
      if (out.length >= opts.limit) break
    }
    return out
  }

  // ── hybrid (RRF) path (mirror of the Qdrant `fusion: "rrf"` branch) ──

  private _hybridSearch(
    db: Database.Database,
    queryVector: number[],
    rawQuery: string,
    opts: {
      denseWeight: number
      sparseWeight: number
      limit: number
      pathSql: string
      pathParams: string[]
      minScore: number
    },
  ): VectorStoreSearchResult[] {
    const denseWeight = opts.denseWeight
    const sparseWeight = opts.sparseWeight
    const totalWeight = denseWeight + sparseWeight

    // Allocate candidate budgets per leg. Each leg prefetches enough
    // candidates that RRF has something to fuse, and the overfetch covers
    // the post-filter drop-out. The Qdrant comment about prefetch limits
    // applies here too.
    const prefetchBase = Math.max(opts.limit, opts.limit * 2)
    const denseLimit = Math.max(1, Math.ceil((prefetchBase * denseWeight) / totalWeight))
    const sparseLimit = Math.max(1, Math.ceil((prefetchBase * sparseWeight) / totalWeight))

    const denseCandidates = this._denseCandidates(db, queryVector, denseLimit, opts.pathSql, opts.pathParams)
    const sparseCandidates = this._sparseCandidates(db, rawQuery, sparseLimit, opts.pathSql, opts.pathParams)

    return reciprocalRankFusion(
      denseCandidates,
      sparseCandidates,
      denseWeight,
      sparseWeight,
      opts.limit,
      db,
      opts.pathSql,
      opts.pathParams,
    )
  }

  private _denseCandidates(
    db: Database.Database,
    queryVector: number[],
    limit: number,
    pathSql: string,
    pathParams: string[],
  ): Array<{ id: string; rank: number; distance: number }> {
    const overfetch = Math.max(limit * DEFAULT_OVERFETCH, limit + 1)
    const knnRows = db.prepare(`
      SELECT rowid, distance
      FROM vec_chunks
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(vectorToBlob(queryVector), overfetch) as { rowid: string | number; distance: number }[]

    if (knnRows.length === 0) return []

    const rowids = knnRows.map((r) => r.rowid)
    const placeholders = rowids.map(() => '?').join(',')
    const keepRows = db.prepare(
      `SELECT rowid, id FROM chunks WHERE rowid IN (${placeholders}) AND ${pathSql}`
    ).all(...rowids, ...pathParams) as { rowid: string | number; id: string }[]
    const idByRowid = new Map<string | number, string>()
    for (const r of keepRows) idByRowid.set(r.rowid, r.id)

    const out: Array<{ id: string; rank: number; distance: number }> = []
    let rank = 0
    for (const r of knnRows) {
      const id = idByRowid.get(r.rowid)
      if (!id) continue // excluded by path filter
      out.push({ id, rank: rank++, distance: r.distance })
      if (out.length >= limit) break
    }
    return out
  }

  private _sparseCandidates(
    db: Database.Database,
    rawQuery: string,
    limit: number,
    pathSql: string,
    pathParams: string[],
  ): Array<{ id: string; rank: number; bm25: number }> {
    // FTS5 bm25() returns negative scores (more negative = better match).
    // We pass the user query through as-is; FTS5 handles tokenisation.
    // We overfetch by the same factor as the dense leg so path-filter
    // post-filtering does not deplete the candidate pool asymmetrically.
    const overfetch = Math.max(limit * DEFAULT_OVERFETCH, limit + 1)

    // Build an FTS5 query from the user input. We mirror Qdrant's BM25
    // behaviour: each token in the user input contributes independently
    // (OR semantics) rather than FTS5's default implicit-AND. This is
    // what makes `字面量"Clear index mode"` match code that contains
    // the phrase "Clear index mode" even though it does not contain
    // the Chinese comment "字面量".
    const ftsQuery = buildFtsBm25Query(rawQuery)
    if (!ftsQuery) return []

    const rows = db.prepare(`
      SELECT rowid, bm25(fts_chunks) AS bm25
      FROM fts_chunks
      WHERE fts_chunks MATCH ?
      ORDER BY bm25
      LIMIT ?
    `).all(ftsQuery, overfetch) as { rowid: string | number; bm25: number }[]

    if (rows.length === 0) return []

    const rowids = rows.map((r) => r.rowid)
    const placeholders = rowids.map(() => '?').join(',')
    const keepRows = db.prepare(
      `SELECT rowid, id FROM chunks WHERE rowid IN (${placeholders}) AND ${pathSql}`
    ).all(...rowids, ...pathParams) as { rowid: string | number; id: string }[]
    const idByRowid = new Map<string | number, string>()
    for (const r of keepRows) idByRowid.set(r.rowid, r.id)

    const out: Array<{ id: string; rank: number; bm25: number }> = []
    let rank = 0
    for (const r of rows) {
      const id = idByRowid.get(r.rowid)
      if (!id) continue
      out.push({ id, rank: rank++, bm25: r.bm25 })
      if (out.length >= limit) break
    }
    return out
  }

  // ── close ─────────────────────────────────────────────────────────────

  close(): void {
    if (this.db) {
      try {
        this.db.close()
      } catch (err) {
        this.logger.warn(`Error closing SQLite: ${(err as Error).message}`)
      }
      this.db = null
    }
  }
}

/**
 * Reciprocal Rank Fusion — combines two ranked lists into one. The
 * formula mirrors Qdrant's server-side `query: { fusion: "rrf" }`:
 *
 *     rrf(d) = sum over legs L of  1 / (rank_in_L(d) + K)
 *
 * with K = 2 — Qdrant's `DEFAULT_RRF_K` (see
 * `lib/segment/src/common/reciprocal_rank_fusion.rs`). The K=2 default
 * is what makes BM25's top ranks competitive with the dense leg: a
 * BM25 rank-0 hit scores 0.5, a dense rank-30 hit scores 1/32, and
 * the BM25 hit wins by 16x. With K=60 (the popular "Cormack paper"
 * constant) both legs collapse into the 0.01–0.02 range and the
 * pre-fetch asymmetry starts drowning the BM25 leg entirely.
 *
 * The leg weights do NOT enter the RRF sum. They only control the
 * pre-fetch limit per leg (see `_hybridSearch`): with our default
 * `denseWeight=1.0, sparseWeight=0.3` and `limit=20`, the dense
 * pre-fetch returns 31 candidates and the BM25 pre-fetch returns 10
 * — the BM25 candidates are then "promoted" by their high RRF even
 * though fewer of them are in the union.
 *
 * The Qdrant REST/JS client (`qdrant-client.ts`) does not pass
 * weights to the server-side RRF, so a per-leg weight inside this
 * function would silently diverge from Qdrant. We accept
 * `denseWeight` / `sparseWeight` as parameters for API parity but
 * do not use them in the sum.
 *
 * Only items that survived the post-filter in BOTH legs contribute to the
 * RRF score for that leg — items dropped by the path filter are not
 * promoted just because they appeared in one leg. We collect union of
 * ids, then resolve each id's per-leg rank (or undefined) to compute the
 * fused score.
 *
 * BM25 guarantee: any id that survived the path filter on the BM25
 * leg is *always* present in the output, even if its RRF score is
 * below the dense-dominated top-N. The dense leg can return hundreds
 * of candidates that have nothing to do with the user's literal phrase
 * (e.g. a `字面量"Clear index mode"` query hits the dense leg's
 * generic code-shape matches and pushes the BM25 hits out of the top
 * 50). Without this guarantee, a `grep` over the CLI output for the
 * phrase yields nothing — the bug the user reported.
 */
const RRF_K = 2
function reciprocalRankFusion(
  dense: Array<{ id: string; rank: number }>,
  sparse: Array<{ id: string; rank: number }>,
  _denseWeight: number, // accepted for API parity with Qdrant; not used in RRF
  _sparseWeight: number, // accepted for API parity with Qdrant; not used in RRF
  limit: number,
  db: Database.Database,
  pathSql: string,
  pathParams: string[],
): VectorStoreSearchResult[] {
  const denseRankById = new Map<string, number>()
  for (const c of dense) denseRankById.set(c.id, c.rank)
  const sparseRankById = new Map<string, number>()
  for (const c of sparse) sparseRankById.set(c.id, c.rank)

  const union = new Set<string>([
    ...denseRankById.keys(),
    ...sparseRankById.keys(),
  ])

  const scored: Array<{ id: string; score: number; inSparse: boolean }> = []
  for (const id of union) {
    let rrf = 0
    const dr = denseRankById.get(id)
    if (dr !== undefined) rrf += 1 / (dr + RRF_K)
    const sr = sparseRankById.get(id)
    if (sr !== undefined) rrf += 1 / (sr + RRF_K)
    scored.push({ id, score: rrf, inSparse: sr !== undefined })
  }
  scored.sort((a, b) => b.score - a.score)

  // First wave: RRF top-N.
  const top: Array<{ id: string; score: number; inSparse: boolean }> = []
  const seen = new Set<string>()
  for (const s of scored) {
    if (top.length >= limit) break
    top.push(s)
    seen.add(s.id)
  }

  // Second wave: any BM25 candidate that did not make the RRF top-N is
  // appended. The result list may exceed `limit` by up to
  // `sparse.length`, but that is the correct trade-off — the user
  // explicitly asked for literal-phrase matching via BM25 and we
  // must not silently drop those hits. The dense leg has already had
  // its full `limit` slots in the first wave.
  for (const s of scored) {
    if (!s.inSparse || seen.has(s.id)) continue
    top.push(s)
    seen.add(s.id)
  }

  if (top.length === 0) return []

  // Hydrate the payload for the final ids only. We still need to apply
  // the path filter here because RRF is computed on a union — an id that
  // somehow slipped past the per-leg filter should not be returned.
  const ids = top.map((t) => t.id)
  const placeholders = ids.map(() => '?').join(',')
  const payloadRows = db.prepare(`
    SELECT id, file_path AS filePath, code_chunk AS codeChunk,
           start_line AS startLine, end_line AS endLine, segment_hash AS segmentHash
    FROM chunks
    WHERE id IN (${placeholders}) AND ${pathSql}
  `).all(...ids, ...pathParams) as Array<{
    id: string
    filePath: string
    codeChunk: string
    startLine: number
    endLine: number
    segmentHash: string
  }>
  const payloadById = new Map(payloadRows.map((r) => [r.id, r]))

  const out: VectorStoreSearchResult[] = []
  for (const { id, score } of top) {
    const payload = payloadById.get(id)
    if (!payload) continue
    out.push({
      id,
      score,
      payload: {
        filePath: payload.filePath,
        codeChunk: payload.codeChunk,
        startLine: payload.startLine,
        endLine: payload.endLine,
        segmentHash: payload.segmentHash,
      } as Payload,
    })
  }
  return out
}

/**
 * FTS5 reserved characters — see
 * <https://www.sqlite.org/fts5.html#full_text_query_syntax>.
 *
 * These characters have meaning in FTS5 query syntax. To use them as
 * literal text the bareword must be wrapped in double quotes (the FTS5
 * string-literal syntax). Inside a quoted string, embedded double quotes
 * are doubled per the FTS5 spec.
 *
 * Note: `-` is the NOT prefix operator in FTS5, so any bareword
 * containing a hyphen must be quoted to prevent FTS5 from misparsing.
 */
/**
 * Regex matching tokens that are safe as FTS5 barewords: Unicode letters,
 * numbers, and underscores. Any token containing punctuation symbols
 * (`.`, `?`, `'`, `#`, `@`, `/`, `>`, `,`, etc.) must be quoted to
 * prevent FTS5 syntax errors.
 *
 * Uses Unicode property escapes to support CJK and other non-ASCII
 * scripts, which are valid barewords in FTS5 with the unicode61 tokenizer.
 */
const FTS5_BAREWORD_SAFE = /^[\p{L}\p{N}_]+$/u

/**
 * Turn the user-supplied search string into an FTS5 query that mirrors
 * Qdrant's BM25 semantics:
 *
 *   - Quoted substrings (`"foo bar"`) become FTS5 phrase queries.
 *   - Other whitespace-separated tokens become FTS5 terms.
 *   - All parts are combined with `OR` so each token contributes
 *     independently to the BM25 score. This is what makes
 *     `字面量"Clear index mode"` match a document that contains the
 *     phrase "Clear index mode" but not the comment "字面量".
 *
 * Returns an empty string if the input is blank. An empty string is
 * treated as a "no BM25" signal by the caller (we don't try to MATCH
 * against the empty string, which would be a syntax error or hit
 * every row).
 *
 * We DO NOT wrap the entire input in a phrase. The previous behaviour
 * (`"${escape(rawQuery)}"`) forced every query to be a literal phrase
 * and made mixed term+phrase inputs like `字面量"Clear index mode"`
 * fail outright.
 */
export function buildFtsBm25Query(rawQuery: string): string {
  if (!rawQuery) return ''

  const phrases: string[] = []
  // Pull out every "... ..." pair. Inside a quoted string, doubled
  // quotes (`""`) are an escape for a literal `"`; we collapse them
  // back to a single `"` when emitting the FTS5 literal.
  const PHRASE = /"((?:[^"]|"")*)"/g
  const stripped = rawQuery.replace(PHRASE, (_m, inner: string) => {
    phrases.push(`"${inner}"`)
    return ' '
  })

  // Everything that wasn't a phrase is whitespace-tokenised. We keep
  // FTS5 reserved characters (`:`, `(`, `)`, `*`, `^`) out of barewords
  // by quoting any token that contains them; the tokenizer will then
  // see them as literal text rather than syntax.
  const parts: string[] = [...phrases]
  for (const tok of stripped.split(/\s+/)) {
    if (!tok) continue
    // Quote any token that contains non-bareword characters
    // (punctuation, operators, special symbols, etc.)
    if (FTS5_BAREWORD_SAFE.test(tok)) {
      parts.push(tok)
    } else {
      parts.push(`"${tok.replace(/"/g, '""')}"`)
    }
  }

  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return `${parts.join(' OR ')}`
}
