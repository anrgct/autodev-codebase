/**
 * StdioToStreamableHTTPAdapter - Bridges stdio MCP clients to HTTP/StreamableHTTP MCP servers
 *
 * This adapter allows stdio-based MCP clients (like Claude Desktop) to connect
 * transparently to existing HTTP/StreamableHTTP MCP servers without modifying server code.
 *
 * Architecture:
 * stdio MCP Client (Claude Desktop)
 *     ↓ stdin/stdout (JSON-RPC)
 * StdioToStreamableHTTPAdapter (this class)
 *     ↓ HTTP/StreamableHTTP
 * Existing CodebaseHTTPMCPServer (unchanged)
 */

import http from 'http';
import { URL } from 'url';

export interface StdioAdapterOptions {
  serverUrl: string; // Full server URL including path (e.g., http://localhost:3001/mcp)
  timeout?: number;
}

export class StdioToStreamableHTTPAdapter {
  private serverUrl: string;
  private timeout: number;
  private requests: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>;
  private sseConnection: http.IncomingMessage | null = null;
  private connected: boolean = false;
  private running: boolean = false;
  private sessionId: string | null = null;

  constructor(options: StdioAdapterOptions) {
    this.serverUrl = options.serverUrl;
    this.timeout = options.timeout || 30000;
    this.requests = new Map();
  }

  /**
   * Start the stdio adapter
   */
  async start(): Promise<void> {
    this.running = true;

    // Setup stdio handlers first - let client initialize the connection
    this.setupStdioHandlers();

    console.error('🔌 Stdio adapter started and ready for connections');
  }

  /**
   * Stop the adapter and cleanup connections
   */
  stop(): void {
    this.running = false;

    if (this.sseConnection) {
      this.sseConnection.destroy();
      this.sseConnection = null;
    }

    // Reject any pending requests
    for (const [id, { reject }] of this.requests.entries()) {
      reject(new Error('Adapter stopped'));
    }
    this.requests.clear();

    this.connected = false;
  }

  /**
   * Connect to the SSE endpoint of the HTTP server
   * Based on SimpleMCPStreamableClient.connectSSE()
   */
  private async connectSSE(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.serverUrl);

      if (!this.sessionId) {
        reject(new Error('Session ID is required for SSE connection'));
        return;
      }

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
        this.connected = true;
        this.sseConnection = res;
        resolve();

        res.setEncoding('utf8');
        let buffer = '';

