#!/usr/bin/env node

/**
 * StreamableHTTP client for testing MCP server functionality
 * Adapted from SSE client to work with the new /mcp endpoint
 */

import { spawn } from 'child_process';
import http from 'http';
import { URL } from 'url';

class SimpleMCPStreamableClient {
    constructor(options = {}) {
        this.baseUrl = options.baseUrl || 'http://localhost:3001';
        this.requests = new Map();
        this.requestId = 0;
        this.serverProcess = null;
        this.sseConnection = null;
        this.connected = false;
        this.sessionId = null;
    }

    async startServer() {
        console.log('🚀 Starting MCP HTTP Server process...');

        this.serverProcess = spawn('npx', [
            'tsx',
            'src/cli.ts',
            '--serve',
            '--demo',
            '--host=localhost'
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
            cwd: process.cwd()
        });

        this.serverProcess.stderr.on('data', (data) => {
            console.log('🔍 Server Log:', data.toString());
        });

        this.serverProcess.stdout.on('data', (data) => {
            console.log('📊 Server Output:', data.toString());
        });

        this.serverProcess.on('error', (error) => {
            console.error('❌ Server Error:', error);
        });

        this.serverProcess.on('exit', (code) => {
            console.log(`🔄 Server exited with code ${code}`);
        });

        await this.waitForServer();
        return this;
    }

