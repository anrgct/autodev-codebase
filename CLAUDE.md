# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) and other AI assistants when working with code in this repository.

---

# @autodev/codebase - Development Guide

## Project Overview

A vector embedding-based code semantic search tool with MCP (Model Context Protocol) server integration. This is a platform-agnostic library that supports multiple embedding providers (Ollama, OpenAI, Jina, Gemini, Mistral, etc.) and offers both CLI tool and MCP server modes. It enables intelligent code search through semantic understanding rather than simple text matching.

**Key Characteristics:**
- Pure CLI tool (no GUI dependencies)
- HTTP-based MCP server with SSE support
- LLM-powered search reranking
- Multi-provider embedding support
- Tree-sitter parsing for 40+ languages
- Qdrant vector database backend
- Layered configuration system (CLI → Project → Global → Defaults)

---

## Architecture

```
CLI Layer          (src/cli.ts)
     ↓
MCP Server Layer   (src/mcp/http-server.ts, stdio-adapter.ts)
     ↓
Code Index Manager (src/code-index/manager.ts)
     ↓
Service Layer      (search-service, service-factory, orchestrator)
     ↓
Processor Layer    (scanner, parser, batch-processor, file-watcher)
     ↓
Adapter Layer      (src/adapters/nodejs/)
     ↓
Abstraction Layer  (src/abstractions/)
```

### Core Design Patterns

1. **Dependency Injection** - All components receive dependencies via constructors
2. **Interface-First Design** - All abstractions defined as interfaces (I* prefix)
3. **Platform Agnostic** - Core logic independent of any specific platform
4. **Service Factory Pattern** - Centralized creation of embedders, vector stores, rerankers
5. **State Management** - Dedicated state manager for indexing progress tracking
6. **Layered Configuration** - 4-tier config system with clear priority rules

---

## Core Abstractions (`src/abstractions/`)

### Core Platform Interfaces
- **IFileSystem** - File operations (readFile, writeFile, exists, stat, readdir, mkdir, delete)
- **IStorage** - Cache and storage path management
- **IEventBus** - Event emission and subscription (emit, on, off, once)
- **ILogger** - Logging abstraction (debug, info, warn, error)
- **IFileWatcher** - File system monitoring (watchFile, watchDirectory)

### Workspace Interfaces
- **IWorkspace** - Workspace folder management
- **IPathUtils** - Path manipulation utilities
- **WorkspaceFolder** - Workspace folder type definition

### Configuration Interfaces
- **IConfigProvider** - Configuration management (get, set, snapshot)
- **EmbedderConfig** - Embedding provider configuration
- **VectorStoreConfig** - Vector database configuration
- **SearchConfig** - Search behavior configuration
- **CodeIndexConfig** - Complete code index configuration
- **ConfigSnapshot** - Configuration state snapshot

---

## Core Components

### CodeIndexManager (`src/code-index/manager.ts`)

**Primary API entry point** for the library. Orchestrates all code indexing and search operations.

**Key Methods:**
- `initialize(options)` - Initialize with optional force/searchOnly modes
- `startIndexing(force?)` - Trigger file indexing
- `searchIndex(query, filter)` - Semantic code search
- `clearIndexData()` - Clear all indexed data
- `getCurrentStatus()` - Get current indexing state
- `stopWatcher()` - Stop file system monitoring

**Initialization Flow:**
1. Create platform dependencies via `createNodeDependencies()`
2. Get singleton instance via `CodeIndexManager.getInstance(deps)`
3. Call `initialize()` to set up services
4. Call `startIndexing()` to begin indexing

### Configuration System (`src/code-index/config-manager.ts`)

**4-Layer Priority System:**
1. CLI Arguments (highest) - Runtime paths, logging, operational flags
2. Project Config (`./autodev-config.json`) - Project-specific settings
3. Global Config (`~/.autodev-cache/autodev-config.json`) - User defaults
4. Built-in Defaults (lowest) - Fallback values

**Configuration Commands:**
```bash
codebase --get-config                    # View all layers
codebase --get-config --json             # JSON output
codebase --get-config embedderProvider   # Specific keys
codebase --set-config k=v,k2=v2          # Set project config
codebase --set-config --global k=v       # Set global config
```

### Service Factory (`src/code-index/service-factory.ts`)

Creates embedders, vector stores, and rerankers based on configuration.

**Supported Embedders:**
- Ollama (local, recommended)
- OpenAI
- OpenAI-Compatible (DeepSeek, etc.)
- Jina
- Gemini
- Mistral
- Vercel AI Gateway
- OpenRouter

**Supported Rerankers:**
- Ollama (LLM-based)
- OpenAI-Compatible (LLM-based)

### Search Service (`src/code-index/search-service.ts`)

Handles semantic search with optional LLM reranking.

**Search Flow:**
1. Apply query prefill (model-specific optimizations)
2. Generate embedding for query
3. Perform vector similarity search
4. (Optional) Rerank results with LLM
5. Return sorted results

### Orchestrator (`src/code-index/orchestrator.ts`)

