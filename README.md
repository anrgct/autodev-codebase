

# @autodev/codebase

<div align="center">
  <img src="src/images/image2.png" alt="Image 2" style="display: inline-block; width: 350px; margin: 0 10px;" />
  <img src="src/images/image3.png" alt="Image 3" style="display: inline-block; width: 200px; margin: 0 10px;" />
</div>

<br />

A platform-agnostic code analysis library with semantic search capabilities and MCP (Model Context Protocol) server support. This library provides intelligent code indexing, vector-based semantic search, and can be integrated into various development tools and IDEs.

## 🚀 Features

- **Semantic Code Search**: Vector-based code search using embeddings
- **MCP Server Support**: HTTP-based MCP server for IDE integration
- **Terminal UI**: Interactive CLI with rich terminal interface
- **Tree-sitter Parsing**: Advanced code parsing and analysis
- **Vector Storage**: Qdrant vector database integration
- **Flexible Embedding**: Support for various embedding models via Ollama

## 📦 Installation

### 1. Install and Start Ollama

```bash
# Install Ollama (macOS)
brew install ollama

# Start Ollama service
ollama serve

# In a new terminal, pull the embedding model
ollama pull qwen3-embedding:0.6b
```

### 2. Install ripgrep for fast files search

```bash
# Install ripgrep (macOS)
brew install ripgrep

# Or on Ubuntu/Debian
sudo apt-get install ripgrep

# Or on Arch Linux
sudo pacman -S ripgrep
```

### 3. Install and Start Qdrant for Vector Storage

Start Qdrant using Docker:

```bash
# Start Qdrant container
docker run -p 6333:6333 -p 6334:6334 qdrant/qdrant
```

Or download and run Qdrant directly:

```bash
# Download and run Qdrant
wget https://github.com/qdrant/qdrant/releases/latest/download/qdrant-x86_64-unknown-linux-gnu.tar.gz
tar -xzf qdrant-x86_64-unknown-linux-gnu.tar.gz
./qdrant
```

### 4. Verify Services Are Running

```bash
# Check Ollama
curl http://localhost:11434/api/tags

# Check Qdrant
curl http://localhost:6333/collections
```
### 5. Install Autodev-codebase

```bash
npm install -g @autodev/codebase
```

Alternatively, you can install it locally:
```
git clone https://github.com/anrgct/autodev-codebase
cd autodev-codebase
npm install
npm run build
npm link
```
## 🛠️ Usage

### Command Line Interface

The CLI provides two main modes:

#### 1. Interactive TUI Mode (Default)
```bash
# Basic usage: index your current folder as the codebase.
# Be cautious when running this command if you have a large number of files.
codebase


# With custom options
codebase --demo # Create a local demo directory and test the indexing service, recommend for setup
codebase --path=/my/project
codebase --path=/my/project --log-level=info
```

#### 2. MCP Server Mode (Recommended for IDE Integration)
```bash
# Start long-running MCP server
cd /my/project
codebase mcp-server

# With custom configuration
codebase mcp-server --port=3001 --host=localhost
codebase mcp-server --path=/workspace --port=3001
```


## ⚙️ Configuration

### Configuration Files & Priority

The library uses a layered configuration system, allowing you to customize settings at different levels. The priority order (highest to lowest) is:

1. **CLI Parameters** (e.g., `--model`, `--ollama-url`, `--qdrant-url`, `--config`, etc.)
2. **Project Config File** (`./autodev-config.json`)
3. **Global Config File** (`~/.autodev-cache/autodev-config.json`)
4. **Built-in Defaults**

Settings specified at a higher level override those at lower levels. This lets you tailor the behavior for your environment or project as needed.

**Config file locations:**
- Global: `~/.autodev-cache/autodev-config.json`
- Project: `./autodev-config.json`
- CLI: Pass parameters directly when running commands


#### Global Configuration

Create a global configuration file at `~/.autodev-cache/autodev-config.json`:

```json
{
  "isEnabled": true,
  "embedder": {
    "provider": "ollama",
    "model": "qwen3-embedding:0.6b",
    "dimension": 1024,
    "baseUrl": "http://localhost:11434"
  },
  "qdrantUrl": "http://localhost:6333",
  "qdrantApiKey": "your-api-key-if-needed",
  "searchMinScore": 0.4
}
```

#### Project Configuration

Create a project-specific configuration file at `./autodev-config.json`:

```json
{
  "embedder": {
    "provider": "openai-compatible",
    "apiKey": "sk-xxxxx",
    "baseUrl": "http://localhost:2302/v1",
    "model": "openai/text-embedding-3-smallnpm",
    "dimension": 1536,
  },
  "qdrantUrl": "http://localhost:6334"
}
```

