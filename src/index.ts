/**
 * @autodev/codebase - Simplified CLI (No React/Ink dependencies)
 * Main entry point for CLI and library exports
 */

import { parseArgs, printHelp } from './cli/args-parser';
import { CodeIndexManager } from './code-index/manager';

// CLI entry point - exported for use by cli.ts
export async function main() {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  // Add cleanup on process exit to dispose singleton instances
  const cleanup = () => {
    try {
      CodeIndexManager.disposeAll();
    } catch (error) {
      // Ignore cleanup errors during exit
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    cleanup();
    process.exit(1);
  });

  if (options.mcpServer) {
    // Pure MCP server mode - no TUI interaction to avoid stdin conflicts
    const { startMCPServerMode } = await import('./cli/mcp-runner');
    await startMCPServerMode(options);
  } else if (options.stdioAdapter) {
    // Stdio adapter mode - bridge stdio to HTTP/SSE
    const { startStdioAdapterMode } = await import('./cli/mcp-runner');
    await startStdioAdapterMode(options);
  } else {
    // Default: show help message (no TUI mode)
    console.log('[CLI] No command specified. Use --help for usage information.');
    console.log('[CLI] Common commands:');
    console.log('  codebase mcp-server      Start MCP server mode');
    console.log('  codebase stdio-adapter   Start stdio adapter mode');
    console.log('  codebase --help          Show full help');
    printHelp();
    process.exit(0);
  }
}
if (process.argv[1] && process.argv[1].endsWith('index.ts')) {
     main();
}

// Library exports
export * from './code-index';
export * from './abstractions';
export * from './adapters/nodejs';
export * from './glob';
export * from './search';
export * from './tree-sitter';
export * from './lib/codebase';
