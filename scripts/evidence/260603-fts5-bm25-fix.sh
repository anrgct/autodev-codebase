#!/usr/bin/env bash
# Regression script for the BM25 / FTS5 fixes landed on 2026-06-03.
# Two related bugs caused every BM25 query to return 0 rows in the
# SQLite backend:
#
#   1. fts_chunks first column was named `content` while the source
#      `chunks` table has a `code_chunk` column. The FTS5 external-
#      content lookup failed silently, leaving the index empty.
#   2. The after-insert / after-update / after-delete triggers on
#      `chunks` did not pass the `code_chunk` value to the FTS5
#      virtual table — same outcome, index never populated.
#   3. The whole rawQuery was wrapped as a single FTS5 phrase, which
#      mismatched Qdrant's BM25 token-by-token OR semantics and made
#      mixed term+phrase queries like `字面量"Clear index mode"`
#      match zero documents.
#
# This script runs the affected unit tests. They cover the user's
# exact regression (`字面量"Clear index mode"`) plus the schema
# migration path.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../.."

echo "==> SQLiteVectorStore (incl. BM25 regression tests)"
npx vitest run src/code-index/vector-store/__tests__/sqlite-store.spec.ts --silent=false

echo
echo "==> Related: index-cloner (exercises the SQLite path)"
npx vitest run src/utils/__tests__/index-cloner.test.ts --silent=false

echo
echo "==> All vector-store tests"
npx vitest run src/code-index/vector-store --silent=false
