/**
 * HTTP Message Capture utility to capture actual requests
 * sent to Qdrant and Ollama services
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';

interface CapturedRequest {
    id: string;
    timestamp: Date;
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
    target: 'qdrant' | 'ollama' | 'other';
}

class HttpProxyCapture {
    private capturedRequests: CapturedRequest[] = [];
    private server: any;
    
    constructor(private port: number, private upstreamHost: string, private upstreamPort: number) {}
    
    async start() {
        this.server = createServer(this.handleRequest.bind(this));
        this.server.listen(this.port, () => {
            console.log(`🚀 HTTP Capture Proxy listening on port ${this.port}`);
            console.log(`🔄 Forwarding to: ${this.upstreamHost}:${this.upstreamPort}`);
        });
    }
    
    private async handleRequest(req: IncomingMessage, res: ServerResponse) {
        // Capture the incoming request details
        const timestamp = new Date();
        const chunks: Buffer[] = [];
        
        req.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });
        
        req.on('end', async () => {
            const body = Buffer.concat(chunks).toString();
            
            // Determine target based on URL patterns
            let target: 'qdrant' | 'ollama' | 'other' = 'other';
            if (req.url?.includes('/api/') || req.url?.includes('/embedding')) {
                target = 'ollama';
            } else if (req.url?.includes('/collections') || req.url?.includes('/points')) {
                target = 'qdrant';
            }
            
            // Create the captured request object
            const captured: CapturedRequest = {
                id: Math.random().toString(36).substr(2, 9),
                timestamp,
                method: req.method || 'UNKNOWN',
                url: req.url || '',
                headers: req.headers,
                body,
                target
            };
            
            this.capturedRequests.push(captured);
            
            // Print captured request
            this.printCapturedRequest(captured);
            
            // Forward the request to the upstream server (optional)
            try {
                // In a real proxy, we would forward the request here
                res.writeHead(501, { 'Content-Type': 'text/plain' });
                res.end('Request captured - not forwarded in this example');
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error forwarding request');
            }
        });
    }
    
    private printCapturedRequest(request: CapturedRequest) {
        console.log('\n' + '='.repeat(60));
        console.log(`🔍 CAPTURED ${request.target.toUpperCase()} REQUEST #${request.id}`);
        console.log(`⏰ Timestamp: ${request.timestamp.toISOString()}`);
        console.log(`📡 Method: ${request.method}`);
        console.log(`🔗 URL: ${request.url}`);
        console.log(`🏷️  Headers:`);
        
        for (const [key, value] of Object.entries(request.headers)) {
            // Don't print sensitive headers in full during testing
            const valueStr = Array.isArray(value)
                ? value.join(', ')
                : (value ?? '').toString();

            if (key.toLowerCase().includes('authorization') || key.toLowerCase().includes('key')) {
                console.log(`   ${key}: ${valueStr.substring(0, 20)}...[HIDDEN FOR SECURITY]`);
            } else {
                console.log(`   ${key}: ${valueStr || '<empty>'}`);
            }
        }
        
        if (request.body) {
            console.log(`📄 Body: ${request.body.substring(0, 200)}${request.body.length > 200 ? '...' : ''}`);
        }
        console.log('='.repeat(60) + '\n');
    }
    
    getCapturedRequests() {
        return this.capturedRequests;
    }
    
    stop() {
        this.server.close();
    }
}

// Example usage for demonstration
async function demonstrateCapture() {
    console.log('🎯 Setting up HTTP message capture...');
    console.log('⚠️  This would normally intercept actual HTTP traffic');
    console.log('⚠️  For security reasons, showing example format only\n');
    
    // Example Qdrant request that would be captured
    console.log('📋 EXAMPLE QDRANT REQUEST FORMAT:');
    console.log('POST /collections/test-collection/points HTTP/1.1');
    console.log('Host: localhost:6333');
    console.log('Authorization: Bearer YOUR_API_KEY_HERE');
    console.log('Content-Type: application/json');
    console.log('User-Agent: Roo-Code');
    console.log('');
    console.log('{ "points": [...] }');
    console.log('');
    
    console.log('📋 EXAMPLE OLLAMA REQUEST FORMAT:');
    console.log('POST /api/embed HTTP/1.1');
    console.log('Host: localhost:11434');
    console.log('Authorization: Bearer YOUR_API_KEY_HERE');
    console.log('Content-Type: application/json');
    console.log('');
    console.log('{ "model": "nomic-embed-text", "input": ["sample text"] }');
    console.log('');
    
    // In a real scenario, you would start the proxy like this:
    // const proxy = new HttpProxyCapture(8080, 'localhost', 11434);
    // await proxy.start();
}

if (require.main === module) {
    demonstrateCapture();
}

export { HttpProxyCapture, CapturedRequest };