Manages the indexing pipeline: scanning → parsing → embedding → storage.

**State Machine:** `Idle` → `Scanning` → `Parsing` → `Indexing` → `Indexed` | `Error`

### Processors (`src/code-index/processors/`)

- **scanner.ts** - File discovery and filtering
- **parser.ts** - Tree-sitter code parsing and definition extraction
- **batch-processor.ts** - Parallel embedding generation
- **file-watcher.ts** - File system change monitoring

### Cache Manager (`src/code-index/cache-manager.ts`)

Manages vector embedding cache to avoid re-embedding unchanged code.

---

## MCP Server Integration

### HTTP Streamable Mode (Recommended)

**Server:**
```bash
codebase --serve --port=3001 --path=/my/project
```

**Client Config:**
```json
{
  "mcpServers": {
    "codebase": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

### Stdio Adapter Mode

**For IDEs requiring stdio:**
```bash
# Terminal 1: Start HTTP server
codebase --serve --port=3001

# Terminal 2: Start stdio adapter
codebase --stdio-adapter --server-url=http://localhost:3001/mcp
```

**Client Config:**
```json
{
  "mcpServers": {
    "codebase": {
      "command": "codebase",
      "args": ["stdio-adapter", "--server-url=http://localhost:3001/mcp"]
    }
  }
}
```

### MCP Tool: `search_codebase`

**Parameters:**
- `query` (string, required) - Natural language search query
- `limit` (number, optional) - Max results (default: from config, max: 50)
- `filters.pathFilters` (string[], optional) - Path pattern filters
- `filters.minScore` (number, optional) - Minimum similarity (0-1)

---

## CLI Commands

### Core Operations

```bash
# Index the codebase
codebase --index --path=/my/project --force

# Search code
codebase --search="user authentication"
codebase --search="API" --limit=20 --min-score=0.7
codebase -q "database" -l 30 -S 0.5  # Short form

# Search with path filters
codebase --search="utils" --path-filters="src/**/*.ts"

# Export results as JSON
codebase --search="auth" --json

# Clear index
codebase --clear --path=/my/project
```

### MCP Server

```bash
# Start HTTP MCP server
codebase --serve --port=3001 --path=/my/project

# Start stdio adapter
codebase --stdio-adapter --server-url=http://localhost:3001/mcp
```

### Configuration

```bash
# View configuration
codebase --get-config
codebase --get-config --json

