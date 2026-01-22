# @autodev/codebase

<p align="center">

[![npm version](https://img.shields.io/npm/v/@autodev/codebase)](https://www.npmjs.com/package/@autodev/codebase)
[![GitHub stars](https://img.shields.io/github/stars/anrgct/autodev-codebase)](https://github.com/anrgct/autodev-codebase)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</p>

A vector embedding-based code semantic search tool with MCP server and multi-model integration. Can be used as a pure CLI tool. Supports Ollama for fully local embedding and reranking, enabling complete offline operation and privacy protection for your code repository.

```sh
# Semantic code search - Find code by meaning, not just keywords
╭─ ~/workspace/autodev-codebase 
╰─❯ codebase search "user manage" --demo
Found 20 results in 5 files for: "user manage"

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
……

# Call graph analysis - Trace function call relationships and execution paths
╭─ ~/workspace/autodev-codebase 
╰─❯ codebase call --demo --query="app,addUser"
Connections between app, addUser:

Found 2 matching node(s):
  - demo/app:L1-29
  - demo/hello.UserManager.addUser:L12-15

Direct connections:
  - demo/app:L1-29 → demo/hello.UserManager.addUser:L12-15

Chains found:
  - demo/app:L1-29 → demo/hello.UserManager.addUser:L12-15

# Code outline with AI summaries - Understand code structure at a glance
╭─ ~/workspace/autodev-codebase 
╰─❯ codebase outline 'hello.js' --demo --summarize
# hello.js (23 lines)
└─ Defines a greeting function that logs a personalized hello message and returns a welcome string. Implements a UserManager class managing an array of users with methods to add users and retrieve the current user list. Exports both components for external use.

   2--5 | function greetUser
   └─ Implements user greeting logic by logging a personalized hello message and returning a welcome message

   7--20 | class UserManager
   └─ Manages user data with methods to add users to a list and retrieve all stored users

   12--15 | method addUser
   └─ Adds a user to the users array and logs a confirmation message with the user's name.
```


## 🚀 Features

- **🔍 Semantic Code Search**: Vector-based search using advanced embedding models
- **🔗 Call Graph Analysis**: Trace function call relationships and execution paths
- **🌐 MCP Server**: HTTP-based MCP server with SSE and stdio adapters
- **💻 Pure CLI Tool**: Standalone command-line interface without GUI dependencies
- **⚙️ Layered Configuration**: CLI, project, and global config management
- **🎯 Advanced Path Filtering**: Glob patterns with brace expansion and exclusions
- **🌲 Tree-sitter Parsing**: Support for 40+ programming languages
- **💾 Qdrant Integration**: High-performance vector database
- **🔄 Multiple Providers**: OpenAI, Ollama, Jina, Gemini, Mistral, OpenRouter, Vercel
- **📊 Real-time Watching**: Automatic index updates
- **⚡ Batch Processing**: Efficient parallel processing
- **📝 Code Outline Extraction**: Generate structured code outlines with AI summaries
- **💨 Dependency Analysis Cache**: Intelligent caching for 10-50x faster re-analysis

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
codebase config --set embedderProvider=ollama,embedderModelId=nomic-embed-text
```

## 🛠️ Quick Start

```bash
# Demo mode (recommended for first-time)
# Creates a demo directory in current working directory for testing

# Index & search
codebase index --demo
codebase search "user greet" --demo

# Call graph analysis
codebase call --demo --query="app,addUser"

# MCP server
codebase index --serve --demo
```

## 📋 Commands

### 📝 Code Outlines
```bash
# Extract code structure (functions, classes, methods)
codebase outline "src/**/*.ts"

# Generate code structure with AI summaries
codebase outline "src/**/*.ts" --summarize

# View only file-level summaries
codebase outline "src/**/*.ts" --summarize --title

# Clear summary cache
codebase outline --clear-summarize-cache
```

### 🔗 Call Graph Analysis
```bash
# Analyze function call relationships
codebase call --query="functionA,functionB"

# Analyze specific directory
codebase call src/commands

# Export analysis results
codebase call --output=graph.json

# Open interactive graph viewer
codebase call --open

# Set analysis depth
codebase call --query="main" --depth=3

# Specify workspace path
codebase call --path=/my/project
```

**Query Patterns:**
- **Exact match**: `--query="functionName"` or `--query="ClassName.methodName"`
- **Wildcards**: `*` (any characters), `?` (single character)
  - Examples: `--query="get*"`, `--query="*User*"`, `--query="*.*.get*"`
- **Single pattern**: `--query="main"` - Shows dependency tree (what it calls, who calls it)
  - Use `--depth` to control tree depth (default: 10)
- **Multiple patterns**: `--query="main,helper"` - Analyzes connections between functions
  - Connection search depth is fixed at 10 (--depth is ignored)

**Supported Languages:**
- **TypeScript/JavaScript** (.ts, .tsx, .js, .jsx)
- **Python** (.py)
- **Java** (.java)
- **C/C++** (.c, .h, .cpp, .cc, .cxx, .hpp, .hxx, .c++)
- **C#** (.cs)
- **Rust** (.rs)
- **Go** (.go)

### 🔍 Indexing & Search
```bash
# Index the codebase
codebase index --path=/my/project --force

# Search with filters
codebase search "error handling" --path-filters="src/**/*.ts"

# Search with custom limit and minimum score
codebase search "authentication" --limit=20 --min-score=0.7
codebase search "API" -l 30 -S 0.5

# Search in JSON format
codebase search "authentication" --json

# Clear index data
codebase index --clear-cache --path=/my/project
```

### 🌐 MCP Server
```bash
# HTTP mode (recommended)
codebase index --serve --port=3001 --path=/my/project

# Stdio adapter
codebase stdio --server-url=http://localhost:3001/mcp
```

### ⚙️ Configuration
```bash
# View config
codebase config --get
codebase config --get embedderProvider --json

# Set config
codebase config --set embedderProvider=ollama,embedderModelId=nomic-embed-text
codebase config --set --global qdrantUrl=http://localhost:6333
```

### 🚀 Advanced Features

#### 🔍 LLM-Powered Search Reranking
Enable LLM reranking to dramatically improve search relevance:

```bash
# Enable reranking with Ollama (recommended)
codebase config --set rerankerEnabled=true,rerankerProvider=ollama,rerankerOllamaModelId=qwen3-vl:4b-instruct

# Or use OpenAI-compatible providers
codebase config --set rerankerEnabled=true,rerankerProvider=openai-compatible,rerankerOpenAiCompatibleModelId=deepseek-chat

# Search with automatic reranking
codebase search "user authentication"  # Results are automatically reranked by LLM
```

**Benefits:**
- 🎯 **Higher precision**: LLM understands semantic relevance beyond vector similarity
- 📊 **Smart scoring**: Results are reranked on a 0-10 scale based on query relevance  
- ⚡ **Batch processing**: Efficiently handles large result sets with configurable batch sizes
- 🎛️ **Threshold control**: Filter results with `rerankerMinScore` to keep only high-quality matches

#### Path Filtering & Export
```bash
# Path filtering with brace expansion and exclusions
codebase search "API" --path-filters="src/**/*.ts,lib/**/*.js"
codebase search "utils" --path-filters="{src,test}/**/*.ts"

# Export results in JSON format for scripts
codebase search "auth" --json
```

#### Path Filtering & Export

```bash
# Path filtering with brace expansion and exclusions
codebase search "API" --path-filters="src/**/*.ts,lib/**/*.js"
codebase search "utils" --path-filters="{src,test}/**/*.ts"

# Export results in JSON format for scripts
codebase search "auth" --json
```

## ⚙️ Configuration

### Config Layers (Priority Order)
1. **CLI Arguments** - Runtime parameters (`--path`, `--config`, `--log-level`, `--force`, etc.)
2. **Project Config** - `./autodev-config.json` (or custom path via `--config`)
3. **Global Config** - `~/.autodev-cache/autodev-config.json`
4. **Built-in Defaults** - Fallback values

**Note:** CLI arguments provide runtime override for paths, logging, and operational behavior. For persistent configuration (embedderProvider, API keys, search parameters), use `config --set` to save to config files.

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
| **Summarizer** | `summarizerProvider`, `summarizerLanguage`, `summarizerBatchSize` | AI summary generation |

**Key CLI Arguments:**
- `index` - Index the codebase
- `search <query>` - Search the codebase (required positional argument)
- `outline <pattern>` - Extract code outlines (supports glob patterns)
- `call` - Analyze function call relationships and dependency graphs
- `stdio` - Start stdio adapter for MCP
- `config` - Manage configuration (use with --get or --set)
- `--serve` - Start MCP HTTP server (use with `index` command)
- `--summarize` - Generate AI summaries for code outlines
- `--dry-run` - Preview operations before execution
- `--title` - Show only file-level summaries
- `--clear-summarize-cache` - Clear all summary caches
- `--path`, `--demo`, `--force` - Common options
- `--limit` / `-l <number>` - Maximum number of search results (default: from config, max 50)
- `--min-score` / `-S <number>` - Minimum similarity score for search results (0-1, default: from config)
- `--query <patterns>` - Query patterns for call graph analysis (comma-separated)
- `--output <file>` - Export analysis results to JSON file
- `--open` - Open interactive graph viewer
- `--depth <number>` - Set analysis depth for call graphs
- `--help` - Show all available options

**Configuration Commands:**
```bash
# View config
codebase config --get
codebase config --get --json

# Set config (saves to file)
codebase config --set embedderProvider=ollama,embedderModelId=nomic-embed-text
codebase config --set --global embedderProvider=openai,embedderOpenAiApiKey=sk-xxx

# Use custom config file
codebase --config=/path/to/config.json config --get
codebase --config=/path/to/config.json config --set embedderProvider=ollama

# Runtime override (paths, logging, etc.)
codebase index --path=/my/project --log-level=info --force
```

For complete configuration reference, see [CONFIG.md](CONFIG.md).

## 🔌 MCP Integration

### HTTP Streamable Mode (Recommended)
```bash
codebase index --serve --port=3001
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
codebase index --serve --port=3001

# Then connect via stdio adapter in another terminal (for IDEs that require stdio)
codebase stdio --server-url=http://localhost:3001/mcp
```

**IDE Config:**
```json
{
  "mcpServers": {
    "codebase": {
      "command": "codebase",
      "args": ["stdio", "--server-url=http://localhost:3001/mcp"]
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
