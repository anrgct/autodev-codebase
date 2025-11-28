/**
 * Node.js Adapters
 * Platform-specific implementations for Node.js environment
 */

export { NodeFileSystem } from './file-system'
export { NodeStorage, type NodeStorageOptions } from './storage'
export { NodeEventBus } from './event-bus'
export { NodeLogger, type NodeLoggerOptions } from './logger'
export { NodeFileWatcher } from './file-watcher'
export { NodeWorkspace, NodePathUtils, type NodeWorkspaceOptions } from './workspace'
export { NodeConfigProvider, type NodeConfigOptions } from './config'

import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { NodeFileSystem } from './file-system'
import { NodeStorage, NodeStorageOptions } from './storage'
import { NodeEventBus } from './event-bus'
import { NodeLogger, NodeLoggerOptions } from './logger'
import { NodeFileWatcher } from './file-watcher'
import { NodeWorkspace, NodePathUtils, NodeWorkspaceOptions } from './workspace'
import { NodeConfigProvider, NodeConfigOptions } from './config'
import { IPlatformDependencies } from '../../abstractions/core'

/**
 * Factory function to create Node.js platform dependencies
 */
export function createNodeDependencies(options: {
  workspacePath: string
  storageOptions?: NodeStorageOptions
  loggerOptions?: NodeLoggerOptions
  configOptions?: NodeConfigOptions
}): IPlatformDependencies & {
  workspace: NodeWorkspace
  pathUtils: NodePathUtils
  configProvider: NodeConfigProvider
} {
  // Ensure global config directory exists
  const globalConfigDir = path.join(os.homedir(), '.autodev-cache')
  if (!fs.existsSync(globalConfigDir)) {
    fs.mkdirSync(globalConfigDir, { recursive: true })
  }

  const fileSystem = new NodeFileSystem()
  const storage = new NodeStorage(options.storageOptions)
  const eventBus = new NodeEventBus()
  const logger = new NodeLogger(options.loggerOptions)
  const fileWatcher = new NodeFileWatcher()

  const workspace = new NodeWorkspace(fileSystem, {
    rootPath: options.workspacePath,
    ...options.storageOptions
  })

  const pathUtils = new NodePathUtils()

  // Configure global config path in config options
  const configOptions = {
    ...options.configOptions,
    globalConfigPath: options.configOptions?.globalConfigPath || path.join(globalConfigDir, 'autodev-config.json')
  }

  const configProvider = new NodeConfigProvider(fileSystem, eventBus, configOptions)

  return {
    fileSystem,
    storage,
    eventBus,
    logger,
    fileWatcher,
    workspace,
    pathUtils,
    configProvider
  }
}

/**
 * Simplified Node.js factory for basic usage
 */
export function createSimpleNodeDependencies(workspacePath: string): IPlatformDependencies & {
  workspace: NodeWorkspace
  pathUtils: NodePathUtils
  configProvider: NodeConfigProvider
} {
  return createNodeDependencies({
    workspacePath,
    loggerOptions: {
      name: 'AutoDev-Codebase',
      level: 'info'
    }
  })
}