# Set configuration
codebase --set-config embedderProvider=ollama,embedderModelId=nomic-embed-text
codebase --set-config --global qdrantUrl=http://localhost:6333
```

### CLI Arguments

| Argument | Description |
|----------|-------------|
| `--path, -p <path>` | Working directory path |
| `--demo` | Create demo files for testing |
| `--force` | Force reindex all files |
| `--config, -c <path>` | Custom config file path |
| `--storage <path>` | Custom storage path |
| `--cache <path>` | Custom cache path |
| `--log-level <level>` | Log level (debug\|info\|warn\|error) |
| `--limit, -l <number>` | Max search results (max 50) |
| `--min-score, -S <number>` | Minimum similarity score (0-1) |
| `--path-filters, -f <patterns>` | Path filter patterns |
| `--json` | JSON output format |
| `--serve` | Start MCP HTTP server |
| `--stdio-adapter` | Start stdio adapter |
| `--index` | Index codebase |
| `--search=<query>` | Search index |
| `--clear` | Clear index data |
| `--get-config` | View configuration |
| `--set-config k=v,...` | Set configuration |

---

## Development Guidelines

### Building

```bash
npm run build          # Build both library and CLI
npm run type-check     # TypeScript validation
```

**Output:**
- `dist/index.js` - Main library (ESM)
- `dist/cli.js` - CLI executable (with shebang)
- TypeScript declarations included

### Running

```bash
npm run dev            # Demo mode with auto-restart
npm run mcp-server     # Start MCP server on port 3001
npm run test           # Run tests
npm run test:e2e       # End-to-end tests
```

### Code Style

- TypeScript strict mode enabled
- Dependency injection throughout
- Interface-based abstractions (I* prefix)
- Platform-agnostic core logic
- No platform-specific imports in core library

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI entry point with argument parsing |
| `src/index.ts` | Main library exports |
| `src/code-index/manager.ts` | Primary API entry point |
| `src/code-index/config-manager.ts` | Configuration management |
| `src/code-index/search-service.ts` | Search orchestration |
| `src/code-index/orchestrator.ts` | Indexing pipeline |
| `src/mcp/http-server.ts` | MCP HTTP server |
| `src/mcp/stdio-adapter.ts` | Stdio to HTTP bridge |
| `src/adapters/nodejs/index.ts` | Node.js platform adapters |
| `src/abstractions/index.ts` | Core interface definitions |
| `src/tree-sitter/` | Code parsing (40+ languages) |
| `src/glob/list-files.ts` | Pattern-based file discovery |

---

## Configuration Examples

### Ollama (Local, Recommended)

**File:** `~/.autodev-cache/autodev-config.json`
```json
{
  "embedderProvider": "ollama",
  "embedderModelId": "nomic-embed-text",
  "embedderOllamaBaseUrl": "http://localhost:11434",
  "qdrantUrl": "http://localhost:6333",
  "vectorSearchMinScore": 0.3,
  "vectorSearchMaxResults": 20,
  "rerankerEnabled": false
}
```

### OpenAI (Production)

**File:** `./autodev-config.json`
```json
{
  "embedderProvider": "openai",
  "embedderModelId": "text-embedding-3-small",
  "embedderOpenAiApiKey": "sk-your-key",
  "qdrantUrl": "http://localhost:6333",
  "vectorSearchMinScore": 0.4,
  "vectorSearchMaxResults": 15,
  "rerankerEnabled": true,
  "rerankerProvider": "openai-compatible",
  "rerankerOpenAiCompatibleModelId": "deepseek-chat",
  "rerankerOpenAiCompatibleBaseUrl": "https://api.deepseek.com/v1",
  "rerankerOpenAiCompatibleApiKey": "sk-deepseek-key",
  "rerankerMinScore": 0.5
}
```

---

## Environment Variables

API keys can be set via environment variables:

| Variable | Maps To |
|----------|---------|
| `OPENAI_API_KEY` | `embedderOpenAiApiKey` |
| `QDRANT_API_KEY` | `qdrantApiKey` |
| `GEMINI_API_KEY` | `embedderGeminiApiKey` |
| `JINA_API_KEY` | `embedderJinaApiKey` |
| `MISTRAL_API_KEY` | `embedderMistralApiKey` |

---

## Notes for AI Assistants

### Important Principles

1. **Dependency Injection**: Never directly import platform-specific modules in core library
2. **Interface First**: Always program against I* interfaces, not concrete implementations
3. **Platform Agnostic**: Core library must work in any JavaScript environment
4. **Configuration Layers**: Respect the 4-tier config priority system
5. **Error Recovery**: Use state manager for error tracking and recovery
6. **Validation**: Validate all user inputs (CLI args, config values, search params)

### Common Pitfalls

- **Direct Platform Imports**: Never import `fs`, `path`, `vscode` directly in core library
- **Hardcoded Paths**: Always use `IWorkspace` and `IPathUtils` for path operations
- **Missing Abstractions**: Don't bypass interfaces for convenience
- **Config Priority**: Remember CLI args > Project > Global > Defaults
- **Search Params**: Always validate limit (max 50) and minScore (0-1)

### Testing Strategy

- Use mock implementations of I* interfaces for unit tests
- Integration tests should use real Node.js adapters
- E2E tests cover full CLI workflows
- Test configuration layering and priority rules

---

## Build System

**Tool:** Rollup with TypeScript plugin

**Outputs:**
- ESM format for both library and CLI
- Inline sourcemaps
- Tree-shaking enabled
- External dependencies: `vscode`, Node.js built-ins, `web-tree-sitter`

**Special Handling:**
- Copies `tree-sitter.wasm` files to dist root
- Adds shebang to CLI output
- Sets executable permission on CLI output

---

## Search Feature Details

### Query Prefill

Model-specific query optimization for better embeddings:

```typescript
// Applied automatically in search-service.ts
const prefillQuery = applyQueryPrefill(query, embedderProvider, modelId)
```

Example: For Qwen3 embedding models, adds "Represent this sentence for searching relevant passages:" prefix.

### Path Filtering

Limited glob support with Qdrant substring filters:
- `**` - Recursive wildcard
- `*` - Single-level wildcard
- `{a,b}` - Brace expansion
- `!` - Exclusion prefix

**Note:** Not a full glob implementation; compiled to Qdrant substring filters.

### Reranking

LLM-powered reranking for improved relevance:

**Benefits:**
- Higher precision through semantic understanding
- 0-10 scoring scale for better result quality
- Batch processing for efficiency
- Configurable minimum score threshold

**Providers:**
- Ollama: Uses vision models (qwen3-vl)
- OpenAI-Compatible: Works with DeepSeek, etc.

---

## Dependencies

### Runtime
- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `@qdrant/js-client-rest` - Vector database client
- `tree-sitter` / `web-tree-sitter` - Code parsing
- `openai` - OpenAI API client
- `fzf` - Fuzzy finder (CLI)
- `ignore` - Gitignore-style filtering

### Dev
- `typescript` - Type checking
- `rollup` - Bundling
- `vitest` - Testing framework
- `tsx` - TypeScript execution

---

## License

MIT License - See LICENSE file for details.

---

## Acknowledgments

Derived from [Roo Code](https://github.com/RooCodeInc/Roo-Code). Built upon their excellent foundation to create a specialized codebase analysis tool with enhanced MCP server capabilities and multi-provider support.

snippet1_score, snippet2_score, snippet3_score, snippet4_score,snippet5_score,snippet6_score,snippet7_score,snippet8_score,snippet9_score,snippet10_score
