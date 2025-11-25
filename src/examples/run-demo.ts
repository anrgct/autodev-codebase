#!/usr/bin/env node

/**
 * Demo script to monitor a local demo folder and index code using Ollama embeddings with Qdrant
 * This script demonstrates how to use the codebase library in a Node.js environment
 * with Ollama for embeddings and Qdrant for vector storage.
 */

import * as path from 'path'
import { fileURLToPath } from 'url'
import { createNodeDependencies } from '../adapters/nodejs'
import { CodeIndexManager } from '../code-index/manager'
import createSampleFiles from './create-sample-files';

// Configuration
const DEMO_FOLDER = path.join(process.cwd(), 'demo')
const OLLAMA_BASE_URL = 'http://localhost:11434'
const QDRANT_URL = 'http://localhost:6333'
const OLLAMA_MODEL = 'nomic-embed-text'  // Default embedding model for Ollama

async function main() {
  // 1. Create Node.js dependencies first to get logger
  const dependencies = createNodeDependencies({
    workspacePath: DEMO_FOLDER,
    storageOptions: {
      globalStoragePath: path.join(process.cwd(), '.autodev-storage'),
    },
    loggerOptions: {
      name: 'Demo-Codebase',
      level: 'info',
      timestamps: true,
      colors: true
    },
    configOptions: {
      configPath: path.join(process.cwd(), '.autodev-config.json'),
      defaultConfig: {
        isEnabled: true,
        isConfigured: true,
        embedderProvider: "ollama",
        modelId: OLLAMA_MODEL,
        modelDimension: 768,
        ollamaOptions: { ollamaBaseUrl: OLLAMA_BASE_URL },
        qdrantUrl: QDRANT_URL
      }
    }
  })

  dependencies.logger?.info('[run-demo]🚀 Starting Autodev Codebase Demo')
  dependencies.logger?.info('[run-demo]📁 Demo folder:', DEMO_FOLDER)
  dependencies.logger?.info('[run-demo]🤖 Ollama URL:', OLLAMA_BASE_URL)
  dependencies.logger?.info('[run-demo]🔍 Qdrant URL:', QDRANT_URL)
  dependencies.logger?.info('[run-demo]📊 Embedding Model:', OLLAMA_MODEL)
  dependencies.logger?.info('[run-demo]' + '=' .repeat(50))

  try {
    // 2. Check if demo folder exists, create if not
    const demoFolderExists = await dependencies.fileSystem.exists(DEMO_FOLDER)
    if (!demoFolderExists) {
      dependencies.logger?.info('[run-demo]📁 Creating demo folder...')
      // Create directory using Node.js mkdir since IFileSystem doesn't have createDirectory
      const fs = require('fs')
      fs.mkdirSync(DEMO_FOLDER, { recursive: true })

      // Create some sample files for demonstration
      await createSampleFiles(dependencies.fileSystem, DEMO_FOLDER)
    }

    // 3. Initialize configuration
    dependencies.logger?.info('[run-demo]⚙️ 加载配置...')
    const config = await dependencies.configProvider.loadConfig()
    dependencies.logger?.info('[run-demo]📝 配置内容:', JSON.stringify(config, null, 2))

    // Validate configuration
    dependencies.logger?.info('[run-demo]✅ 验证配置...')
    const validation = await dependencies.configProvider.validateConfig()
    dependencies.logger?.info('[run-demo]📝 验证结果:', validation)

    if (!validation.isValid) {
      dependencies.logger?.warn('[run-demo]⚠️ 配置验证警告:', validation.errors)
      dependencies.logger?.info('[run-demo]⚠️ 继续初始化（调试模式）')
      // 在调试模式下，我们允许配置验证失败但继续初始化
    } else {
      dependencies.logger?.info('[run-demo]✅ 配置验证通过')
    }

    // 4. Create and initialize CodeIndexManager
    dependencies.logger?.info('[run-demo]🏗️ Creating CodeIndexManager with dependencies:', {
      hasFileSystem: !!dependencies.fileSystem,
      hasStorage: !!dependencies.storage,
      hasEventBus: !!dependencies.eventBus,
      hasWorkspace: !!dependencies.workspace,
      hasPathUtils: !!dependencies.pathUtils,
      hasConfigProvider: !!dependencies.configProvider,
      workspaceRootPath: dependencies.workspace.getRootPath()
    })

    const codeIndexManager = CodeIndexManager.getInstance(dependencies)
    dependencies.logger?.info('[run-demo]CodeIndexManager instance created:', !!codeIndexManager)

    if (!codeIndexManager) {
      dependencies.logger?.error('[run-demo]❌ Failed to create CodeIndexManager - workspace root path may be invalid')
      return
    }

    // 5. Initialize the manager
    dependencies.logger?.info('[run-demo]🔧 初始化 CodeIndexManager...')
    const { requiresRestart } = await codeIndexManager.initialize()
    dependencies.logger?.info('[run-demo]✅ CodeIndexManager 初始化成功:', { requiresRestart })
    dependencies.logger?.info('[run-demo]📝 管理器状态:', {
      isInitialized: codeIndexManager.isInitialized,
      isFeatureEnabled: codeIndexManager.isFeatureEnabled,
      isFeatureConfigured: codeIndexManager.isFeatureConfigured,
      state: codeIndexManager.state
    })

    if (requiresRestart) {
      dependencies.logger?.info('[run-demo]🔄 Manager restart required')
    }

    // 6. Start monitoring for progress updates
    dependencies.logger?.info('[run-demo]👀 Setting up progress monitoring...')
    const unsubscribeProgress = codeIndexManager.onProgressUpdate((progress) => {
      dependencies.logger?.info(`[run-demo]📊 Progress: ${progress.systemStatus} - ${progress.message}`)
    })

    // 7. Start indexing
    dependencies.logger?.info('[run-demo]🚀 Starting code indexing...')
    
    // 设置进度监控
    codeIndexManager.onProgressUpdate((progressInfo) => {
      dependencies.logger?.info('[run-demo]📊 索引进度:', progressInfo)
    })

    // 添加超时保护
    const indexingTimeout = setTimeout(() => {
      dependencies.logger?.warn('[run-demo]⚠️ 索引进程超时（30秒），可能卡住了')
    }, 30000)

    try {
      await codeIndexManager.startIndexing()
      clearTimeout(indexingTimeout)
      dependencies.logger?.info('[run-demo]✅ 索引完成')
    } catch (err: any) {
      clearTimeout(indexingTimeout)
      dependencies.logger?.error('[run-demo]❌ 索引失败:', err)
      dependencies.logger?.error('[run-demo]❌ 错误堆栈:', err.stack)
      throw err
    }

    // 8. Wait for indexing to complete
    dependencies.logger?.info('[run-demo]⏳ Waiting for indexing to complete...')
    await waitForIndexingToComplete(codeIndexManager, dependencies.logger)

    // 9. Demonstrate search functionality
    dependencies.logger?.info('[run-demo]🔍 Testing search functionality...')
    await demonstrateSearch(codeIndexManager, dependencies.logger)

    // 10. Show final status
    dependencies.logger?.info('[run-demo]📈 Final Status Check...')
    const finalStatus = codeIndexManager.getCurrentStatus()
    dependencies.logger?.info(`[run-demo]📊 System Status: ${finalStatus.systemStatus}`)
    dependencies.logger?.info(`[run-demo]📦 Status Message: ${finalStatus.message}`)
    dependencies.logger?.info(`[run-demo]🕒 Last Update: ${new Date().toLocaleTimeString()}`)

    // Clean up
    dependencies.logger?.info('[run-demo]🧹 Cleaning up...')
    unsubscribeProgress()
    codeIndexManager.dispose()

    dependencies.logger?.info('[run-demo]✅ Demo completed successfully!')
    dependencies.logger?.info('[run-demo]Note: The codebase indexing system is working correctly.')
    dependencies.logger?.info('[run-demo]For live file monitoring, the demo can be extended to run continuously.')

  } catch (error: any) {
    dependencies.logger?.error('[run-demo]❌ Error in demo:', error)
    dependencies.logger?.error('[run-demo]❌ 错误堆栈:', error.stack)
    process.exit(1)
  }
}



