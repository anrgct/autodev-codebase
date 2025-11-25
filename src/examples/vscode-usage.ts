/**
 * Example of how to use the codebase library with VSCode adapters
 * This shows how to integrate the library into a VSCode extension
 */
import * as vscode from 'vscode'
import {
  VSCodeFileSystem,
  VSCodeStorage,
  VSCodeEventBus,
  VSCodeWorkspace,
  VSCodeConfigProvider,
  VSCodeLogger,
  VSCodeFileWatcher,
  IPlatformDependencies
} from '../adapters/vscode'

/**
 * Factory function to create VSCode platform dependencies
 */
export function createVSCodeDependencies(context: vscode.ExtensionContext): IPlatformDependencies {
  return {
    fileSystem: new VSCodeFileSystem(),
    storage: new VSCodeStorage(context),
    eventBus: new VSCodeEventBus(),
    logger: new VSCodeLogger('AutoDev Codebase'),
    fileWatcher: new VSCodeFileWatcher()
  }
}

/**
 * Example VSCode extension activation function
 */
export async function activate(context: vscode.ExtensionContext) {
  // Create platform dependencies
  const dependencies = createVSCodeDependencies(context)
  const workspace = new VSCodeWorkspace()
  const configProvider = new VSCodeConfigProvider()

  // Initialize the codebase library (this would be your actual CodeIndexManager)
  // const codebaseManager = new CodeIndexManager({
  //   ...dependencies,
  //   workspace,
  //   configProvider
  // })

  // Example: Listen for configuration changes
  const configDisposable = configProvider.onConfigChange(async (config) => {
    dependencies.logger?.info('Configuration changed', config)
    // Restart or reconfigure the codebase manager
  })

  // Example: Watch for file changes
  const rootPath = workspace.getRootPath()
  if (rootPath && dependencies.fileWatcher) {
    const watchDisposable = dependencies.fileWatcher.watchDirectory(rootPath, (event) => {
      dependencies.logger?.debug('File system event', event)
      // Handle file changes
    })
    
    context.subscriptions.push({ dispose: watchDisposable })
  }

  // Register disposables
  context.subscriptions.push(
    { dispose: () => configDisposable() },
    // Add your codebase manager disposal here
    // { dispose: () => codebaseManager.dispose() }
  )

  // Example: Register a command
  const command = vscode.commands.registerCommand('autodev.rebuildIndex', async () => {
    try {
      dependencies.logger?.info('Rebuilding code index...')
      // await codebaseManager.rebuildIndex()
      vscode.window.showInformationMessage('Code index rebuilt successfully')
    } catch (error) {
      dependencies.logger?.error('Failed to rebuild index', error)
      vscode.window.showErrorMessage(`Failed to rebuild index: ${error}`)
    }
  })

  context.subscriptions.push(command)
}

/**
 * Example deactivation function
 */
export function deactivate() {
  // Cleanup is handled by VSCode disposing the extension context
}

/**
 * Example of how to use the adapters in a test environment
 */
export function createTestDependencies(): IPlatformDependencies {
  // Create a mock ExtensionContext with just the required property
  const mockContext = {
    globalStorageUri: vscode.Uri.file('/tmp/test-storage'),
    subscriptions: []
  } as vscode.ExtensionContext

  return {
    fileSystem: new VSCodeFileSystem(),
    storage: new VSCodeStorage(mockContext),
    eventBus: new VSCodeEventBus(),
    logger: new VSCodeLogger('Test Logger'),
    fileWatcher: new VSCodeFileWatcher()
  }
}