        res.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6); // Remove 'data: ' prefix
              if (data.trim()) {
                this.handleServerMessage(data);
              }
            }
          }
        });

        res.on('end', () => {
          this.connected = false;
          if (this.running) {
            console.error('❌ SSE connection ended unexpectedly');
            process.exit(1);
          }
        });

        res.on('error', (error) => {
          this.connected = false;
          console.error('❌ SSE error:', error);
          if (this.running) {
            process.exit(1);
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.end();
    });
  }

  /**
   * Handle incoming messages from the SSE server
   * Based on SimpleMCPStreamableClient.handleServerMessage()
   */
  private handleServerMessage(data: string): void {
    try {
      // Skip non-JSON data (like session IDs, connection info, etc.)
      if (!data.trim().startsWith('{')) {
        // This is likely connection metadata, just log it for debugging
        console.error(`🔗 SSE connection info: ${data}`);
        return;
      }

      const message = JSON.parse(data);

      // If this is a response to a request (has ID), resolve the pending promise
      if (message.id && this.requests.has(message.id)) {
        const { resolve } = this.requests.get(message.id)!;
        this.requests.delete(message.id);
        resolve(message);
      } else {
        // This is a notification or unexpected message, just forward to stdout
        this.writeStdoutResponse(message);
      }
    } catch (error) {
      console.error('❌ Failed to parse SSE message:', data, error);
    }
  }

  /**
   * Setup stdin/stdout handlers for MCP protocol
   */
  private setupStdioHandlers(): void {
    process.stdin.setEncoding('utf8');

    let inputBuffer = '';

    process.stdin.on('data', (chunk) => {
      inputBuffer += chunk;

      // Process complete lines
      const lines = inputBuffer.split('\n');
      inputBuffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          this.handleStdinMessage(line.trim());
        }
      }
    });

    process.stdin.on('end', () => {
      this.stop();
    });

    // Handle process termination
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  /**
   * Handle incoming JSON-RPC messages from stdin
   */
  private async handleStdinMessage(message: string): Promise<void> {
    try {
      const request = JSON.parse(message);

      // Forward the request to the HTTP server and await response via SSE
      const response = await this.forwardRequestToServer(request);

      // Send response back via stdout
      this.writeStdoutResponse(response);

    } catch (error) {
      console.error('❌ Failed to handle stdin message:', message, error);

      // Send error response if possible
      try {
        const request = JSON.parse(message);
        if (request.id) {
          this.writeStdoutResponse({
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32603,
              message: 'Internal error',
              data: error instanceof Error ? error.message : String(error)
            }
          });
        }
      } catch {
        // Couldn't parse request, can't send proper error response
      }
    }
  }

  /**
   * Forward a JSON-RPC request to the HTTP server and return the response
   * Based on SimpleMCPStreamableClient.sendRequest()
   */
  private async forwardRequestToServer(request: any): Promise<any> {
    try {
      // Special handling for initialize request
      if (request.method === 'initialize' && !this.sessionId) {
        console.error('🔧 Handling initialize request from client...');
        const response = await this.httpRequest('', 'POST', request);

        // Extract session ID from response headers
        if (response.headers && response.headers['mcp-session-id']) {
          this.sessionId = response.headers['mcp-session-id'];
          console.error(`🔑 Session ID obtained: ${this.sessionId}`);

          // Start SSE connection with the session ID
          await this.connectSSE();
        }

        // Handle response format
        if (response.data && typeof response.data === 'string' && response.data.includes('data: ')) {
          const lines = response.data.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              try {
                const jsonResponse = JSON.parse(data);
                if (jsonResponse.id === request.id) {
                  console.error('📨 Initialize response:', JSON.stringify(jsonResponse, null, 2));
                  return jsonResponse;
                }
              } catch (e) {
                console.error('Failed to parse SSE data:', data);
              }
            }
          }
        } else if (response.id === request.id) {
          console.error('📨 Initialize response:', JSON.stringify(response, null, 2));
          return response;
        }

        throw new Error('No valid initialize response received');
      }

      // For non-initialize requests, ensure we have a session
      if (!this.sessionId) {
        throw new Error('No session ID available. Initialize must be called first.');
      }

      // Send HTTP POST request to /mcp endpoint
      const response = await this.httpRequest('', 'POST', request);

      // Handle different response formats
      if (response.data && typeof response.data === 'string' && response.data.includes('data: ')) {
        // SSE format response - parse it
        const lines = response.data.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            try {
              const jsonResponse = JSON.parse(data);
              if (jsonResponse.id === request.id) {
                console.error('📨 Parsed SSE response:', JSON.stringify(jsonResponse, null, 2));
                return jsonResponse;
              }
            } catch (e) {
              console.error('Failed to parse SSE data:', data);
            }
          }
        }
        throw new Error('No valid response found in SSE data');
      } else if (response.id === request.id) {
        // Direct JSON response
        console.error('📨 Direct response:', JSON.stringify(response, null, 2));
        return response;
      } else {
        // Response came via SSE - wait for it
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (this.requests.has(request.id)) {
              this.requests.delete(request.id);
              reject(new Error(`Request ${request.id} timed out`));
            }
          }, this.timeout);

          this.requests.set(request.id, {
            resolve: (response) => {
              clearTimeout(timeout);
              resolve(response);
            },
            reject: (error) => {
              clearTimeout(timeout);
              reject(error);
            }
          });
        });
      }
    } catch (error) {
      console.error('❌ Request error:', error);
      throw error;
    }
  }

  /**
   * Make HTTP request to the server
   * Based on SimpleMCPStreamableClient.httpRequest()
   */
  private async httpRequest(path: string, method: string = 'GET', data: any = null): Promise<any> {
    return new Promise((resolve, reject) => {
      // Use serverUrl directly for /mcp endpoint
      const serverUrl = new URL(this.serverUrl);
      const postData = data ? JSON.stringify(data) : null;

      const headers: any = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(postData && { 'Content-Length': Buffer.byteLength(postData) })
      };

      // Add session ID header if available
      if (this.sessionId) {
        headers['MCP-Session-ID'] = this.sessionId;
      }

      const options = {
        hostname: serverUrl.hostname,
        port: serverUrl.port,
        path: serverUrl.pathname,
        method: method,
        headers
      };

      const req = http.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData);
            // Include response headers for session ID extraction
            parsed.headers = res.headers;
            resolve(parsed);
          } catch (error) {
            // Return response data with headers for SSE format handling
            resolve({
              data: responseData,
              headers: res.headers
            });
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

  /**
   * Write a JSON-RPC response to stdout
   */
  private writeStdoutResponse(response: any): void {
    try {
      const message = JSON.stringify(response);
      process.stdout.write(message + '\n');
    } catch (error) {
      console.error('❌ Failed to write stdout response:', error);
    }
  }
}