    async waitForServer(maxAttempts = 30) {
        for (let i = 0; i < maxAttempts; i++) {
            try {
                const health = await this.httpRequest('/health', 'GET');
                console.log('✅ Server is ready:', health);
                return;
            } catch (error) {
                // Server not ready yet
            }

            console.log(`⏳ Attempt ${i + 1}/${maxAttempts} - waiting for server...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        throw new Error('Server failed to start within timeout');
    }

    async initialize() {
        console.log('🔧 Initializing MCP connection...');

        const initRequest = {
            jsonrpc: '2.0',
            id: ++this.requestId,
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {
                    roots: { listChanged: true },
                    sampling: {}
                },
                clientInfo: {
                    name: 'simple-streamable-debug-client',
                    version: '1.0.0'
                }
            }
        };

        console.log('📤 Sending initialization request:', JSON.stringify(initRequest, null, 2));

        return new Promise(async (resolve, reject) => {
            try {
                const response = await this.httpRequest('/mcp', 'POST', initRequest);
                console.log('✅ Initialize response:', JSON.stringify(response, null, 2));

                // For StreamableHTTP, the response might be a string containing SSE data
                if (typeof response === 'string' && response.includes('data: ')) {
                    // Parse SSE format response
                    const lines = response.split('\n');
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6);
                            try {
                                const jsonResponse = JSON.parse(data);
                                if (jsonResponse.id === initRequest.id) {
                                    resolve(jsonResponse);
                                    return;
                                }
                            } catch (e) {
                                console.log('Failed to parse SSE data:', data);
                            }
                        }
                    }
                } else if (response && response.result) {
                    // Direct JSON response
                    resolve(response);
                } else {
                    reject(new Error('Invalid initialize response format'));
                }
            } catch (error) {
                console.error('❌ Initialize error:', error);
                reject(error);
            }
        });
    }

    async connectSSE() {
        if (!this.sessionId) {
            throw new Error('Session ID required for SSE connection');
        }

        console.log('🔌 Connecting to StreamableHTTP SSE endpoint...');

        return new Promise((resolve, reject) => {
            const url = new URL('/mcp', this.baseUrl);

            const req = http.request({
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'GET',
                headers: {
                    'Accept': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'MCP-Session-ID': this.sessionId
                }
            }, (res) => {
                console.log(`✅ SSE connection established (${res.statusCode})`);
                this.connected = true;
                this.sseConnection = res;
                resolve();

                res.setEncoding('utf8');
                let buffer = '';

                res.on('data', (chunk) => {
                    buffer += chunk;
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // Keep incomplete line in buffer

                    let currentEvent = {};
                    for (const line of lines) {
                        if (line.startsWith('event: ')) {
                            currentEvent.event = line.slice(7);
                        } else if (line.startsWith('id: ')) {
                            currentEvent.id = line.slice(4);
                        } else if (line.startsWith('data: ')) {
                            const data = line.slice(6); // Remove 'data: ' prefix
                            if (data.trim()) {
                                this.handleServerMessage(data);
                            }
                        } else if (line === '' && currentEvent.data) {
                            // End of event, reset
                            currentEvent = {};
                        }
                    }
                });

                res.on('end', () => {
                    console.log('🔌 SSE connection ended');
                    this.connected = false;
                });

                res.on('error', (error) => {
                    console.error('❌ SSE error:', error);
                    this.connected = false;
                });
            });

            req.on('error', (error) => {
                console.error('❌ SSE request error:', error);
                reject(error);
            });

            req.end();
        });
    }

    handleServerMessage(data) {
        try {
            const message = JSON.parse(data);
            console.log('📨 SSE Received:', JSON.stringify(message, null, 2));

            if (message.id && this.requests.has(message.id)) {
                const { resolve } = this.requests.get(message.id);
                this.requests.delete(message.id);
                resolve(message);
            }
        } catch (error) {
            console.log('📊 SSE Raw Data:', data);
            console.log('📊 Parse Error:', error.message);
        }
    }

    async httpRequest(path, method = 'GET', data = null) {
        return new Promise((resolve, reject) => {
            const url = new URL(path, this.baseUrl);
            const postData = data ? JSON.stringify(data) : null;

            const headers = {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                ...(postData && { 'Content-Length': Buffer.byteLength(postData) }),
                ...(this.sessionId && { 'MCP-Session-ID': this.sessionId })
            };

            const options = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: method,
                headers: headers
            };

            const req = http.request(options, (res) => {
                let responseData = '';

                // Extract session ID from response headers if not already set
                if (!this.sessionId && res.headers['mcp-session-id']) {
                    this.sessionId = res.headers['mcp-session-id'];
                    console.log(`🔑 Session ID from header: ${this.sessionId}`);
                }

                res.on('data', (chunk) => {
                    responseData += chunk;
                });

                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseData);
                        resolve(parsed);
                    } catch (error) {
                        resolve(responseData);
                    }
                });
            });

            req.on('error', (error) => {
                reject(error);
            });

            if (postData) {
                req.write(postData);
            }

            req.end();
        });
    }

    async sendRequest(method, params = {}) {
        const id = ++this.requestId;
        const request = {
            jsonrpc: '2.0',
            id,
            method,
            params
        };

        console.log('📤 Sending HTTP POST:', JSON.stringify(request, null, 2));

        try {
            const response = await this.httpRequest('/mcp', 'POST', request);

            // Parse SSE format response if it comes as text
            if (typeof response === 'string' && response.includes('data: ')) {
                const lines = response.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        try {
                            const jsonResponse = JSON.parse(data);
                            if (jsonResponse.id === id) {
                                console.log('📨 Parsed response:', JSON.stringify(jsonResponse, null, 2));
                                return jsonResponse;
                            }
                        } catch (e) {
                            console.log('Failed to parse SSE data:', data);
                        }
                    }
                }
            } else if (response && response.id === id) {
                // Direct JSON response
                console.log('📨 Direct response:', JSON.stringify(response, null, 2));
                return response;
            }

            throw new Error('No valid response received');
        } catch (error) {
            console.error('❌ Request error:', error);
            throw error;
        }
    }

    async testHealthCheck() {
        console.log('\n❤️ Testing health check...');
        try {
            const health = await this.httpRequest('/health', 'GET');
            console.log('✅ Health check response:', health);
            return health;
        } catch (error) {
            console.error('❌ Health check error:', error);
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
                    query: 'function',
                    limit: 3,
                    // filters: {
                    //     pathFilters: ['.ts']
                    // }
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
        const results = { passed: 0, failed: 0, tests: [] };
        const tests = [
            { name: 'Health Check', fn: () => this.testHealthCheck() },
            { name: 'List Tools', fn: () => this.testListTools() },
            { name: 'Search Codebase', fn: () => this.testSearchCodebase() },
            { name: 'Get Stats', fn: () => this.testGetStats() }
        ];

        for (const test of tests) {
            try {
                console.log(`\n🧪 Running test: ${test.name}`);
                await test.fn();
                results.passed++;
                results.tests.push({ name: test.name, status: 'PASSED' });
                console.log(`✅ ${test.name} - PASSED`);
            } catch (error) {
                results.failed++;
                results.tests.push({ name: test.name, status: 'FAILED', error: error.message });
                console.error(`❌ ${test.name} - FAILED:`, error.message);
            }
        }

        console.log('\n📊 Test Results Summary:');
        console.log(`✅ Passed: ${results.passed}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log(`📝 Total: ${results.tests.length}`);

        return results;
    }

    stop() {
        if (this.sseConnection) {
            console.log('🔌 Closing SSE connection...');
            this.sseConnection.destroy();
        }

        if (this.serverProcess) {
            console.log('🔄 Stopping server...');
            this.serverProcess.kill('SIGTERM');
        }
    }
}

async function main() {
    console.log('🧪 Simple MCP StreamableHTTP Debug Client Starting...');

    const client = new SimpleMCPStreamableClient({
        baseUrl: process.env.MCP_BASE_URL || 'http://localhost:3001'
    });

    process.on('SIGINT', () => {
        console.log('\n🔄 Shutting down...');
        client.stop();
        process.exit(0);
    });

    try {
        await client.startServer();
        await client.initialize();
        await client.connectSSE();

        // Run automated tests
        const results = await client.runFullTest();

        if (results.failed === 0) {
            console.log('\n🎉 All tests passed successfully!');
        } else {
            console.log(`\n⚠️ ${results.failed} test(s) failed`);
        }

    } catch (error) {
        console.error('❌ Debug session failed:', error);
    } finally {
        client.stop();
        process.exit(0);
    }
}

main().catch(console.error);
