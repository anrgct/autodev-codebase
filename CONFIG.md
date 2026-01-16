# Configuration Reference

This document provides a comprehensive reference for all configuration options available in `@autodev/codebase`.

## 📋 Table of Contents

- [Configuration System](#configuration-system)
- [Configuration Sources](#configuration-sources)
- [Embedding Providers](#embedding-providers)
- [Vector Store Configuration](#vector-store-configuration)
- [Search Configuration](#search-configuration)
- [Reranker Configuration](#reranker-configuration)
- [Summarizer Configuration](#summarizer-configuration)
- [Configuration Examples](#configuration-examples)
- [Validation Rules](#validation-rules)
- [Environment Variables](#environment-variables)

## Configuration System

The tool uses a **layered configuration system** with the following priority order (highest to lowest):

1. **CLI Arguments** - Runtime override for paths, logging, and operational behavior
2. **Project Config** (`./autodev-config.json`) - Project-specific settings
3. **Global Config** (`~/.autodev-cache/autodev-config.json`) - User-specific settings
4. **Built-in Defaults** - Fallback values

### Configuration Management Commands

```bash
# View complete configuration hierarchy
codebase config --get

# View specific configuration items
codebase config --get embedderProvider qdrantUrl

# JSON output for scripting
codebase config --get --json

# Set project configuration
codebase config --set embedderProvider=ollama,embedderModelId=nomic-embed-text
# Note: also adds `autodev-config.json` to Git global ignore (core.excludesfile) for all repos

# Set global configuration
codebase config --set --global qdrantUrl=http://localhost:6333

# Use custom config file path
codebase --config=/path/to/config.json config --get
```

## Configuration Sources

### 1. CLI Arguments (Highest Priority)

CLI arguments provide runtime override for specific operations:

**Path and Storage Options:**
```bash
# Custom configuration file
codebase --config=/path/to/custom-config.json index

# Custom storage and cache paths
codebase --storage=/custom/storage --cache=/custom/cache index

# Working directory
codebase --path=/my/project index

# Debug logging
codebase --log-level=debug index

# Force reindex
codebase --force index
```

**Available CLI Arguments:**
- `--config, -c <path>` - Configuration file path
- `--storage <path>` - Custom storage path for index data
- `--cache <path>` - Custom cache path for temporary files
- `--log-level <level>` - Log level: debug|info|warn|error
- `--path, -p <path>` - Working directory path
- `--force` - Force reindex all files, ignoring cache
- `--demo` - Create demo files in workspace for testing
- `outline <pattern>` - Extract code outline from file(s) using glob patterns
- `--summarize` - Generate AI summaries for code outlines
- `--title` - Show only file-level summary (no function details)
- `--clear-summarize-cache` - Clear all summary caches for current project
- `--dry-run` - Preview files without performing the actual operation
- `--path-filters, -f <filters>` - Filter search results by path patterns
- `--limit, -l <number>` - Maximum number of search results (overrides config, max 50)
- `--min-score, -S <number>` - Minimum similarity score for search results 0-1 (overrides config)
- `--json` - Output search results in JSON format

### 2. Project Configuration

Create `./autodev-config.json` in your project root:

```json
{
  "embedderProvider": "ollama",
  "embedderModelId": "nomic-embed-text",
  "qdrantUrl": "http://localhost:6333"
}
```

### 3. Global Configuration

Located at `~/.autodev-cache/autodev-config.json`:

```json
{
  "embedderProvider": "openai",
  "embedderModelId": "text-embedding-3-small",
  "embedderOpenAiApiKey": "sk-your-key",
  "qdrantUrl": "http://localhost:6333",
  "vectorSearchMinScore": 0.3,
  "vectorSearchMaxResults": 20
}
```

### 4. Environment Variables

API keys can also be set via environment variables:

```bash
export OPENAI_API_KEY="sk-your-key"
export QDRANT_API_KEY="your-qdrant-key"
export GEMINI_API_KEY="your-gemini-key"
```

## Embedding Providers

### Common Configuration Options

All providers share these options:

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `embedderProvider` | string | Yes | - | Provider identifier |
| `embedderModelId` | string | No | Provider-specific | Model name/ID |
| `embedderModelDimension` | number | No | Provider-specific | Vector dimension size |

### 1. Ollama (Recommended)

**Provider ID:** `ollama`

```json
{
  "embedderProvider": "ollama",
  "embedderModelId": "nomic-embed-text",
  "embedderModelDimension": 768,
  "embedderOllamaBaseUrl": "http://localhost:11434",
  "embedderOllamaBatchSize": 10
}
```

### 2. OpenAI

**Provider ID:** `openai`

```json
{
  "embedderProvider": "openai",
  "embedderModelId": "text-embedding-3-small",
  "embedderModelDimension": 1536,
  "embedderOpenAiApiKey": "sk-your-api-key",
  "embedderOpenAiBatchSize": 100
}
```

**Supported Models:**
- `text-embedding-3-small` (1536 dimensions)
- `text-embedding-3-large` (3072 dimensions)
- `text-embedding-ada-002` (1536 dimensions)

### 3. OpenAI-Compatible

**Provider ID:** `openai-compatible`

```json
{
  "embedderProvider": "openai-compatible",
  "embedderModelId": "text-embedding-3-small",
  "embedderModelDimension": 1536,
  "embedderOpenAiCompatibleBaseUrl": "https://api.openai.com/v1",
  "embedderOpenAiCompatibleApiKey": "sk-your-api-key"
}
```

### 4. Other Providers

| Provider | Provider ID | Model Example | Key Environment Variable |
|----------|-------------|---------------|--------------------------|
| Jina | `jina` | `jina-embeddings-v2-base-code` | `JINA_API_KEY` |
| Gemini | `gemini` | `embedding-001` | `GEMINI_API_KEY` |
| Mistral | `mistral` | `mistral-embed` | `MISTRAL_API_KEY` |
| Vercel AI Gateway | `vercel-ai-gateway` | `text-embedding-3-small` | `VERCEL_AI_GATEWAY_API_KEY` |
| OpenRouter | `openrouter` | `text-embedding-3-small` | `OPENROUTER_API_KEY` |

## Vector Store Configuration

### Qdrant Configuration

**Required for all operations.**

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `qdrantUrl` | string | Yes | `http://localhost:6333` | Qdrant server URL |
| `qdrantApiKey` | string | No | - | Qdrant API key |

```json
{
  "qdrantUrl": "http://localhost:6333",
  "qdrantApiKey": "your-qdrant-key"
}
```

**Docker Setup:**
```bash
docker run -p 6333:6333 -p 6334:6334 qdrant/qdrant
```

## Search Configuration

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `vectorSearchMinScore` | number | No | `0.1` | Minimum similarity score (0.0-1.0) |
| `vectorSearchMaxResults` | number | No | `20` | Maximum number of results to return |

```json
{
  "vectorSearchMinScore": 0.3,
  "vectorSearchMaxResults": 15
}
```

### CLI Runtime Override

You can override search parameters at runtime using CLI arguments:

```bash
# Override max results (limited to maximum of 50)
codebase search "authentication" --limit=20
codebase search "API" -l 30

# Override minimum score (0.0-1.0)
codebase search "user auth" --min-score=0.7
codebase search "database" -S 0.5

# Combine both
codebase search "error handling" --limit=10 --min-score=0.8
```

**Note:** CLI arguments `--limit` and `--min-score` provide temporary override for individual searches. For persistent settings, use `vectorSearchMaxResults` and `vectorSearchMinScore` in configuration files.

**Score Interpretation:**
- `0.9-1.0`: Very similar (exact or near-exact match)
- `0.7-0.9`: Highly similar (same concept, different implementation)
- `0.5-0.7`: Moderately similar (related concepts)
- `0.3-0.5`: Somewhat similar (loosely related)
- `<0.3`: Low similarity (may be irrelevant)

## Reranker Configuration

Reranking improves search results by reordering them based on semantic relevance.

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `rerankerEnabled` | boolean | No | `false` | Enable reranking |
| `rerankerProvider` | string | No | - | Reranker provider |
| `rerankerMinScore` | number | No | - | Minimum reranker score |
| `rerankerBatchSize` | number | No | `10` | Reranker batch size |
| `rerankerConcurrency` | number | No | `3` | Concurrent rerank requests |
| `rerankerMaxRetries` | number | No | `3` | Retry attempts for failed requests |
| `rerankerRetryDelayMs` | number | No | `1000` | Initial retry delay in milliseconds |

### Ollama Reranker

```json
{
  "rerankerEnabled": true,
  "rerankerProvider": "ollama",
  "rerankerOllamaModelId": "qwen3-vl:4b-instruct",
  "rerankerOllamaBaseUrl": "http://localhost:11434",
  "rerankerMinScore": 0.5
}
```

### OpenAI-Compatible Reranker

```json
{
  "rerankerEnabled": true,
  "rerankerProvider": "openai-compatible",
  "rerankerOpenAiCompatibleModelId": "deepseek-chat",
  "rerankerOpenAiCompatibleBaseUrl": "https://api.deepseek.com/v1",
  "rerankerOpenAiCompatibleApiKey": "sk-your-deepseek-key",
  "rerankerMinScore": 0.5
}
```

## Summarizer Configuration

Generate AI-powered summaries for code blocks with intelligent caching and batch processing.

### Quick Start

```bash
# Generate intelligent code outline with AI summaries
codebase outline "src/**/*.ts" --summarize
```

**Output Example:**
```
# src/cli.ts (1902 lines)
└─ Implements a simplified CLI for @autodev/codebase using Node.js native parseArgs. 
   Manages codebase indexing, searching, and MCP server operations.

   27--35 | function initGlobalLogger
   └─ Initializes a global logger instance with specified log level and timestamps.

   45--54 | interface SearchResult
   └─ Defines the structure for search result payloads, including file path, code chunk, 
      and relevance score.

   ... (full outline with AI summaries)
```

**Setup (One-time):**
```bash
# Option 1: Ollama (free, local AI)
codebase config --set summarizerProvider=ollama,summarizerOllamaModelId=qwen3-vl:4b-instruct

# Option 2: DeepSeek (cost-effective API)
codebase config --set summarizerProvider=openai-compatible,summarizerOpenAiCompatibleBaseUrl=https://api.deepseek.com/v1,summarizerOpenAiCompatibleModelId=deepseek-chat,summarizerOpenAiCompatibleApiKey=sk-your-key
```

**Key Benefits:**
- 🧠 **Understand code fast** - Get function-level summaries without reading every line
- 💾 **Smart caching** - Only summarizes changed code blocks (>90% cache hit on unchanged code)
- 🌐 **Multi-language** - English/Chinese summaries supported
- ⚡ **Batch processing** - Efficiently handles large codebases

### Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `summarizerProvider` | string | No | `ollama` | Summarizer provider: `ollama` or `openai-compatible` |
| `summarizerLanguage` | string | No | `English` | Output language: `English` or `Chinese` |
| `summarizerTemperature` | number | No | - | LLM temperature (0.0-1.0), affects output randomness |
| `summarizerBatchSize` | number | No | `2` | Number of code blocks per batch request |
| `summarizerConcurrency` | number | No | `2` | Maximum concurrent batch requests |
| `summarizerMaxRetries` | number | No | `3` | Maximum retry attempts for failed requests |
| `summarizerRetryDelayMs` | number | No | `1000` | Initial retry delay in milliseconds (exponential backoff) |

### Ollama Summarizer

**Provider ID:** `ollama`

Recommended for local development with complete privacy protection.

```json
{
  "summarizerProvider": "ollama",
  "summarizerOllamaBaseUrl": "http://localhost:11434",
  "summarizerOllamaModelId": "qwen3-vl:4b-instruct",
  "summarizerLanguage": "English",
  "summarizerBatchSize": 2,
  "summarizerConcurrency": 2,
  "summarizerMaxRetries": 3,
  "summarizerRetryDelayMs": 1000
}
```

### OpenAI-Compatible Summarizer

**Provider ID:** `openai-compatible`

For production use with external APIs (DeepSeek, OpenAI, etc.).

```json
{
  "summarizerProvider": "openai-compatible",
  "summarizerOpenAiCompatibleBaseUrl": "https://api.deepseek.com/v1",
  "summarizerOpenAiCompatibleModelId": "deepseek-chat",
  "summarizerOpenAiCompatibleApiKey": "sk-your-deepseek-key",
  "summarizerLanguage": "English",
  "summarizerBatchSize": 2,
  "summarizerConcurrency": 2,
  "summarizerMaxRetries": 3,
  "summarizerRetryDelayMs": 1000
}
```

**Supported Providers:**
- **DeepSeek**: `https://api.deepseek.com/v1`
- **OpenAI**: `https://api.openai.com/v1`
- **Together AI**: `https://api.together.xyz/v1`
- Any other OpenAI-compatible API

### Summary Cache System

The summarizer uses a **two-level caching mechanism** to avoid redundant LLM calls.

#### Cache Levels

1. **File-level Hash**: SHA256 hash of complete file content
   - Fast detection of unchanged files
   - 100% cache hit when file unchanged

2. **Block-level Hash**: SHA256 hash of individual code block + context
   - Precise detection of changed code blocks
   - Only re-summarizes modified blocks

#### Cache Invalidation

Cache is automatically invalidated when:
- **Configuration changes**: Provider, model, language, or temperature changes
- **File content changes**: File hash no longer matches
- **Manual clearing**: Using `--clear-summarize-cache` flag

#### Cache Storage

```
~/.autodev-cache/summary-cache/
├── {project-hash-1}/
│   └── files/
│       ├── src-cli-tools-outline.json
│       └── src-code-index-manager.json
└── {project-hash-2}/
    └── files/
        └── lib-utils.json
```

#### Cache Performance

- **Typical hit rate**: >90% for unchanged codebases
- **Incremental updates**: Only re-summarizes changed blocks
- **Batch processing**: Efficiently handles large files
- **Atomic writes**: Safe concurrent access

#### Cache Management Commands

```bash
# View cache statistics (automatic)
codebase outline src/index.ts --summarize
# Output: Cache hit rate: 85% (17/20 blocks cached)

# Clear all caches for current project
codebase --clear-summarize-cache

# Clear and regenerate
codebase outline src/index.ts --summarize --clear-summarize-cache

# Clear caches for specific project
codebase --clear-summarize-cache --path=/my/project
```

### Language Support

The summarizer supports multiple output languages:

```json
{
  "summarizerLanguage": "English"  // or "Chinese"
}
```

**Examples:**

English Configuration:
```json
{
  "summarizerProvider": "ollama",
  "summarizerLanguage": "English"
}
```

Chinese Configuration:
```json
{
  "summarizerProvider": "ollama",
  "summarizerLanguage": "Chinese"
}
```

### Performance Tuning

For large codebases, adjust these parameters:

```json
{
  "summarizerBatchSize": 4,        // Increase for faster processing (more memory)
  "summarizerConcurrency": 4,      // Increase for parallel processing (more API calls)
  "summarizerMaxRetries": 5,       // Increase for unreliable networks
  "summarizerRetryDelayMs": 2000   // Increase for rate-limited APIs
}
```

**Trade-offs:**
- Higher `batchSize` = Faster but more memory usage
- Higher `concurrency` = More parallel requests but higher API load
- Higher `maxRetries` = Better reliability but slower on failures

## Configuration Examples

### Ollama (Local Development)

**File:** `~/.autodev-cache/autodev-config.json`
```json
{
  "embedderProvider": "ollama",
  "embedderModelId": "nomic-embed-text",
  "embedderOllamaBaseUrl": "http://localhost:11434",
  "qdrantUrl": "http://localhost:6333",
  "vectorSearchMinScore": 0.3,
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
  "rerankerOpenAiCompatibleApiKey": "sk-your-deepseek-key"
}
```

### Complete Configuration with All Features

**File:** `./autodev-config.json`

```json
{
  "embedderProvider": "ollama",
  "embedderModelId": "nomic-embed-text",
  "embedderOllamaBaseUrl": "http://localhost:11434",
  "qdrantUrl": "http://localhost:6333",
  "vectorSearchMinScore": 0.3,
  "vectorSearchMaxResults": 20,
  
  "rerankerEnabled": true,
  "rerankerProvider": "ollama",
  "rerankerOllamaModelId": "qwen3-vl:4b-instruct",
  "rerankerOllamaBaseUrl": "http://localhost:11434",
  "rerankerMinScore": 0.5,
  "rerankerBatchSize": 10,
  "rerankerConcurrency": 3,
  "rerankerMaxRetries": 3,
  "rerankerRetryDelayMs": 1000,
  
  "summarizerProvider": "ollama",
  "summarizerOllamaBaseUrl": "http://localhost:11434",
  "summarizerOllamaModelId": "qwen3-vl:4b-instruct",
  "summarizerLanguage": "English",
  "summarizerBatchSize": 2,
  "summarizerConcurrency": 2,
  "summarizerMaxRetries": 3,
  "summarizerRetryDelayMs": 1000
}
```

### Chinese Language Configuration

```json
{
  "summarizerProvider": "ollama",
  "summarizerOllamaModelId": "qwen3-vl:4b-instruct",
  "summarizerLanguage": "Chinese"
}
```

### Production Configuration with OpenAI

```json
{
  "embedderProvider": "openai",
  "embedderModelId": "text-embedding-3-small",
  "embedderOpenAiApiKey": "sk-your-openai-key",
  "qdrantUrl": "http://localhost:6333",
  
  "rerankerEnabled": true,
  "rerankerProvider": "openai-compatible",
  "rerankerOpenAiCompatibleModelId": "deepseek-chat",
  "rerankerOpenAiCompatibleBaseUrl": "https://api.deepseek.com/v1",
  "rerankerOpenAiCompatibleApiKey": "sk-your-deepseek-key",
  "rerankerMinScore": 0.5,
  
  "summarizerProvider": "openai-compatible",
  "summarizerOpenAiCompatibleModelId": "gpt-4o-mini",
  "summarizerOpenAiCompatibleBaseUrl": "https://api.openai.com/v1",
  "summarizerOpenAiCompatibleApiKey": "sk-your-openai-key",
  "summarizerLanguage": "English"
}
```

### Quick Setup Commands

#### Ollama Setup
```bash
# Install and start Ollama
brew install ollama
ollama serve

# Pull embedding model
ollama pull nomic-embed-text

# Configure
codebase config --set embedderProvider=ollama,embedderModelId=nomic-embed-text
codebase config --set qdrantUrl=http://localhost:6333

# Start indexing
codebase index --log-level=debug --force
```

#### OpenAI Setup
```bash
export OPENAI_API_KEY="sk-your-key"
codebase config --set embedderProvider=openai,embedderModelId=text-embedding-3-small
```

## Validation Rules

### Configuration Validation

The tool validates configuration automatically. Common validation rules:

#### Embedder Validation
- **Required fields**: `embedderProvider`
- **Provider-specific fields**: Must match provider requirements
- **Model dimensions**: Must be positive integers
- **Batch sizes**: Must be positive integers

#### Qdrant Validation
- **URL format**: Must be valid HTTP/HTTPS URL
- **API key**: Optional, but required if Qdrant has authentication enabled

#### Search Validation
- **Min score**: Must be between 0.0 and 1.0
- **Max results**: Must be positive integer

### Validation Error Examples

```bash
# Invalid score range
codebase config --set vectorSearchMinScore=1.5
# Error: Search minimum score must be between 0 and 1

# Missing required field
codebase config --set embedderModelId=nomic-embed-text
# Error: embedderProvider is required

# Invalid batch size
codebase config --set embedderOllamaBatchSize=-5
# Error: Embedder Ollama batch size must be positive
```

## Environment Variables

### API Keys Mapping

Environment variables are automatically mapped to configuration keys:

| Environment Variable | Configuration Key | Provider |
|---------------------|-------------------|----------|
| `OPENAI_API_KEY` | `embedderOpenAiApiKey` | OpenAI |
| `OPENAI_COMPATIBLE_API_KEY` | `embedderOpenAiCompatibleApiKey` | OpenAI-Compatible |
| `GEMINI_API_KEY` | `embedderGeminiApiKey` | Gemini |
| `JINA_API_KEY` | `embedderJinaApiKey` | Jina |
| `MISTRAL_API_KEY` | `embedderMistralApiKey` | Mistral |
| `VERCEL_AI_GATEWAY_API_KEY` | `embedderVercelAiGatewayApiKey` | Vercel AI Gateway |
| `OPENROUTER_API_KEY` | `embedderOpenRouterApiKey` | OpenRouter |
| `QDRANT_API_KEY` | `qdrantApiKey` | Qdrant |

### Usage with Environment Variables

```bash
# Set environment variables
export OPENAI_API_KEY="sk-your-key"
export QDRANT_API_KEY="your-qdrant-key"

# Configure tool
codebase config --set embedderProvider=openai,embedderModelId=text-embedding-3-small

# The tool will automatically use the environment variables
```


---

For additional help, see:
- [Main README](README.md) - Quick start and basic usage
- [GitHub Repository](https://github.com/anrgct/autodev-codebase) - Issues and contributions
