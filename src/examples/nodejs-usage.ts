/**
 * Example of how to use the codebase library in Node.js environment
 * This shows how to integrate the library into a Node.js application
 */
import path from 'path'
import {
  createNodeDependencies,
  createSimpleNodeDependencies,
  NodeFileSystem,
  NodeStorage,
  NodeEventBus,
  NodeLogger,
  NodeFileWatcher,
  NodeWorkspace,
  NodePathUtils,
  NodeConfigProvider
} from '../adapters/nodejs'
import { EmbedderProvider } from '../code-index/interfaces/manager'

/**
 * Basic usage example with factory function
 */
export async function basicUsageExample() {
  console.log('Basic usage example')
  // Simple setup for basic usage
  const workspacePath = process.cwd()
  const dependencies = createSimpleNodeDependencies(workspacePath)

  console.log('Workspace path:', dependencies.workspace.getRootPath())
  console.log('Workspace name:', dependencies.workspace.getName())

  // Example: List files in workspace
  const files = await dependencies.workspace.findFiles('*.ts')
  console.log('TypeScript files found:', files.length)

  // Example: Configuration
  await dependencies.configProvider.saveConfig({
    isEnabled: true,
    isConfigured: true,
    embedderProvider: "openai",
    modelId: 'text-embedding-3-small',
    modelDimension: 1536,
    openAiOptions: { openAiNativeApiKey: process.env['OPENAI_API_KEY'] || 'your-api-key-here' },
    qdrantUrl: 'http://localhost:6333'
  })

  const config = await dependencies.configProvider.loadConfig()
  console.log('Configuration loaded:', config.isEnabled)
}

/**
 * Advanced usage example with custom configuration
 */
export async function advancedUsageExample() {
  const workspacePath = '/path/to/your/project'

  // Create dependencies with custom options
  const dependencies = createNodeDependencies({
    workspacePath,
    storageOptions: {
      globalStoragePath: path.join(process.env['HOME'] || '/tmp', '.autodev-custom'),
      cacheBasePath: path.join(process.env['HOME'] || '/tmp', '.autodev-cache')
    },
    loggerOptions: {
      name: 'MyApp-Codebase',
      level: 'debug',
      timestamps: true,
      colors: true
    },
    configOptions: {
      configPath: path.join(workspacePath, '.autodev-config.json'),
      defaultConfig: {
        isEnabled: true,
        embedderProvider: "ollama",
        modelId: 'nomic-embed-text',
        modelDimension: 768,
        ollamaOptions: { ollamaBaseUrl: 'http://localhost:11434' }
      }
    }
  })

  // Initialize configuration
  await dependencies.configProvider.loadConfig()
  const validation = await dependencies.configProvider.validateConfig()

  if (!validation.isValid) {
    dependencies.logger?.warn('Configuration validation failed:', validation.errors)
  }

  // Example: File system operations
  const testFilePath = path.join(workspacePath, 'test.txt')
  const content = new TextEncoder().encode('Hello from Node.js!')

  await dependencies.fileSystem.writeFile(testFilePath, content)
  const exists = await dependencies.fileSystem.exists(testFilePath)
  dependencies.logger?.info('Test file exists:', exists)

  if (exists) {
    const readContent = await dependencies.fileSystem.readFile(testFilePath)
    const text = new TextDecoder().decode(readContent)
    dependencies.logger?.info('File content:', text)

    // Clean up
    await dependencies.fileSystem.delete(testFilePath)
  }

  // Example: Event system
  const unsubscribe = dependencies.eventBus.on('test-event', (data) => {
    dependencies.logger?.info('Received test event:', data)
  })

  dependencies.eventBus.emit('test-event', { message: 'Hello Events!' })

  // Example: File watching
  if (dependencies.fileWatcher) {
    const stopWatching = dependencies.fileWatcher.watchDirectory(workspacePath, (event) => {
      dependencies.logger?.debug('File system event:', event)
    })

    // Stop watching after 10 seconds (for demo purposes)
    setTimeout(() => {
      stopWatching()
      dependencies.logger?.info('Stopped watching files')
    }, 10000)
  }

  // Clean up
  unsubscribe()
}

/**
 * Integration with existing CodeIndexManager example
 */
export async function codeIndexManagerExample() {
  const workspacePath = process.cwd()
  const dependencies = createNodeDependencies({
    workspacePath,
    loggerOptions: {
      name: 'CodeIndex',
      level: 'info'
    }
  })

  // This would be how you'd integrate with the actual CodeIndexManager
  // const codeIndexManager = new CodeIndexManager({
  //   fileSystem: dependencies.fileSystem,
  //   storage: dependencies.storage,
  //   eventBus: dependencies.eventBus,
  //   logger: dependencies.logger,
  //   workspace: dependencies.workspace,
  //   configProvider: dependencies.configProvider,
  //   pathUtils: dependencies.pathUtils
  // })

  // Listen for configuration changes
  const configUnsubscribe = dependencies.configProvider.onConfigChange(async (config) => {
    dependencies.logger?.info('Configuration changed, restarting code index...')
    // await codeIndexManager.restart()
  })

  // Example: Initialize and start indexing
  // await codeIndexManager.initialize()
  // await codeIndexManager.buildIndex()

  dependencies.logger?.info('Code index manager initialized')

  // Clean up
  return () => {
    configUnsubscribe()
    // codeIndexManager.dispose()
  }
}

/**
 * Testing utilities for Node.js environment
 */
export function createTestDependencies(tempDir: string = '/tmp/autodev-test') {
  return createNodeDependencies({
    workspacePath: tempDir,
    storageOptions: {
      globalStoragePath: path.join(tempDir, '.storage'),
      cacheBasePath: path.join(tempDir, '.cache')
    },
    loggerOptions: {
      name: 'Test',
      level: 'debug'
    },
    configOptions: {
      configPath: path.join(tempDir, 'test-config.json')
    }
  })
}

/**
 * CLI usage example
 */
export async function cliExample() {
  const args = process.argv.slice(2)
  const command = args[0]
  const workspacePath = args[1] || process.cwd()

  const dependencies = createSimpleNodeDependencies(workspacePath)

  switch (command) {
    case 'init':
      await dependencies.configProvider.saveConfig({
        isEnabled: true,
        isConfigured: false,
        embedderProvider: "ollama",
        modelId: 'nomic-embed-text',
        modelDimension: 768,
        ollamaOptions: { ollamaBaseUrl: 'http://localhost:11434' }
      })
      console.log('Configuration initialized')
      break

    case 'status':
      const config = await dependencies.configProvider.loadConfig()
      console.log('Code Index Status:')
      console.log('  Enabled:', config.isEnabled)
      console.log('  Configured:', config.isConfigured)
      console.log('  Provider:', config.embedderProvider)
      break

    case 'files':
      const pattern = args[2] || '**/*'
      const files = await dependencies.workspace.findFiles(pattern)
      console.log(`Found ${files.length} files matching "${pattern}":`)
      files.slice(0, 10).forEach(file => console.log(' ', file))
      if (files.length > 10) {
        console.log(`  ... and ${files.length - 10} more`)
      }
      break

    default:
      console.log('Usage: node script.js <command> [workspace-path]')
      console.log('Commands:')
      console.log('  init     - Initialize configuration')
      console.log('  status   - Show current status')
      console.log('  files    - List files in workspace')
  }
}

// Run CLI if this file is executed directly
// if (require.main === module) {
  cliExample().catch(console.error)
// }
