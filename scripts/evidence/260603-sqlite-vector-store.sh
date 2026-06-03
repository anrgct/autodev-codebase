#!/usr/bin/env bash
# Evidence script for 260603 SQLite local vector store implementation.
# Runs the unit tests covering path-filter, SQLite store, and factory.
# The full 1111-test suite is run by `npm run test`; this script is a
# targeted re-run for the work covered by docs/plans/260529-local-vector-store.md.

set -euo pipefail

cd "$(dirname "$0")/../.."

echo "==> SQLiteVectorStore unit tests"
npx vitest run src/code-index/vector-store/__tests__/sqlite-store.spec.ts

echo "==> PathFilter / factory unit tests"
npx vitest run src/code-index/vector-store/__tests__/factory.spec.ts

echo "==> QdrantVectorStore regression (shared PathFilter compiler)"
npx vitest run src/code-index/vector-store/__tests__/qdrant-client.spec.ts

echo "==> Service factory (factory dispatch + isConfigured branch)"
npx vitest run src/code-index/__tests__/service-factory.spec.ts

echo "OK"
