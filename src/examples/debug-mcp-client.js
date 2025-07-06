#!/usr/bin/env node

/**
 * Debug client for testing stdio adapter functionality
 * This script tests the stdio-to-StreamableHTTP adapter bridge
 * 
 * Flow: Client -> stdio -> StdioAdapter -> HTTP/StreamableHTTP -> MCP Server
 * 
 * Usage:
 * 
 * # Start HTTP/StreamableHTTP server first (Terminal 1)
 * codebase mcp-server --port=3002
 * 
 * # Test stdio adapter (Terminal 2)
 * node src/examples/debug-mcp-client.js
 * node src/examples/debug-mcp-client.js --server-url=http://localhost:3002/mcp
 * node src/examples/debug-mcp-client.js --timeout=30000
 * 
 * Arguments:
 * --server-url=<url>     HTTP server URL (default: http://localhost:3002/mcp)
 * --timeout=<ms>         Request timeout in milliseconds (default: 30000)
 * --help, -h             Show help message
 */

import { spawn } from 'child_process';
import { EventEmitter } from 'events';

class StdioAdapterTestClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.requests = new Map();
        this.requestId = 0;
        this.serverUrl = options.serverUrl || 'http://localhost:3002/mcp';
        this.timeout = options.timeout || 30000;
    }

    async startAdapter() {
        console.log('🔌 Starting Stdio Adapter...');
        console.log(`🌐 Server URL: ${this.serverUrl}`);
        console.log(`⏱️ Timeout: ${this.timeout}ms`);
        console.log('📝 Note: Make sure HTTP/StreamableHTTP server is running separately');
        
        // Start stdio adapter
        this.adapterProcess = spawn('npx', [
            'tsx',
            'src/index.ts',
            'stdio-adapter',
            `--server-url=${this.serverUrl}`,
            `--timeout=${this.timeout}`
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        this.adapterProcess.stderr.on('data', (data) => {
            console.log('🔍 Adapter Log:', data.toString());
        });

        this.adapterProcess.stdout.on('data', (data) => {
            this.handleAdapterMessage(data.toString());
        });

        this.adapterProcess.on('error', (error) => {
            console.error('❌ Adapter Error:', error);
        });

        this.adapterProcess.on('exit', (code) => {
            console.log(`🔄 Adapter exited with code ${code}`);
        });

        // Wait a bit for the adapter to start
        console.log('⏳ Waiting 2000ms for adapter to initialize...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        return this;
    }

    handleAdapterMessage(data) {
        const lines = data.trim().split('\n');

        for (const line of lines) {
            try {
                // Skip non-JSON lines (logs)
                if (!line.startsWith('{')) {
                    console.log('📊 Adapter Output:', line);
                    continue;
                }

                const message = JSON.parse(line);
                console.log('📨 Received:', JSON.stringify(message, null, 2));

                if (message.id && this.requests.has(message.id)) {
                    const { resolve } = this.requests.get(message.id);
                    this.requests.delete(message.id);
                    resolve(message);
                }
            } catch (error) {
                console.log('📊 Adapter Output:', line);
            }
        }
    }

    async sendRequest(method, params = {}) {
        const id = ++this.requestId;
        const request = {
            jsonrpc: '2.0',
            id,
            method,
            params
        };

        console.log('📤 Sending:', JSON.stringify(request, null, 2));

        return new Promise((resolve, reject) => {
            this.requests.set(id, { resolve, reject });

            // Set timeout
            setTimeout(() => {
                if (this.requests.has(id)) {
                    this.requests.delete(id);
                    reject(new Error(`Request ${id} timed out`));
                }
            }, this.timeout);

            this.adapterProcess.stdin.write(JSON.stringify(request) + '\n');
        });
    }

    async testInitialize() {
        console.log('\n🔧 Testing initialize...');
        try {
            const response = await this.sendRequest('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {
                    roots: {
                        listChanged: true
                    },
                    sampling: {}
                },
                clientInfo: {
                    name: 'stdio-adapter-test-client',
                    version: '1.0.0'
                }
            });
            console.log('✅ Initialize response:', response);
            return response;
        } catch (error) {
            console.error('❌ Initialize error:', error);
            throw error;
        }
    }

    async testListTools() {
        console.log('\n🛠️ Testing tools/list...');
        try {
            const response = await this.sendRequest('tools/list');
            console.log('✅ Tools list:', response);
            return response;
        } catch (error) {
            console.error('❌ List tools error:', error);
            throw error;
        }
    }

    async testSearchCodebase() {
        console.log('\n🔍 Testing search_codebase tool...');
        try {
            const response = await this.sendRequest('tools/call', {
                name: 'search_codebase',
                arguments: {
                    query: 'CodeIndexManager',
                    limit: 3
                }
            });
            console.log('✅ Search result:', response);
            return response;
        } catch (error) {
            console.error('❌ Search error:', error);
            throw error;
        }
    }

    async testGetStats() {
        console.log('\n📊 Testing get_search_stats tool...');
        try {
            const response = await this.sendRequest('tools/call', {
                name: 'get_search_stats',
                arguments: {}
            });
            console.log('✅ Stats result:', response);
            return response;
        } catch (error) {
            console.error('❌ Stats error:', error);
            throw error;
        }
    }

    async runFullTest() {
        try {
            await this.testInitialize();
            await this.testListTools();
            await this.testGetStats();
            await this.testSearchCodebase();

            console.log('\n✅ All tests completed successfully!');
        } catch (error) {
            console.error('\n❌ Test failed:', error);
        }
    }

    stop() {
        if (this.adapterProcess) {
            console.log('🔄 Stopping adapter...');
            this.adapterProcess.kill('SIGTERM');
        }
    }
}

// Main execution
async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    
    // Show help if requested
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
🧪 Stdio Adapter Test Client

This client tests the stdio-to-StreamableHTTP adapter functionality.

Flow: Client -> stdio -> StdioAdapter -> HTTP/StreamableHTTP -> MCP Server

Usage:
  node src/examples/debug-mcp-client.js [options]

Options:
  --server-url=<url>       Full StreamableHTTP endpoint URL (default: http://localhost:3002/mcp)
  --timeout=<ms>           Request timeout in milliseconds (default: 30000)
  --help, -h               Show this help message

Setup:
  1. Start HTTP/StreamableHTTP server:
     codebase mcp-server --port=3002
  
  2. Test stdio adapter:
     node src/examples/debug-mcp-client.js
     node src/examples/debug-mcp-client.js --server-url=http://localhost:3002/mcp
     node src/examples/debug-mcp-client.js --timeout=30000
`);
        process.exit(0);
    }
    
    console.log('🧪 Stdio Adapter Test Client Starting...');
    
    const serverUrlArg = args.find(arg => arg.startsWith('--server-url='));
    const serverUrl = serverUrlArg ? serverUrlArg.split('=')[1] : 'http://localhost:3002/mcp';
    const timeoutArg = args.find(arg => arg.startsWith('--timeout='));
    const timeout = timeoutArg ? parseInt(timeoutArg.split('=')[1], 10) : 30000;
    
    console.log(`📋 Configuration:`);
    console.log(`   Server URL: ${serverUrl}`);
    console.log(`   Timeout: ${timeout}ms`);

    const client = new StdioAdapterTestClient({ serverUrl, timeout });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n🔄 Shutting down...');
        client.stop();
        process.exit(0);
    });

    try {
        await client.startAdapter();
        await client.runFullTest();
    } catch (error) {
        console.error('❌ Test session failed:', error);
    } finally {
        client.stop();
        process.exit(0);
    }
}

main().catch(console.error);