#### Configuration Options

| Option | Type | Description | Default |
|--------|------|-------------|---------|
| `isEnabled` | boolean | Enable/disable code indexing feature | `true` |
| `embedder.provider` | string | Embedding provider (`ollama`, `openai`, `openai-compatible`) | `ollama` |
| `embedder.model` | string | Embedding model name | `qwen3-embedding:0.6b` |
| `embedder.dimension` | number | Vector dimension size | `1024` |
| `embedder.baseUrl` | string | Provider API base URL | `http://localhost:11434` |
| `embedder.apiKey` | string | API key (for OpenAI/compatible providers) | - |
| `qdrantUrl` | string | Qdrant vector database URL | `http://localhost:6333` |
| `qdrantApiKey` | string | Qdrant API key (if authentication enabled) | - |
| `searchMinScore` | number | Minimum similarity score for search results | `0.4` |

**Note**: The `isConfigured` field is automatically calculated based on the completeness of your configuration and should not be set manually. The system will determine if the configuration is valid based on the required fields for your chosen provider.

#### Configuration Priority Examples

```bash
# Use global config defaults
codebase

# Override model via CLI (highest priority)
codebase --model="custom-model"

# Use project config with CLI overrides
codebase --config=./my-config.json --qdrant-url=http://remote:6333
```

## 🔧 CLI Options

