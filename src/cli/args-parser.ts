export interface CliOptions {
  path: string;
  demo: boolean;
  force: boolean;
  ollamaUrl: string;
  qdrantUrl: string;
  model: string;
  config?: string;
  storage?: string;
  cache?: string;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  help: boolean;
  headless: boolean; // Run without UI, exit after indexing
  mcpServer: boolean;
  mcpPort?: number; // Port for HTTP MCP server
  mcpHost?: string; // Host for HTTP MCP server
  stdioAdapter: boolean; // Whether to run stdio adapter mode
  stdioServerUrl?: string; // HTTP server URL for stdio adapter
  stdioTimeout?: number; // Request timeout for stdio adapter
}

export function parseArgs(argv: string[] = process.argv): CliOptions {
  const args = argv.slice(2);

  const options: CliOptions = {
    path: process.cwd(),
    demo: false,
    force: false,
    ollamaUrl: 'http://localhost:11434',
    qdrantUrl: 'http://localhost:6333',
    model: '',
    logLevel: 'error',
    help: false,
    headless: false,
    mcpServer: false,
    stdioAdapter: false
  };

  // Check for MCP server command (positional argument)
  if (args[0] === 'mcp-server') {
    options.mcpServer = true;
    // Remove the command from args to process remaining options
    args.shift();
  }

  // Check for stdio adapter command (positional argument)
  if (args[0] === 'stdio-adapter') {
    options.stdioAdapter = true;
    // Remove the command from args to process remaining options
    args.shift();
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--demo') {
      options.demo = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--headless') {
      options.headless = true;
    } else if (arg === '--mcp-server') {
      options.mcpServer = true;
    } else if (arg.startsWith('--path=')) {
      options.path = arg.split('=')[1];
    } else if (arg.startsWith('--port=')) {
      const port = parseInt(arg.split('=')[1], 10);
      if (!isNaN(port)) {
        options.mcpPort = port;
      }
    } else if (arg.startsWith('--host=')) {
      options.mcpHost = arg.split('=')[1];
    } else if (arg.startsWith('--server-url=')) {
      options.stdioServerUrl = arg.split('=')[1];
    } else if (arg.startsWith('--timeout=')) {
      const timeout = parseInt(arg.split('=')[1], 10);
      if (!isNaN(timeout)) {
        options.stdioTimeout = timeout;
      }
    } else if (arg.startsWith('--ollama-url=')) {
      options.ollamaUrl = arg.split('=')[1];
    } else if (arg.startsWith('--qdrant-url=')) {
      options.qdrantUrl = arg.split('=')[1];
    } else if (arg.startsWith('--model=')) {
      options.model = arg.split('=')[1];
    } else if (arg.startsWith('--config=')) {
      options.config = arg.split('=')[1];
    } else if (arg.startsWith('--storage=')) {
      options.storage = arg.split('=')[1];
    } else if (arg.startsWith('--cache=')) {
      options.cache = arg.split('=')[1];
    } else if (arg.startsWith('--log-level=')) {
      const level = arg.split('=')[1] as CliOptions['logLevel'];
      if (['error', 'warn', 'info', 'debug'].includes(level)) {
        options.logLevel = level;
      }
    }
  }
  return options;
}

export function printHelp() {
  console.log(`
@autodev/codebase - Code Analysis CLI

Usage:
  codebase [options]                    Show help
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
  --qdrant-url=<url>      Qdrant vector DB URL (default: http://localhost:6333)
  --model=<model>         Embedding model (default: nomic-embed-text)

  --config=<path>         Config file path
  --storage=<path>        Storage directory path
  --cache=<path>          Cache directory path
  --log-level=<level>     Log level: error|warn|info|debug (default: error)
  --force                 Force reindex all files, ignoring cache

  --help, -h              Show this help

Examples:
  # Basic usage
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
