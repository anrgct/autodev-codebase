import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export interface CliOptions {
  path: string;
  demo: boolean;
  force: boolean;
  ollamaUrl: string;
  ollamaApiKey?: string;
  qdrantUrl: string;
  qdrantApiKey?: string;
  model: string;
  config?: string;
  storage?: string;
  cache?: string;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  help: boolean;
  mcpServer: boolean;
  mcpPort?: number; // Port for HTTP MCP server
  mcpHost?: string; // Host for HTTP MCP server
  stdioAdapter: boolean; // Whether to run stdio adapter mode
  stdioServerUrl?: string; // HTTP server URL for stdio adapter
  stdioTimeout?: number; // Request timeout for stdio adapter
}

export function parseArgs(argv: string[] = process.argv): CliOptions {
  const parser = yargs(hideBin(argv))
    .scriptName('codebase')
    .usage('codebase [command] [options]')
    .command('mcp-server', 'Start MCP HTTP server mode')
    .command('stdio-adapter', 'Start stdio adapter mode')
    .option('path', {
      type: 'string',
      default: process.cwd(),
      describe: 'Workspace path',
    })
    .option('demo', {
      type: 'boolean',
      default: false,
      describe: 'Create demo files in workspace',
    })
    .option('force', {
      type: 'boolean',
      default: false,
      describe: 'Force reindex all files, ignoring cache',
    })
    .option('ollama-url', {
      type: 'string',
      default: 'http://localhost:11434',
      describe: 'Ollama API URL',
    })
    .option('ollama-api-key', {
      type: 'string',
      describe: 'Ollama API key',
    })
    .option('qdrant-url', {
      type: 'string',
      default: 'http://localhost:6333',
      describe: 'Qdrant vector DB URL',
    })
    .option('qdrant-api-key', {
      type: 'string',
      describe: 'Qdrant API key',
    })
    .option('model', {
      type: 'string',
      default: '',
      describe: 'Embedding model',
    })
    .option('config', {
      type: 'string',
      describe: 'Config file path',
    })
    .option('storage', {
      type: 'string',
      describe: 'Storage directory path',
    })
    .option('cache', {
      type: 'string',
      describe: 'Cache directory path',
    })
    .option('log-level', {
      type: 'string',
      choices: ['error', 'warn', 'info', 'debug'] as const,
      default: 'error',
      describe: 'Log level',
    })
    .option('port', {
      type: 'number',
      describe: 'HTTP server port for MCP mode',
    })
    .option('host', {
      type: 'string',
      describe: 'HTTP server host for MCP mode',
    })
    .option('server-url', {
      type: 'string',
      describe: 'HTTP server URL for stdio adapter',
    })
    .option('timeout', {
      type: 'number',
      describe: 'Request timeout for stdio adapter (ms)',
    })
    .help('help')
    .alias('help', 'h')
    .strict(false) // tolerate extra args so existing flows keep working
    .parserConfiguration({ 'camel-case-expansion': false })
    .exitProcess(false); // We handle exit ourselves in index.ts

  const parsed = parser.parseSync();

  // Determine mode from positional command, but allow explicit flags too
  const firstPositional = parsed._[0];
  const mcpServer = parsed['mcp-server'] === true || firstPositional === 'mcp-server';
  const stdioAdapter = parsed['stdio-adapter'] === true || firstPositional === 'stdio-adapter';

  return {
    path: parsed.path as string,
    demo: Boolean(parsed.demo),
    force: Boolean(parsed.force),
    ollamaUrl: parsed['ollama-url'] as string,
    ollamaApiKey: parsed['ollama-api-key'] as string | undefined,
    qdrantUrl: parsed['qdrant-url'] as string,
    qdrantApiKey: parsed['qdrant-api-key'] as string | undefined,
    model: parsed.model as string,
    config: parsed.config as string | undefined,
    storage: parsed.storage as string | undefined,
    cache: parsed.cache as string | undefined,
    logLevel: (parsed['log-level'] as CliOptions['logLevel']) ?? 'error',
    help: Boolean(parsed['help']),
    mcpServer,
    mcpPort: parsed.port as number | undefined,
    mcpHost: parsed.host as string | undefined,
    stdioAdapter,
    stdioServerUrl: parsed['server-url'] as string | undefined,
    stdioTimeout: parsed.timeout as number | undefined,
  };
}

export function printHelp() {
  console.log(`
@autodev/codebase - Code Analysis TUI

Usage:
  codebase [options]                    Run TUI mode (default)
  codebase mcp-server [options]         Start MCP server mode
  codebase stdio-adapter [options]      Start stdio adapter mode

Options:
  --path=<path>           Workspace path (default: current directory)
  --demo                  Create demo files in workspace
  --force                 Force reindex all files, ignoring cache

MCP Server Options:
  --port=<port>           HTTP server port (default: 3001)
  --host=<host>           HTTP server host (default: localhost)

Stdio Adapter Options:
  --server-url=<url>      Full SSE endpoint URL (default: http://localhost:3001/sse)
  --timeout=<ms>          Request timeout in milliseconds (default: 30000)

  --ollama-url=<url>      Ollama API URL (default: http://localhost:11434)
  --ollama-api-key=<key>  Ollama API key
  --qdrant-url=<url>      Qdrant vector DB URL (default: http://localhost:6333)
  --qdrant-api-key=<key>  Qdrant API key
  --model=<model>         Embedding model (default: dengcao/Qwen3-Embedding-0.6B:Q8_0)

  --config=<path>         Config file path
  --storage=<path>        Storage directory path
  --cache=<path>          Cache directory path
  --log-level=<level>     Log level: error|warn|info|debug (default: error)
  --force                 Force reindex all files, ignoring cache

  --help, -h              Show this help

Examples:
  # TUI mode
  codebase --path=/my/project
  codebase --demo --log-level=info
  codebase --force --path=/my/project    # Force reindex

  # MCP Server mode (long-running)
  cd /my/project
  codebase mcp-server                   # Use current directory
  codebase mcp-server --port=3001       # Custom port
  codebase mcp-server --path=/workspace # Explicit path
  codebase mcp-server --force           # Force reindex in server mode

  # Stdio Adapter mode
  codebase stdio-adapter                                      # Connect to default SSE endpoint
  codebase stdio-adapter --server-url=http://localhost:3001/sse  # Custom SSE endpoint URL

  # Client configuration in IDE (e.g., Cursor):
  {
    "mcpServers": {
      "codebase": {
        "url": "http://localhost:3001/sse"
      }
    }
  }
`);
}
