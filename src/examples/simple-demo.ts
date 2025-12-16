#!/usr/bin/env node

/**
 * Simple demo script that showcases the codebase library without external dependencies
 * This script demonstrates basic functionality without requiring Ollama or Qdrant
 */

import path from 'path'
import { createNodeDependencies } from '../adapters/nodejs'
import { CodeIndexManager } from '../code-index/manager'
import createSampleFiles from './create-sample-files';

// Configuration
const DEMO_FOLDER = path.join(process.cwd(), 'demo-simple')

async function main() {
  console.log('🚀 Starting Simple Autodev Codebase Demo')
  console.log('📁 Demo folder:', DEMO_FOLDER)
  console.log('=' .repeat(50))

  try {
    // 1. Create Node.js dependencies with minimal config
    const dependencies = createNodeDependencies({
      workspacePath: DEMO_FOLDER,
      storageOptions: {
        globalStoragePath: path.join(process.cwd(), '.autodev-storage'),
      },
      loggerOptions: {
        name: 'Simple-Demo',
        level: 'info',
        timestamps: true,
        colors: true
      },
      configOptions: {
        configPath: path.join(DEMO_FOLDER, '.autodev-config.json'),
        defaultConfig: {
          isEnabled: false, // Disable to avoid requiring external services
          embedderProvider: "openai",
          embedderModelId: 'text-embedding-3-small',
          embedderModelDimension: 1536,
          embedderOpenAiApiKey: ''
        }
      }
    })

    // 2. Check if demo folder exists, create if not
    const demoFolderExists = await dependencies.fileSystem.exists(DEMO_FOLDER)
    if (!demoFolderExists) {
      console.log('📁 Creating demo folder...')
      const fs = require('fs')
      fs.mkdirSync(DEMO_FOLDER, { recursive: true })
      
      // Create some sample files for demonstration
      await createSampleFiles(dependencies.fileSystem, DEMO_FOLDER)
    }

    // 3. Initialize configuration
    console.log('⚙️  Initializing configuration...')
    await dependencies.configProvider.loadConfig()
    
    // 4. Demonstrate basic functionality without indexing
    console.log('📊 Testing basic file system operations...')
    await demonstrateFileSystem(dependencies.fileSystem, DEMO_FOLDER)
    
    console.log('✅ Demo completed successfully!')
    console.log('Note: To enable full indexing, you need to:')
    console.log('1. Start Ollama service: ollama serve')
    console.log('2. Start Qdrant service: docker run -p 6333:6333 qdrant/qdrant')
    console.log('3. Use the full run-demo.ts script')

  } catch (error) {
    console.error('❌ Error in demo:', error)
    process.exit(1)
  }
}


async function demonstrateFileSystem(fileSystem: any, demoFolder: string) {
  console.log('📖 Reading sample files...')
  
  const files = ['hello.js', 'utils.py', 'README.md']
  
  for (const filename of files) {
    const filePath = path.join(demoFolder, filename)
    const exists = await fileSystem.exists(filePath)
    
    if (exists) {
      const content = await fileSystem.readFile(filePath)
      const text = new TextDecoder().decode(content)
      const lines = text.split('\n').length
      
      console.log(`  📄 ${filename}: ${lines} lines, ${content.length} bytes`)
    } else {
      console.log(`  ❌ ${filename}: Not found`)
    }
  }
}

// Run the demo
if (require.main === module) {
  main().catch(console.error)
}

export { main as runSimpleDemo }