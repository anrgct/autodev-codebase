# Configuration Reference

This document provides a comprehensive reference for all configuration options available in `@autodev/codebase`.

## 📋 Table of Contents

- [Configuration System](#configuration-system)
- [Configuration Sources](#configuration-sources)
- [Embedding Providers](#embedding-providers)
- [Vector Store Configuration](#vector-store-configuration)
- [Search Configuration](#search-configuration)
- [Reranker Configuration](#reranker-configuration)
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
codebase --get-config

# View specific configuration items
codebase --get-config embedderProvider qdrantUrl

# JSON output for scripting
codebase --get-config --json

# Show sensitive values (API keys)
codebase --get-config --show-secrets

# Set project configuration
codebase --set-config embedderProvider=ollama,embedderModelId=nomic-embed-text
# Note: also adds `autodev-config.json` to Git global ignore (core.excludesfile) for all repos

# Set global configuration
codebase --set-config --global qdrantUrl=http://localhost:6333

# Use custom config file path
codebase --config=/path/to/config.json --get-config
```

## Configuration Sources

### 1. CLI Arguments (Highest Priority)

CLI arguments provide runtime override for specific operations:

**Path and Storage Options:**
```bash
# Custom configuration file
codebase --config=/path/to/custom-config.json --index

# Custom storage and cache paths
codebase --storage=/custom/storage --cache=/custom/cache --index

# Working directory
codebase --path=/my/project --index

# Debug logging
codebase --log-level=debug --index

# Force reindex
codebase --force --index
```

**Available CLI Arguments:**
- `--config, -c <path>` - Configuration file path
- `--storage <path>` - Custom storage path for index data
- `--cache <path>` - Custom cache path for temporary files
- `--log-level <level>` - Log level: debug|info|warn|error
- `--path, -p <path>` - Working directory path
- `--force` - Force reindex all files, ignoring cache
- `--demo` - Create demo files in workspace for testing
- `--path-filters, -f <filters>` - Filter search results by path patterns
- `--limit, -l <number>` - Maximum number of search results (overrides config, max 50)
- `--min-score, -s <number>` - Minimum similarity score for search results 0-1 (overrides config)
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
codebase --search="authentication" --limit=20
codebase --search="API" -l 30

# Override minimum score (0.0-1.0)
codebase --search="user auth" --min-score=0.7
codebase --search="database" -s 0.5

# Combine both
codebase --search="error handling" --limit=10 --min-score=0.8
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

### Quick Setup Commands

#### Ollama Setup
```bash
# Install and start Ollama
brew install ollama
ollama serve

# Pull embedding model
ollama pull nomic-embed-text

# Configure
codebase --set-config embedderProvider=ollama,embedderModelId=nomic-embed-text
codebase --set-config qdrantUrl=http://localhost:6333

# Start indexing
codebase --index --log-level=debug --force
```

#### OpenAI Setup
```bash
export OPENAI_API_KEY="sk-your-key"
codebase --set-config embedderProvider=openai,embedderModelId=text-embedding-3-small
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
codebase --set-config vectorSearchMinScore=1.5
# Error: Search minimum score must be between 0 and 1

# Missing required field
codebase --set-config embedderModelId=nomic-embed-text
# Error: embedderProvider is required

# Invalid batch size
codebase --set-config embedderOllamaBatchSize=-5
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
codebase --set-config embedderProvider=openai,embedderModelId=text-embedding-3-small

# The tool will automatically use the environment variables
```


---

For additional help, see:
- [Main README](README.md) - Quick start and basic usage
- [GitHub Repository](https://github.com/anrgct/autodev-codebase) - Issues and contributions