### Global Options
- `--path=<path>` - Workspace path (default: current directory)
- `--demo` - Create demo files in workspace
- `--force` - ignore cache force re-index
- `--ollama-url=<url>` - Ollama API URL (default: http://localhost:11434)
- `--qdrant-url=<url>` - Qdrant vector DB URL (default: http://localhost:6333)
- `--model=<model>` - Embedding model (default: nomic-embed-text)
- `--config=<path>` - Config file path
- `--storage=<path>` - Storage directory path
- `--cache=<path>` - Cache directory path
- `--log-level=<level>` - Log level: error|warn|info|debug (default: error)
- `--log-level=<level>` - Log level: error|warn|info|debug (default: error)
- `--help, -h` - Show help

### MCP Server Options
- `--port=<port>` - HTTP server port (default: 3001)
- `--host=<host>` - HTTP server host (default: localhost)


### IDE Integration (Cursor/Claude)

Configure your IDE to connect to the MCP server:

```json
{
  "mcpServers": {
    "codebase": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

For clients that do not support SSE MCP, you can use the following configuration:

```json
{
  "mcpServers": {
    "codebase": {
      "command": "codebase",
      "args": [
        "stdio-adapter",
        "--server-url=http://localhost:3001/mcp"
      ]
    }
  }
}
```
## 🌐 MCP Server Features

### Web Interface
- **Home Page**: `http://localhost:3001` - Server status and configuration
- **Health Check**: `http://localhost:3001/health` - JSON status endpoint
- **MCP Endpoint**: `http://localhost:3001/mcp` - StreamableHTTP MCP protocol endpoint

### Available MCP Tools
- **`search_codebase`** - Semantic search through your codebase
  - Parameters: `query` (string), `limit` (number), `filters` (object)
  - Returns: Formatted search results with file paths, scores, and code blocks



### Scripts
```bash
# Development mode with demo files
npm run dev

# Build for production
npm run build

# Type checking
npm run type-check

# Run TUI demo
npm run demo-tui

# Start MCP server demo
npm run mcp-server
```

## Embedding Models PK

**Mainstream Embedding Models Performance**

| Model                                            | Dimension | Avg Precision@3 | Avg Precision@5 | Good Queries (≥66.7%) | Failed Queries (0%) |
| ------------------------------------------------ | --------- | --------------- | --------------- | --------------------- | ------------------- |
| siliconflow/Qwen/Qwen3-Embedding-8B              | 4096      | **76.7%**       | 66.0%           | 5/10                  | 0/10                |
| siliconflow/Qwen/Qwen3-Embedding-4B              | 2560      | **73.3%**       | 54.0%           | 5/10                  | 1/10                |
| voyage/voyage-code-3                             | 1024      | **73.3%**       | 52.0%           | 6/10                  | 1/10                |
| jina/jina-code-embeddings-1.5b                   | 1536      | **66.7%**       | 52.0%           | 4/10                  | 0/10                |
| jina/jina-code-embeddings-0.5b                   | 896       | **63.3%**       | 50.0%           | 2/10                  | 0/10                |
| siliconflow/Qwen/Qwen3-Embedding-0.6B            | 1024      | **63.3%**       | 42.0%           | 4/10                  | 1/10                |
| morph-embedding-v2                               | 1536      | **56.7%**       | 44.0%           | 3/10                  | 1/10                |
| openai/text-embedding-ada-002                    | 1536      | **53.3%**       | 38.0%           | 2/10                  | 1/10                |
| voyage/voyage-3-large                            | 1024      | **53.3%**       | 42.0%           | 3/10                  | 2/10                |
| openai/text-embedding-3-large                    | 3072      | **46.7%**       | 38.0%           | 1/10                  | 3/10                |
| voyage/voyage-3.5                                | 1024      | **43.3%**       | 38.0%           | 1/10                  | 2/10                |
| jina-embeddings-v4                               | 2048      | **36.7%**       | 36.0%           | 0/10                  | 4/10                |
| voyage/voyage-3.5-lite                           | 1024      | **36.7%**       | 28.0%           | 1/10                  | 2/10                |
| openai/text-embedding-3-small                    | 1536      | **33.3%**       | 28.0%           | 1/10                  | 4/10                |
| siliconflow/BAAI/bge-large-en-v1.5               | 1024      | **30.0%**       | 28.0%           | 0/10                  | 3/10                |
| siliconflow/Pro/BAAI/bge-m3                      | 1024      | **26.7%**       | 24.0%           | 0/10                  | 2/10                |
| ollama/nomic-embed-text                          | 768       | **16.7%**       | 18.0%           | 0/10                  | 6/10                |
| siliconflow/netease-youdao/bce-embedding-base_v1 | 1024      | **13.3%**       | 16.0%           | 0/10                  | 6/10                |

------

**Ollama-based Embedding Models Performance**

| Model                                                    | Dimension | Precision@3 | Precision@5 | Good Queries (≥66.7%) | Failed Queries (0%) |
| -------------------------------------------------------- | --------- | ----------- | ----------- | --------------------- | ------------------- |
| ollama/dengcao/Qwen3-Embedding-4B:Q4_K_M                 | 2560      | 66.7%       | 48.0%       | 4/10                  | 1/10                |
| ollama/dengcao/Qwen3-Embedding-0.6B:f16                  | 1024      | 63.3%       | 44.0%       | 3/10                  | 0/10                |
| ollama/dengcao/Qwen3-Embedding-0.6B:Q8_0                 | 1024      | 63.3%       | 44.0%       | 3/10                  | 0/10                |
| ollama/dengcao/Qwen3-Embedding-4B:Q8_0                   | 2560      | 60.0%       | 48.0%       | 3/10                  | 1/10                |
| lmstudio/taylor-jones/bge-code-v1-Q8_0-GGUF              | 1536      | 60.0%       | 54.0%       | 4/10                  | 1/10                |
| ollama/dengcao/Qwen3-Embedding-8B:Q4_K_M                 | 4096      | 56.7%       | 42.0%       | 2/10                  | 2/10                |
| ollama/hf.co/nomic-ai/nomic-embed-code-GGUF:Q4_K_M       | 3584      | 53.3%       | 44.0%       | 2/10                  | 0/10                |
| ollama/embeddinggemma:bf16                               | 768       | 26.7%       | 26.0%       | 0/10                  | 3/10                |
| ollama/bge-m3:f16                                        | 1024      | 26.7%       | 24.0%       | 0/10                  | 2/10                |
| ollama/hf.co/nomic-ai/nomic-embed-text-v2-moe-GGUF:f16   | 768       | 26.7%       | 20.0%       | 0/10                  | 2/10                |
| ollama/granite-embedding:278m-fp16                       | 768       | 23.3%       | 18.0%       | 0/10                  | 4/10                |
| ollama/unclemusclez/jina-embeddings-v2-base-code:f16     | 768       | 23.3%       | 16.0%       | 0/10                  | 5/10                |
| lmstudio/awhiteside/CodeRankEmbed-Q8_0-GGUF              | 768       | 23.3%       | 16.0%       | 0/10                  | 5/10                |
| lmstudio/wsxiaoys/jina-embeddings-v2-base-code-Q8_0-GGUF | 768       | 23.3%       | 16.0%       | 0/10                  | 5/10                |
| ollama/dengcao/Dmeta-embedding-zh:F16                    | 768       | 20.0%       | 20.0%       | 0/10                  | 6/10                |
| ollama/znbang/bge:small-en-v1.5-q8_0                     | 384       | 16.7%       | 16.0%       | 0/10                  | 6/10                |
| lmstudio/nomic-ai/nomic-embed-text-v1.5-GGUF@Q4_K_M      | 768       | 16.7%       | 14.0%       | 0/10                  | 6/10                |
| ollama/nomic-embed-text:f16                              | 768       | 16.7%       | 18.0%       | 0/10                  | 6/10                |
| ollama/snowflake-arctic-embed2:568m:f16                  | 1024      | 16.7%       | 18.0%       | 0/10                  | 5/10                |
