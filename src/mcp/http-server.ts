import express, { Request, Response } from 'express';
import { createServer, Server as HTTPServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import {
    CallToolResult,
    TextContent,
    isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { CodeIndexManager } from '../code-index/manager';
import { validateLimit, validateMinScore } from '../code-index/validate-search-params';
import { extractOutline } from '../cli-tools/outline';
import { resolveOutlineTargets } from '../cli-tools/outline-targets';
import * as path from 'path';
import { createNodeDependencies } from '../adapters/nodejs';

export interface HTTPMCPServerOptions {
    codeIndexManager: CodeIndexManager;
    port?: number;
    host?: string;
}

export class CodebaseHTTPMCPServer {
    private mcpServer: McpServer;
    private httpServer!: HTTPServer;
    private expressApp!: express.Application;
    private codeIndexManager: CodeIndexManager;
    private port: number;
    private host: string;
    private transports: Map<string, StreamableHTTPServerTransport> = new Map();

    constructor(options: HTTPMCPServerOptions) {
        this.codeIndexManager = options.codeIndexManager;
        this.port = options.port || 3001;
        this.host = options.host || 'localhost';

        this.mcpServer = new McpServer({
            name: 'codebase-mcp-server',
            version: '1.0.0',
        });

        this.setupTools();
        this.setupHTTPServer();
    }

    private setupTools() {
        // Register search_codebase tool
        this.mcpServer.tool(
            'search_codebase',
            "Search the codebase using semantic vector search to find relevant code snippets.",
            {
                query: z.string().describe("An English complete question about what you want to understand. Ask as if talking to a colleague: 'How does X work?', 'What happens when Y?', 'Where is Z handled?'"),
                // 移除 default()，避免覆盖配置默认值
                limit: z.union([
                    z.coerce.number(),
                    z.string().transform(s => Number(s))
                ]).optional()
                .describe(
                    'Max results. Do NOT set this parameter manually - let the server use its configured default (20). ' +
                    'Only override if user explicitly requests a specific number.'
                ),
                filters: z.object({
                    pathFilters: z.array(z.string()).optional().describe(
                        "Filter paths using glob-like patterns. **Patterns are relative to the project root directory.**\n\n" +

                        "**Logic:**\n" +
                        "- Include patterns (no ! prefix): OR logic - matches ANY pattern\n" +
                        "- Exclude patterns (! prefix): AND logic - applied globally to exclude ALL matches\n" +
                        "- Within each pattern: case-insensitive substring matching, order-independent, all parts must exist\n\n" +

                        "**Supported:**\n" +
                        "- ** (recursive), * (single-level), {a,b} (braces), !prefix (exclude)\n\n" +

                        "**Examples:**\n" +
                        "- ['src/**/*.ts'] → src tree only\n" +
                        "- ['src/**/*.ts', 'lib/**/*.ts'] → src OR lib\n" +
                        "- ['**/*.ts', '!**/*.test.ts'] → all .ts excluding tests\n" +
                        "- ['src/{components,utils}/*.ts'] → specific folders\n" +
                        "- ['!.md'] → code only, exclude docs"
                    ),
                    minScore: z.union([
                        z.coerce.number(),
                        z.string().transform(s => Number(s))
                    ]).optional()
                    .describe(
                        'Minimum similarity threshold. Do NOT set manually - uses configured default. ' +
                        'Only override if user requests specific quality level.'
                    )
                }).optional().describe('Optional filters for file types, paths, etc.')
            },
            async ({ query, limit, filters }): Promise<CallToolResult> => {
                if (!query || !query.trim() || typeof query !== 'string') {
                    throw new Error('Query parameter is required and must be a string');
                }
                // console.log(`🔍[MCP Server] Handling search_codebase with query: "${query}", limit: ${limit}, filters:`, filters);
                return await this.handleSearchCodebase({ query, limit, filters });
            }
        );

        // Register outline_codebase tool
        this.mcpServer.tool(
            'outline_codebase',
            "Extract code structure outline from source files using tree-sitter parsing. Supports both single files and glob patterns.",
            {
                path: z.string()
                    .describe(
                        "File path or glob pattern to extract outline from. **Paths are relative to the project root directory.**\n\n" +
                        "**Examples:**\n" +
                        "- 'src/index.ts' → Single file\n" +
                        "- '*' → List files in root directory(Recommended)\n" +
                        "- '**/*.ts' → All TypeScript files\n" +
                        "- 'src/**/*.ts' → TypeScript files in src directory\n" +
                        "- 'src/**/*.ts,lib/**/*.ts' → Multiple patterns (comma-separated)\n" +
                        "- '**/*.ts,!**/*.test.ts' → Include + exclude patterns"
                    ),
                summarize: z.boolean().optional()
                    .describe(
                        "Generate AI summaries for each code definition (functions, classes, etc.).\n" +
                        "Requires a configured summarizer in autodev-config.json.\n" +
                        "Default: false"
                    ),
                title: z.boolean().optional()
                    .describe(
                        "Only show file summary without detailed definition listings.\n" +
                        "When true, displays only file path and overall file-level summary(summarize on).\n" +
                        "Default: false"
                    )
            },
            async ({ path, summarize, title }): Promise<CallToolResult> => {
                return await this.handleOutlineCodebase({ path, summarize, title });
            }
        );

        // disable for uncompleted feature
        // // Register get_search_stats tool
        // this.mcpServer.tool(
        //     'get_search_stats',
        //     'Get statistics about the codebase index including file count, indexed files, and indexing status.',
        //     async (): Promise<CallToolResult> => {
        //         return await this.handleGetSearchStats();
        //     }
        // );

        // // Register configure_search tool
        // this.mcpServer.tool(
        //     'configure_search',
        //     'Configure search settings like model parameters or update the index.',
        //     {
        //         action: z.enum(['refresh_index', 'update_model']).describe('The configuration action to perform'),
        //         model: z.string().optional().describe('New embedding model to use (for update_model action)')
        //     },
        //     async ({ action, model }): Promise<CallToolResult> => {
        //         return await this.handleConfigureSearch({ action, model });
        //     }
        // );
    }

    private createServer(): McpServer {
        return this.mcpServer;
    }

    private async handleSearchCodebase(args: any): Promise<CallToolResult> {
        const { query, limit, filters } = args;

        if (!query || typeof query !== 'string') {
            throw new Error('Query parameter is required and must be a string');
        }

        if (!this.codeIndexManager.isInitialized || !this.codeIndexManager.isFeatureEnabled) {
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Code index is not ready. Please wait for indexing to complete or check if the feature is enabled.',
                    },
                ],
            };
        }

        try {
            // 只有传入时才验证，未传则让service层处理
            const finalLimit = limit === undefined ? undefined : validateLimit(limit)
            const finalMinScore = filters?.minScore === undefined ? undefined : validateMinScore(filters.minScore)

            // Extract search filter from the filters parameter
            const searchFilter = {
                limit: finalLimit,
                minScore: finalMinScore,
                pathFilters: filters?.pathFilters
            };
            const searchResults = await this.codeIndexManager.searchIndex(query, searchFilter);

            if (!searchResults || searchResults.length === 0) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `No results found for query: "${query}"`,
                        },
                    ],
                };
            }

            // 按文件路径分组搜索结果
            const resultsByFile = new Map<string, any[]>();
            searchResults.forEach((result: any) => {
                const filePath = result.payload?.filePath || 'Unknown file';
                if (!resultsByFile.has(filePath)) {
                    resultsByFile.set(filePath, []);
                }
                resultsByFile.get(filePath)!.push(result);
            });

            const formattedResults = Array.from(resultsByFile.entries()).map(([filePath, results]) => {
                // 对同一文件的结果按行号排序
                results.sort((a, b) => {
                    const lineA = a.payload?.startLine || 0;
                    const lineB = b.payload?.startLine || 0;
                    return lineA - lineB;
                });


                // 去重：移除被其他片段包含的重复片段
                const deduplicatedResults = [];
                for (let i = 0; i < results.length; i++) {
                    const current = results[i];
                    const currentStart = current.payload?.startLine || 0;
                    const currentEnd = current.payload?.endLine || 0;

                    // 检查当前片段是否被其他片段包含
                    let isContained = false;
                    for (let j = 0; j < results.length; j++) {
                        if (i === j) continue; // 跳过自己

                        const other = results[j];
                        const otherStart = other.payload?.startLine || 0;
                        const otherEnd = other.payload?.endLine || 0;

                        // 如果当前片段被其他片段完全包含，则标记为重复
                        if (otherStart <= currentStart && otherEnd >= currentEnd &&
                            !(otherStart === currentStart && otherEnd === currentEnd)) {
                            isContained = true;
                            break;
                        }
                    }

                    // 如果没有被包含，则保留这个片段
                    if (!isContained) {
                        deduplicatedResults.push(current);
                    }
                }

                // 使用去重后的结果计算平均分数
                const avgScore = deduplicatedResults.length > 0
                    ? deduplicatedResults.reduce((sum, r) => sum + (r.score || 0), 0) / deduplicatedResults.length
                    : 0;

                // 合并代码片段，优化显示格式
                const codeChunks = deduplicatedResults.map((result: any, index: number) => {
                    const codeChunk = result.payload?.codeChunk || 'No content available';
                    const startLine = result.payload?.startLine;
                    const endLine = result.payload?.endLine;
                    const lineInfo = (startLine !== undefined && endLine !== undefined)
                        ? `(L${startLine}-${endLine})`
                        : '';
                    const hierarchyInfo = result.payload?.hierarchyDisplay ? `< ${result.payload?.hierarchyDisplay} > `
                    : '';
                    const score = result.score?.toFixed(3) || '1.000';
                    return `${hierarchyInfo}${lineInfo}
${codeChunk}`;
                }).join('\n' + '─'.repeat(5) + '\n');

                const snippetInfo = deduplicatedResults.length > 1 ? ` | ${deduplicatedResults.length} snippets` : '';
                const duplicateInfo = results.length !== deduplicatedResults.length
                    ? ` (${results.length - deduplicatedResults.length} duplicates removed)`
                    : '';
                return `File: \`${filePath}\`${snippetInfo}${duplicateInfo}
\`\`\`
${codeChunks}
\`\`\`
`;
            });

            const fileCount = resultsByFile.size;
            const summary = `Found ${searchResults.length} result${searchResults.length > 1 ? 's' : ''} in ${fileCount} file${fileCount > 1 ? 's' : ''} for: "${query}"\n\n${formattedResults.join('\n')}`;

            console.log(`🔍[MCP Server] ${searchResults.length} results in ${fileCount} files for "${query}"`);
            return {
                content: [
                    {
                        type: 'text',
                        text: summary,
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Search failed: ${message}`);
        }
    }

    private async handleGetSearchStats(): Promise<CallToolResult> {
        try {
            const state = this.codeIndexManager.state;
            const isReady = this.codeIndexManager.isInitialized && this.codeIndexManager.isFeatureEnabled;
            const currentStatus = this.codeIndexManager.getCurrentStatus();

            const stats = {
                isReady,
                isInitialized: this.codeIndexManager.isInitialized,
                isFeatureEnabled: this.codeIndexManager.isFeatureEnabled,
                indexingStatus: state,
                message: currentStatus.message || 'No message available',
            };

            const summary = `**Codebase Index Statistics**

**Status:** ${isReady ? '✅ Ready' : '⏳ Not Ready'}
**Indexing Status:** ${stats.indexingStatus}
**Feature Enabled:** ${stats.isFeatureEnabled ? 'Yes' : 'No'}
**Initialized:** ${stats.isInitialized ? 'Yes' : 'No'}
**Message:** ${stats.message}
`;

            return {
                content: [
                    {
                        type: 'text',
                        text: summary,
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to get stats: ${message}`);
        }
    }

    private async handleConfigureSearch(args: any): Promise<CallToolResult> {
        const { action, model } = args;

        let result: string;
        switch (action) {
            case 'refresh_index':
                await this.codeIndexManager.clearIndexData();
                await this.codeIndexManager.startIndexing();
                result = 'Index refresh started successfully';
                break;
            case 'update_model':
                result = `Model update not yet implemented. Current configuration needs to be changed externally.`;
                break;
            default:
                throw new Error(`Unknown action: ${action}`);
        }

        const summary = `**Search Configuration Updated**

**Action:** ${action}
**Result:** ${result}

Note: Configuration changes will apply to subsequent searches.
`;

        return {
            content: [
                {
                    type: 'text',
                    text: summary,
                },
            ],
        };
    }

    /**
     * Handle outline_codebase tool request
     */
    private async handleOutlineCodebase(args: { path: string; summarize?: boolean; title?: boolean }): Promise<CallToolResult> {
        const { path: pattern, summarize, title } = args;

        // Validate path parameter
        if (!pattern || typeof pattern !== 'string' || !pattern.trim()) {
            return {
                content: [{ type: 'text', text: 'Error: Path parameter is required and must be a non-empty string' }],
                isError: true
            };
        }

        const trimmedPattern = pattern.trim();
        const workspacePath = this.codeIndexManager.workspacePathValue;

        try {
            // Create dependencies inline (similar to CLI approach)
            const configPath = path.join(workspacePath, 'autodev-config.json');
            const deps = createNodeDependencies({
                workspacePath,
                storageOptions: {
                    globalStoragePath: path.join(workspacePath, '.autodev-storage')
                },
                loggerOptions: {
                    name: 'outline-mcp',
                    level: 'error',
                    timestamps: false,
                    colors: false
                },
                configOptions: { configPath }
            });

            const resolved = await resolveOutlineTargets({
                input: trimmedPattern,
                workspacePath,
                workspace: deps.workspace,
                pathUtils: deps.pathUtils,
                fileSystem: deps.fileSystem,
                skipIgnoreCheckForSingleFile: true,
                logger: deps.logger
            })

            if (resolved.files.length === 0) {
                return {
                    content: [{ type: 'text', text: `No files found matching: ${trimmedPattern}` }]
                };
            }

            if (!resolved.isGlob) {
                const result = await extractOutline({
                    filePath: resolved.files[0],
                    workspacePath,
                    json: false,
                    summarize: summarize ?? false,
                    title: title ?? false,
                    configPath,
                    fileSystem: deps.fileSystem,
                    workspace: deps.workspace,
                    pathUtils: deps.pathUtils,
                    logger: deps.logger,
                    skipIgnoreCheck: true
                });

                return {
                    content: [{ type: 'text', text: result }]
                };
            }

            const maxFiles = summarize ? 5 : 20;
            const wasLimited = resolved.files.length > maxFiles;
            const filesToProcess = wasLimited ? resolved.files.slice(0, maxFiles) : resolved.files;

            const results: string[] = [];
            const errors: string[] = [];

            for (const file of filesToProcess) {
                try {
                    const result = await extractOutline({
                        filePath: file,
                        workspacePath,
                        json: false,
                        summarize: summarize ?? false,
                        title: title ?? false,
                        configPath,
                        fileSystem: deps.fileSystem,
                        workspace: deps.workspace,
                        pathUtils: deps.pathUtils,
                        logger: deps.logger
                    });
                    results.push(result);
                } catch (error) {
                    const fileRelativePath = deps.workspace.getRelativePath(file)
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    errors.push(`${fileRelativePath}: ${errorMsg}`);
                    deps.logger?.warn?.(`Failed to process ${file}: ${errorMsg}`);
                }
            }

            let output = results.join('\n\n---\n\n');

            if (wasLimited) {
                const excludedFiles = resolved.files.slice(maxFiles);
                const sampleSize = 5;
                const sampledExcluded = excludedFiles.slice(0, sampleSize);
                let excludedList = sampledExcluded.map(f => `  - ${deps.workspace.getRelativePath(f)}`).join('\n');
                if (excludedFiles.length > sampleSize) {
                    excludedList += `\n  ... and ${excludedFiles.length - sampleSize} more files`;
                }

                output = output +
                    '\n\n---\n\n' +
                    `Found ${resolved.files.length} files matching pattern "${trimmedPattern}", limiting to first ${maxFiles} files.\n\n` +
                    `Excluded (${excludedFiles.length} files):\n${excludedList}\n\n` +
                    `Tip: Use exact filenames to view specific files.`;
            }

            if (errors.length > 0) {
                output += '\n\nErrors:\n' + errors.map(e => `  - ${e}`).join('\n');
            }

            return {
                content: [{ type: 'text', text: output }]
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: 'text', text: `Error: ${message}` }],
                isError: true
            };
        }
    }




    private generateSessionId(): string {
        return randomUUID();
    }

    private setupHTTPServer() {
        const app = express();
        app.use(express.json());

        // Minimal CORS - only if needed
        app.use((req: any, res: any, next: any) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            // Allow MCP-specific headers used by browser-based clients (e.g. Inspector)
            // Note: header names are case-insensitive, but we include common casings for clarity.
            res.setHeader(
                'Access-Control-Allow-Headers',
                [
                    'Content-Type',
                    'MCP-Session-ID',
                    'mcp-session-id',
                    'MCP-Protocol-Version',
                    'mcp-protocol-version',
                    'Authorization',
                    'X-MCP-Proxy-Token',
                    'x-mcp-proxy-token',
                ].join(', ')
            );
            // Expose MCP-specific headers so browser clients (Inspector) can read the
            // session ID and negotiated protocol version from responses.
            res.setHeader(
                'Access-Control-Expose-Headers',
                [
                    'Content-Type',
                    'MCP-Session-ID',
                    'mcp-session-id',
                    'MCP-Protocol-Version',
                    'mcp-protocol-version',
                ].join(', ')
            );

            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }
            next();
        });

        // MCP endpoint handler
        const mcpHandler = async (req: Request, res: Response) => {
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            // console.log(sessionId ? `Received MCP request for session: ${sessionId}` : 'Received MCP request:', req.body);

            try {
                let transport: StreamableHTTPServerTransport;
                if (sessionId && this.transports.has(sessionId)) {
                    // Reuse existing transport
                    transport = this.transports.get(sessionId)!;
                } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
                    // New initialization request
                    const eventStore = new InMemoryEventStore();
                    const newSessionId = randomUUID();
                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => newSessionId,
                        eventStore, // Enable resumability
                        onsessioninitialized: (sessionId) => {
                            console.log(`Session initialized with ID: ${sessionId}`);
                            this.transports.set(sessionId, transport);
                            // Set the session ID in response header for client to extract
                            res.setHeader('MCP-Session-ID', sessionId);
                        }
                    });

                    // Set up onclose handler to clean up transport when closed
                    transport.onclose = () => {
                        const sid = transport.sessionId;
                        if (sid && this.transports.has(sid)) {
                            console.log(`Transport closed for session ${sid}, removing from transports map`);
                            this.transports.delete(sid);
                        }
                    };

                    // Connect the transport to the MCP server
                    await this.mcpServer.connect(transport);
                    await transport.handleRequest(req, res, req.body);
                    return;
                } else {
                    // Invalid request
                    res.status(400).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32000,
                            message: 'Bad Request: No valid session ID provided',
                        },
                        id: null,
                    });
                    return;
                }

                // Handle the request with existing transport
                await transport.handleRequest(req, res, req.body);
            } catch (error) {
                console.error('Error handling MCP request:', error);
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32603,
                            message: 'Internal server error',
                        },
                        id: null,
                    });
                }
            }
        };

        // Set up MCP endpoints
        app.post('/mcp', mcpHandler);
        app.get('/mcp', mcpHandler);
        app.delete('/mcp', mcpHandler);

        // Health check endpoint
        app.get('/health', (req: any, res: any) => {
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                workspace: this.codeIndexManager.workspacePathValue
            });
        });

        // Welcome page
        app.get('/', (req: any, res: any) => {
            res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Codebase MCP Server</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .container { max-width: 800px; margin: 0 auto; }
        pre { background: #f5f5f5; padding: 20px; border-radius: 5px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔍 Codebase MCP Server</h1>
        <p>Status: <strong style="color: green;">Running</strong></p>
        <p>Workspace: <code>${this.codeIndexManager.workspacePathValue}</code></p>

        <h2>Endpoints</h2>
        <ul>
            <li><code>POST /mcp</code> - MCP JSON-RPC endpoint</li>
            <li><code>GET /mcp</code> - MCP SSE stream endpoint</li>
            <li><code>DELETE /mcp</code> - MCP session termination endpoint</li>
            <li><code>GET /health</code> - Health check</li>
        </ul>

        <h2>Client Configuration</h2>
        <p>MCP endpoint: <code>http://${this.host}:${this.port}/mcp</code></p>
        <p>Use MCP-Session-ID header for session management</p>
    </div>
</body>
</html>
            `);
        });

        this.expressApp = app;
        this.httpServer = createServer(app);
    }

    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.httpServer.listen(this.port, this.host, () => {
                console.log(`🔍 Codebase MCP Server running at http://${this.host}:${this.port}`);
                console.log(`📁 Workspace: ${this.codeIndexManager.workspacePathValue}`);
                console.log(`🌐 MCP endpoint: http://${this.host}:${this.port}/mcp`);
                console.log(`❤️  Health check: http://${this.host}:${this.port}/health`);
                resolve();
            });

            this.httpServer.on('error', reject);
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve) => {
            let resolved = false;

            const cleanup = () => {
                if (!resolved) {
                    resolved = true;
                    console.log('MCP Server stopped');
                    resolve();
                }
            };

            // Set a timeout to force exit if graceful shutdown fails
            const forceExitTimer = setTimeout(() => {
                console.log('Force stopping MCP Server...');
                cleanup();
            }, 2000);

            try {
                // Close MCP server connections
                if (this.mcpServer) {
                    this.mcpServer.close();
                }

                // Close all transports
                this.transports.forEach((transport, sessionId) => {
                    try {
                        transport.close();
                    } catch (error) {
                        console.warn(`Failed to close transport ${sessionId}:`, error);
                    }
                });
                this.transports.clear();

                // Close HTTP server
                this.httpServer.close((error) => {
                    clearTimeout(forceExitTimer);
                    if (error) {
                        console.warn('HTTP server close error:', error);
                    }
                    cleanup();
                });

                // Force close all connections
                this.httpServer.closeAllConnections?.();

            } catch (error) {
                clearTimeout(forceExitTimer);
                console.warn('Error during shutdown:', error);
                cleanup();
            }
        });
    }
}
