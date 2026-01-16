/**
 * Stdio command implementation
 */
import { Command } from 'commander';
import { getLogger, initGlobalLogger } from './shared';
import { StdioToStreamableHTTPAdapter } from '../mcp/stdio-adapter';

/**
 * Stdio command handler
 */
async function stdioHandler(options: any): Promise<void> {
  initGlobalLogger(options.logLevel || 'error');

  const targetUrl = options.serverUrl || `http://${options.host}:${options.port}/mcp`;
  const timeout = options.timeout && !Number.isNaN(options.timeout)
    ? options.timeout
    : 30000;

  getLogger().info('Starting stdio adapter mode');
  getLogger().info(`Target MCP HTTP endpoint: ${targetUrl}`);
  getLogger().info(`Request timeout: ${timeout}ms`);

  const adapter = new StdioToStreamableHTTPAdapter({
    serverUrl: targetUrl,
    timeout,
  });

  const handleShutdown = () => {
    getLogger().info('Shutting down stdio adapter...');
    adapter.stop();
    process.exit(0);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  await adapter.start();

  return new Promise(() => {}); // Keep alive
}

/**
 * Create stdio command
 */
export function createStdioCommand(): Command {
  const command = new Command('stdio');

  command
    .description('Start stdio adapter (bridge stdio <-> HTTP MCP server)')
    .option('--server-url <url>', 'Target MCP HTTP endpoint')
    .option('--port <port>', 'Server port (default: 3001)', '3001')
    .option('--host <host>', 'Server host (default: localhost)', 'localhost')
    .option('--timeout <ms>', 'Request timeout in milliseconds', '30000')
    .option('--log-level <level>', 'Log level: debug|info|warn|error', 'error')
    .action(stdioHandler);

  return command;
}
