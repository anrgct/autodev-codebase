# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Codebase Library - Development Context

## Project Overview

This is a platform-agnostic code analysis library extracted from the roo-code VSCode plugin. The goal is to create a standalone, cross-platform library that can be integrated into various development tools and environments.

## Architecture

The project follows a layered architecture with dependency injection:

```
Application Layer    (VSCode Plugin / Node.js App)
     ↓
Adapter Layer       (Platform-specific implementations)
     ↓
Core Library        (Platform-agnostic business logic)
```

## Key Abstractions

### Core Interfaces (`src/abstractions/`)
- **IFileSystem** - File operations (readFile, writeFile, exists)
- **IStorage** - Cache and storage management
- **IEventBus** - Event emission and subscription
- **IWorkspace** - Workspace and path utilities
- **IConfigProvider** - Configuration management
- **ILogger** - Logging abstraction
- **IFileWatcher** - File system monitoring

### Platform Adapters
- **VSCode Adapters** (`src/adapters/vscode/`) - VSCode API implementations
- **Node.js Adapters** (`src/adapters/nodejs/`) - Node.js platform implementations

## Core Components

### Code Index System
- **CodeIndexManager** (`src/code-index/manager.ts`) - Main entry point and orchestrator
- **CacheManager** (`src/code-index/cache-manager.ts`) - Vector embedding cache management
- **StateManager** (`src/code-index/state-manager.ts`) - Progress and state tracking
- **DirectoryScanner** (`src/code-index/processors/scanner.ts`) - File discovery and indexing
- **FileWatcher** (`src/code-index/processors/file-watcher.ts`) - File system change monitoring

### Supporting Systems
- **Tree-sitter Parser** (`src/tree-sitter/`) - Code parsing and definition extraction
- **Glob File Listing** (`src/glob/list-files.ts`) - Pattern-based file discovery
- **Search Tools** (`src/codebaseSearchTool.ts`) - Advanced code search capabilities
- **CLI System** (`src/cli/`) - Command-line interface with Terminal UI

## Development Guidelines


### Building
- Build library: `npm run build`
- Generates both ESM and CommonJS outputs
- TypeScript declarations included
- VSCode dependency is optional (peer dependency)

### Code Style
- TypeScript strict mode
- Dependency injection pattern throughout
- Interface-based abstractions
- Platform-agnostic core logic

## Usage Examples

### VSCode Integration
```typescript
import { CodeIndexManager } from '@autodev/codebase'
import { VSCodeAdapters } from '@autodev/codebase/adapters/vscode'

const manager = new CodeIndexManager({
  fileSystem: new VSCodeAdapters.FileSystem(),
  storage: new VSCodeAdapters.Storage(context),
  eventBus: new VSCodeAdapters.EventBus(),
  workspace: new VSCodeAdapters.Workspace(),
  config: new VSCodeAdapters.ConfigProvider()
})
```

### Node.js Usage
```typescript
import { createNodeDependencies } from '@autodev/codebase/adapters/nodejs'
import { CodeIndexManager } from '@autodev/codebase'

const deps = createNodeDependencies({ 
  workspacePath: '/path/to/project',
  storageOptions: { /* ... */ },
  loggerOptions: { /* ... */ },
  configOptions: { /* ... */ }
})

const manager = CodeIndexManager.getInstance(deps)
await manager.initialize()
await manager.startIndexing()
```

### CLI Usage
```bash
# Run interactive TUI with demo
npm run demo-tui

# Run development mode with demo files
npm run dev

# Custom configuration (if using as binary)
npx codebase /path/to/project \
  --model "nomic-embed-text" \
  --ollama-url "http://localhost:11434" \
  --qdrant-url "http://localhost:6333"
```


## Key Files to Understand

- `src/index.ts` - Main library exports
- `src/abstractions/index.ts` - Core interface definitions
- `src/code-index/manager.ts` - Primary API entry point
- `src/adapters/vscode/index.ts` - VSCode integration layer
- `src/adapters/nodejs/index.ts` - Node.js platform adapters
- `src/cli.ts` - CLI entry point with environment polyfills
- `src/cli/tui-runner.ts` - Terminal UI application implementation
- `examples/nodejs-usage.ts` - Node.js integration examples

## Commands

### Development
- `npm run dev` - Watch mode development (removes cache and runs with demo files)
- `npm run build` - Production build (creates both ESM and CommonJS outputs)
- `npm run type-check` - TypeScript validation
- `npm run demo-tui` - Run TUI demo application

### CLI Interface
- **Entry Point**: `src/cli.ts` - Command-line interface launcher with polyfills
- **TUI Runner**: `src/cli/tui-runner.ts` - Terminal UI application runner  
- **CLI Features**:
  - Interactive Terminal UI for code indexing
  - Full CodeIndexManager initialization with React UI
  - Demo mode with sample file generation
  - Configurable storage, cache, and logging
  - Support for custom models and Qdrant endpoints


## Notes for AI Assistants

1. **Dependency Injection**: All core components use dependency injection - never directly import platform-specific modules
2. **Interface First**: Always program against interfaces (I*) rather than concrete implementations
3. **Platform Agnostic**: Core library code should work in any JavaScript environment
4. **Optional VSCode**: VSCode is a peer dependency - the library works without it
5. **Testing Strategy**: Use mock implementations of interfaces for testing
6. **Build Target**: Library supports both ESM and CommonJS for maximum compatibility

This codebase demonstrates enterprise-level abstraction patterns and clean architecture principles for creating truly portable JavaScript libraries.

## Development Notes

### CodeIndexManager Initialization
1. `createNodeDependencies()` → Creates platform adapters
2. `CodeIndexManager.getInstance(deps)` → Requires valid `workspace.getRootPath()`
3. `manager.initialize()` → Initializes internal services
4. `manager.startIndexing()` → Triggers orchestrator

### React Integration
When integrating with React, use `useEffect` to sync prop changes:
```typescript
useEffect(() => {
  setState(prev => ({ ...prev, codeIndexManager }));
}, [codeIndexManager]);
```
