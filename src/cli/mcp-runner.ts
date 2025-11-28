/**
 * MCP Server Mode Runner
 * Contains functions for starting MCP server and stdio adapter modes.
 * No React/Ink dependencies - pure Node.js implementation.
 */

import * as path from 'path';
import fs from 'fs';
import { createNodeDependencies } from '../adapters/nodejs';
import { CodeIndexManager } from '../code-index/manager';
import { CliOptions } from './args-parser';
import createSampleFiles from '../examples/create-sample-files';
import { CodebaseHTTPMCPServer } from '../mcp/http-server.js';

// Helper function to create HTTP MCP server
async function createHTTPMCPServer(manager: CodeIndexManager, options?: { port?: number; host?: string }): Promise<CodebaseHTTPMCPServer> {
  const server = new CodebaseHTTPMCPServer({
    codeIndexManager: manager,
    port: options?.port,
    host: options?.host
  });

  await server.start();
  return server;
}

export async function startStdioAdapterMode(options: CliOptions): Promise<void> {
  // console.log('🔌 Starting Stdio Adapter Mode');
  // console.log(`🌐 Connecting to server: ${options.stdioServerUrl || 'http://localhost:3001'}`);
  // console.log(`⏱️ Request timeout: ${options.stdioTimeout || 30000}ms`);

  const { StdioToStreamableHTTPAdapter } = await import('../mcp/stdio-adapter');

  const adapter = new StdioToStreamableHTTPAdapter({
    serverUrl: options.stdioServerUrl || 'http://localhost:3001/mcp',
    timeout: options.stdioTimeout || 30000
  });

  try {
    await adapter.start();

    // Handle graceful shutdown
    const handleShutdown = () => {
      console.error('🔄 Shutting down stdio adapter...');
      adapter.stop();
      process.exit(0);
    };

    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);

    // Keep the process alive to handle stdio communication
    return new Promise(() => {}); // Never resolves
  } catch (error) {
    console.error('❌ Stdio adapter failed to start:', error);
    process.exit(1);
  }
}

export async function startMCPServerMode(options: CliOptions): Promise<void> {
  // Ensure options.path is absolute; if not, prepend process.cwd()
  let resolvedPath = options.path;
  if (!path.isAbsolute(resolvedPath)) {
    resolvedPath = path.join(process.cwd(), resolvedPath);
  }

  // Create workspace path - use demo subdirectory if --demo flag is set
  const workspacePath = options.demo
    ? path.join(resolvedPath, 'demo')
    : resolvedPath;

  // Use config file from workspace directory
  const configPath = options.config || path.join(workspacePath, 'autodev-config.json');

  console.log('🚀 Starting MCP Server Mode');
  console.log(`📂 Workspace: ${workspacePath}`);
  console.log(`⚙️ Config: ${configPath}`);

  const deps = createNodeDependencies({
    workspacePath,
    storageOptions: {
      globalStoragePath: options.storage || path.join(process.cwd(), '.autodev-storage'),
      ...(options.cache && { cacheBasePath: options.cache })
    },
    loggerOptions: {
      name: 'Autodev-Codebase-MCP',
      level: options.logLevel,
      timestamps: true,
      colors: false // Disable colors for MCP server mode
    },
    configOptions: {
      configPath,
      cliOverrides: {
        ollamaUrl: options.ollamaUrl,
        model: options.model,
        qdrantUrl: options.qdrantUrl
      }
    }
  });

  try {
    // Create demo files if requested
    if (options.demo) {
      const workspaceExists = await deps.fileSystem.exists(workspacePath);
      if (!workspaceExists) {
        fs.mkdirSync(workspacePath, { recursive: true });
        await createSampleFiles(deps.fileSystem, workspacePath);
        console.log(`📁 Demo files created in: ${workspacePath}`);
      }
    }

    console.log('⚙️ Loading configuration...');
    const config = await deps.configProvider.loadConfig();

    console.log('✅ Validating configuration...');
    const validation = await deps.configProvider.validateConfig();

    if (!validation.isValid) {
      console.warn('⚠️ Configuration validation warnings:', validation.errors);
      console.log('⚠️ Continuing initialization (debug mode)');
    } else {
      console.log('✅ Configuration validation passed');
    }

    console.log('🔧 Creating CodeIndexManager...');
    const manager = CodeIndexManager.getInstance(deps);

    if (!manager) {
      throw new Error('Failed to create CodeIndexManager - workspace root path may be invalid');
    }

    console.log('⚙️ Initializing CodeIndexManager...');
    const initResult = await manager.initialize({ force: options.force });
    console.log('✅ CodeIndexManager initialization success');

    // Start MCP Server
    console.log('🚀 Starting MCP Server...');
    const server = await createHTTPMCPServer(manager, {
      port: options.mcpPort,
      host: options.mcpHost
    });
    console.log('✅ MCP Server started successfully');

    // Display configuration instructions
    console.log('\n🔗 MCP Server is now running!');
    console.log('To connect your IDE to the HTTP Streamable MCP server, use the following configuration:');
    console.log(JSON.stringify({
      "mcpServers": {
      "codebase": {
        "url": `http://${options.mcpHost || 'localhost'}:${options.mcpPort || 3001}/mcp`
      }
      }
    }, null, 2));
    console.log('Alternatively, to use MCP in stdio mode:');
    console.log(JSON.stringify({
      "mcpServers": {
      "codebase": {
        "command": "codebase",
        "args": ["stdio-adapter", `--server-url=http://${options.mcpHost || 'localhost'}:${options.mcpPort || 3001}/mcp`]
      }
      }
    }, null, 2));
    console.log('');

    // Start indexing in background
    console.log('🚀 Starting indexing process...');
    manager.onProgressUpdate((progressInfo) => {
      console.log(`📊 Indexing progress: ${progressInfo.systemStatus} - ${progressInfo.message || ''}`);
    });

    if (manager.isFeatureEnabled && manager.isInitialized) {
      manager.startIndexing()
        .then(() => {
          console.log('✅ Indexing completed');
        })
        .catch((err: any) => {
          console.error('❌ Indexing failed:', err.message);
        });
    } else {
      console.warn('⚠️ Skipping indexing - feature not enabled or not initialized');
    }

    // Handle graceful shutdown
    const handleShutdown = async () => {
      console.log('\n🔄 Shutting down MCP Server...');
      await server.stop();
      console.log('✅ MCP Server stopped');
      process.exit(0);
    };

    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);

    console.log('📡 MCP Server is ready for connections. Press Ctrl+C to stop.');

    // Keep the process alive
    return new Promise(() => {}); // This never resolves, keeping the server running

  } catch (err: any) {
    console.error('❌ MCP Server initialization failed:', err.message);
    process.exit(1);
  }
}
