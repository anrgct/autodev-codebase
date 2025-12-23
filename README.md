# @autodev/codebase

<div align="center">

[![npm version](https://img.shields.io/npm/v/@autodev/codebase)](https://www.npmjs.com/package/@autodev/codebase)
[![GitHub stars](https://img.shields.io/github/stars/anrgct/autodev-codebase)](https://github.com/anrgct/autodev-codebase)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

```sh
╭─ ~/workspace/autodev-codebase 
╰─❯ codebase --demo --search="user manage"
Found 3 results in 2 files for: "user manage"

==================================================
File: "hello.js"
==================================================
< class UserManager > (L7-20)
class UserManager {
  constructor() {
    this.users = [];
  }

  addUser(user) {
    this.users.push(user);
    console.log('User added:', user.name);
  }

  getUsers() {
    return this.users;
  }
}

==================================================
File: "README.md" | 2 snippets
==================================================
< md_h1 Demo Project > md_h2 Usage > md_h3 JavaScript Functions > (L16-20)
### JavaScript Functions

- greetUser(name) - Greets a user by name
- UserManager - Class for managing user data

─────
< md_h1 Demo Project > md_h2 Search Examples > (L27-38)
## Search Examples

Try searching for:
- "greet user"
- "process data"
- "user management"
- "batch processing"
- "YOLO model"
- "computer vision"
- "object detection"
- "model training"

```
A vector embedding-based code semantic search tool with MCP server and multi-model integration. Can be used as a pure CLI tool. Supports Ollama for fully local embedding and reranking, enabling complete offline operation and privacy protection for your code repository.

## 🚀 Features

- **🔍 Semantic Code Search**: Vector-based search using advanced embedding models
- **🌐 MCP Server**: HTTP-based MCP server with SSE and stdio adapters
- **💻 Pure CLI Tool**: Standalone command-line interface without GUI dependencies
- **⚙️ Layered Configuration**: CLI, project, and global config management
- **🎯 Advanced Path Filtering**: Glob patterns with brace expansion and exclusions
- **🌲 Tree-sitter Parsing**: Support for 40+ programming languages
- **💾 Qdrant Integration**: High-performance vector database
- **🔄 Multiple Providers**: OpenAI, Ollama, Jina, Gemini, Mistral, OpenRouter, Vercel
- **📊 Real-time Watching**: Automatic index updates
- **⚡ Batch Processing**: Efficient parallel processing

## 📦 Installation

### 1. Dependencies
```bash
brew install ollama ripgrep
ollama serve
ollama pull nomic-embed-text
```

### 2. Qdrant
```bash
docker run -d -p 6333:6333 -p 6334:6334 --name qdrant qdrant/qdrant
```

### 3. Install
```bash
npm install -g @autodev/codebase
codebase --set-config embedderProvider=ollama,embedderModelId=nomic-embed-text
```

## 🛠️ Quick Start

```bash
# Demo mode (recommended for first-time)
# Creates a demo directory in current working directory for testing

# Index & search
codebase --demo --index
codebase --demo --search="user greet"

# MCP server
codebase --demo --serve
```

## 📋 Commands

### Indexing & Search
```bash
# Index the codebase
codebase --index --path=/my/project --force

# Search with filters
codebase --search="error handling" --path-filters="src/**/*.ts"

# Search with custom limit and minimum score
codebase --search="authentication" --limit=20 --min-score=0.7
codebase --search="API" -l 30 -s 0.5

# Search in JSON format
codebase --search="authentication" --json

# Clear index data
codebase --clear --path=/my/project
```

### MCP Server
```bash
# HTTP mode (recommended)
codebase --serve --port=3001 --path=/my/project

# Stdio adapter
codebase --stdio-adapter --server-url=http://localhost:3001/mcp
```

### Configuration
```bash
# View config
codebase --get-config
codebase --get-config embedderProvider --json

# Set config
codebase --set-config embedderProvider=ollama,embedderModelId=nomic-embed-text
codebase --set-config --global qdrantUrl=http://localhost:6333
```

### Advanced Features

#### 🔍 LLM-Powered Search Reranking
Enable LLM reranking to dramatically improve search relevance:

```bash
# Enable reranking with Ollama (recommended)
codebase --set-config rerankerEnabled=true,rerankerProvider=ollama,rerankerOllamaModelId=qwen3-vl:4b-instruct

# Or use OpenAI-compatible providers
codebase --set-config rerankerEnabled=true,rerankerProvider=openai-compatible,rerankerOpenAiCompatibleModelId=deepseek-chat

# Search with automatic reranking
codebase --search="user authentication"  # Results are automatically reranked by LLM
```

**Benefits:**
- 🎯 **Higher precision**: LLM understands semantic relevance beyond vector similarity
- 📊 **Smart scoring**: Results are reranked on a 0-10 scale based on query relevance  
- ⚡ **Batch processing**: Efficiently handles large result sets with configurable batch sizes
- 🎛️ **Threshold control**: Filter results with `rerankerMinScore` to keep only high-quality matches

#### Path Filtering & Export
```bash
# Path filtering with brace expansion and exclusions
codebase --search="API" --path-filters="src/**/*.ts,lib/**/*.js"
codebase --search="utils" --path-filters="{src,test}/**/*.ts"

# Export results in JSON format for scripts
codebase --search="auth" --json
```

## ⚙️ Configuration

### Config Layers (Priority Order)
1. **CLI Arguments** - Runtime parameters (`--path`, `--config`, `--log-level`, `--force`, etc.)
2. **Project Config** - `./autodev-config.json` (or custom path via `--config`)
3. **Global Config** - `~/.autodev-cache/autodev-config.json`
4. **Built-in Defaults** - Fallback values

**Note:** CLI arguments provide runtime override for paths, logging, and operational behavior. For persistent configuration (embedderProvider, API keys, search parameters), use `--set-config` to save to config files.

### Common Config Examples

**Ollama:**
```json
{
  "embedderProvider": "ollama",
  "embedderModelId": "nomic-embed-text",
  "qdrantUrl": "http://localhost:6333"
}
```

**OpenAI:**
```json
{
  "embedderProvider": "openai",
  "embedderModelId": "text-embedding-3-small",
  "embedderOpenAiApiKey": "sk-your-key",
  "qdrantUrl": "http://localhost:6333"
}
```

**OpenAI-Compatible:**
```json
{
  "embedderProvider": "openai-compatible",
  "embedderModelId": "text-embedding-3-small",
  "embedderOpenAiCompatibleApiKey": "sk-your-key",
  "embedderOpenAiCompatibleBaseUrl": "https://api.openai.com/v1"
}
```

### Key Configuration Options

| Category | Options | Description |
|----------|---------|-------------|
| **Embedding** | `embedderProvider`, `embedderModelId`, `embedderModelDimension` | Provider and model settings |
| **API Keys** | `embedderOpenAiApiKey`, `embedderOpenAiCompatibleApiKey` | Authentication |
| **Vector Store** | `qdrantUrl`, `qdrantApiKey` | Qdrant connection |
| **Search** | `vectorSearchMinScore`, `vectorSearchMaxResults` | Search behavior |
| **Reranker** | `rerankerEnabled`, `rerankerProvider` | Result reranking |

**Key CLI Arguments:**
- `--serve` / `--index` / `--search` - Core operations
- `--get-config` / `--set-config` - Configuration management  
- `--path`, `--demo`, `--force` - Common options
- `--limit` / `-l <number>` - Maximum number of search results (default: from config, max 50)
- `--min-score` / `-s <number>` - Minimum similarity score for search results (0-1, default: from config)
- `--help` - Show all available options

For complete CLI reference, see [CONFIG.md](CONFIG.md).

**Configuration Commands:**
```bash
# View config
codebase --get-config
codebase --get-config --json
codebase --get-config --show-secrets

# Set config (saves to file)
codebase --set-config embedderProvider=ollama,embedderModelId=nomic-embed-text
codebase --set-config --global embedderProvider=openai,embedderOpenAiApiKey=sk-xxx

# Use custom config file
codebase --config=/path/to/config.json --get-config
codebase --config=/path/to/config.json --set-config embedderProvider=ollama

# Runtime override (paths, logging, etc.)
codebase --index --path=/my/project --log-level=info --force
```

For complete configuration reference, see [CONFIG.md](CONFIG.md).

## 🔌 MCP Integration

### HTTP Streamable Mode (Recommended)
```bash
codebase --serve --port=3001
```

**IDE Config:**
```json
{
  "mcpServers": {
    "codebase": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

### Stdio Adapter
```bash
# First start the MCP server in one terminal
codebase --serve --port=3001

# Then connect via stdio adapter in another terminal (for IDEs that require stdio)
codebase --stdio-adapter --server-url=http://localhost:3001/mcp
```

**IDE Config:**
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

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request or open an Issue on [GitHub](https://github.com/anrgct/autodev-codebase).

## 📄 License

This project is licensed under the [MIT License](https://opensource.org/licenses/MIT).

## 🙏 Acknowledgments

This project is a fork and derivative work based on [Roo Code](https://github.com/RooCodeInc/Roo-Code). We've built upon their excellent foundation to create this specialized codebase analysis tool with enhanced features and MCP server capabilities.

---

<div align="center">

**🌟 If you find this tool helpful, please give us a [star on GitHub](https://github.com/anrgct/autodev-codebase)!**

Made with ❤️ for the developer community

</div>
