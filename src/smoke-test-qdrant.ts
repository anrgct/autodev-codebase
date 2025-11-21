/**
 * Smoke test for Qdrant connection with API token
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

async function smokeTestQdrantConnection(
  qdrantUrl: string,
  qdrantApiKey?: string
): Promise<boolean> {
  console.log(`🧪 Starting Qdrant smoke test...`);
  console.log(`🔗 URL: ${qdrantUrl}`);
  console.log(`🔑 API Key: ${qdrantApiKey ? 'Provided' : 'Not provided'}`);

  try {
    // Create Qdrant client with the provided URL and API key
    const clientOptions: any = {
      url: qdrantUrl,
      timeout: 5000,
    };

    // Add User-Agent header first
    clientOptions.headers = {
      "User-Agent": "Roo-Code Smoke Test",
    };

    // For HTTP connections with API keys, ensure the Authorization header is properly set
    if (qdrantApiKey) {
      // Add the Authorization header directly to ensure it's included in requests
      clientOptions.headers["Authorization"] = `Bearer ${qdrantApiKey}`;

      // Also include the apiKey in options for compatibility
      clientOptions.apiKey = qdrantApiKey;
    }

    const client = new QdrantClient(clientOptions);

    console.log(`🔍 Testing connection to Qdrant server...`);

    // Test the connection by getting collections list (this should work and shows connectivity)
    const collections = await client.getCollections();
    console.log(`✅ Collections retrieved:`, collections.collections.length);
    console.log(`📋 Collections:`, collections.collections.map(c => c.name));

    // Try to create a temporary collection for testing, then delete it
    const testCollectionName = `smoke-test-${Date.now()}`;

    console.log(`🏗️  Creating test collection: ${testCollectionName}`);
    await client.createCollection(testCollectionName, {
      vectors: {
        size: 4,  // Small vector size for test
        distance: "Cosine",
      },
    });

    console.log(`✅ Test collection created successfully`);

    // Clean up: delete the test collection
    console.log(`🧹 Cleaning up test collection: ${testCollectionName}`);
    await client.deleteCollection(testCollectionName);

    console.log(`✅ Test collection deleted successfully`);

    console.log(`🎉 Qdrant smoke test passed! Connection is working properly.`);
    return true;

  } catch (error) {
    console.error(`❌ Qdrant smoke test failed:`, error);
    return false;
  }
}

// CLI interface for the smoke test
async function runSmokeTest() {
  const args = process.argv.slice(2);

  // Parse CLI arguments
  let qdrantUrl = 'http://localhost:6333';
  let qdrantApiKey: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--qdrant-url' && args[i + 1]) {
      qdrantUrl = args[i + 1];
      i++;
    } else if (args[i] === '--qdrant-api-key' && args[i + 1]) {
      qdrantApiKey = args[i + 1];
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: npx tsx smoke-test-qdrant.ts [options]

Options:
  --qdrant-url <url>      Qdrant server URL (default: http://localhost:6333)
  --qdrant-api-key <key>  Qdrant API key
  --help, -h              Show this help

Examples:
  npx tsx smoke-test-qdrant.ts
  npx tsx smoke-test-qdrant.ts --qdrant-url http://localhost:6333 --qdrant-api-key mytoken
      `);
      process.exit(0);
    }
  }

  console.log(`🚀 Running Qdrant smoke test...`);
  const success = await smokeTestQdrantConnection(qdrantUrl, qdrantApiKey);

  if (success) {
    console.log(`\n✅ Smoke test completed successfully!`);
    process.exit(0);
  } else {
    console.log(`\n❌ Smoke test failed!`);
    process.exit(1);
  }
}

// Run the smoke test if this file is executed directly
const currentFilePath = fileURLToPath(import.meta.url);
// Check if the script is being called directly
if (process.argv[1] === currentFilePath) {
  runSmokeTest().catch(error => {
    console.error('Fatal error during smoke test:', error);
    process.exit(1);
  });
}

export { smokeTestQdrantConnection };