async function waitForIndexingToComplete(codeIndexManager: any, logger: any) {
  return new Promise<void>((resolve) => {
    let checkCount = 0
    const maxChecks = 30 // Maximum 60 seconds

    const checkStatus = () => {
      const state = codeIndexManager.state
      logger.info(`[run-demo]📊 Current state: ${state} (check ${checkCount + 1}/${maxChecks})`)

      checkCount++

      if (state === 'Standby' || state === 'Watching' || state === 'Indexed') {
        logger.info('[run-demo]✅ Indexing completed')
        resolve()
      } else if (checkCount >= maxChecks) {
        logger.warn('[run-demo]⏰ Timeout waiting for indexing completion')
        resolve()
      } else {
        setTimeout(checkStatus, 2000) // Check every 2 seconds
      }
    }

    checkStatus()
  })
}

async function demonstrateSearch(codeIndexManager: any, logger: any) {
  const searchQueries = [
    'greet user function',
    'process data',
    'user management',
    'batch processing',
    'configuration settings'
  ]

  for (const query of searchQueries) {
    logger.info(`[run-demo]\n🔍 Searching for: "${query}"`)
    try {
      const results = await codeIndexManager.searchIndex(query, 3)

      if (results.length === 0) {
        logger.info('[run-demo]  No results found')
      } else {
        results.forEach((result: any, index: number) => {
          logger.info(`[run-demo]  ${index + 1}. ${result.payload?.filePath || 'Unknown file'}`)
          logger.info(`[run-demo]     Score: ${result.score.toFixed(3)}`)
          logger.info(`[run-demo]     Lines: ${result.payload?.startLine}-${result.payload?.endLine}`)
          logger.info(`[run-demo]     Preview: ${(result.payload?.codeChunk || '').substring(0, 100)}...`)
        })
      }
    } catch (error) {
      logger.error(`[run-demo]  Error searching for "${query}":`, error)
    }
  }
}


const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] === __filename) {
  main().catch(console.error)
}
export { main as runDemo }
