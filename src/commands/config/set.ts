/**
 * Config set command implementation
 */
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as jsoncParser from 'jsonc-parser'
import { saveJsoncPreservingComments } from '../../utils/jsonc-helpers'
import { ensureGitGlobalIgnorePatterns } from '../../utils/git-global-ignore'
import { DEFAULT_CONFIG } from '../../code-index/constants'
import { CodeIndexConfig } from '../../code-index/interfaces/config'
import { ConfigValidator } from '../../code-index/config-validator'
import { resolveWorkspacePath } from '../shared'
import { parseConfigValue, parseConfigPairs } from './parser'
import { loadConfigLayers } from './file-loader'

/**
 * Save configuration to file
 */
async function saveConfig(
  configPath: string,
  mergedConfig: Record<string, any>,
  newConfig: Record<string, any>
): Promise<void> {
  const dir = path.dirname(configPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const originalContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : ''

  const content = saveJsoncPreservingComments(originalContent, mergedConfig)
  fs.writeFileSync(configPath, content)

  console.log(`Configuration saved to: ${configPath}`)
  console.log('Updated configuration items:')
  for (const [key, value] of Object.entries(newConfig)) {
    console.log(`  ${key}: ${value}`)
  }

  try {
    const ignoreResult = await ensureGitGlobalIgnorePatterns(['autodev-config.json'])
    if (ignoreResult.didUpdate && ignoreResult.excludesFilePath) {
      console.log(`Added 'autodev-config.json' to git global ignore: ${ignoreResult.excludesFilePath}`)
    }
  } catch {
    // Best-effort; configuration write already succeeded
  }
}

/**
 * Config set handler
 */
export default async function configSetHandler(
  configString: string,
  options: Record<string, unknown>
): Promise<void> {
  // Parse and validate key=value pairs
  const parsedPairs = parseConfigPairs(configString)

  // Parse values according to their types
  const newConfig: Record<string, any> = {}
  for (const [key, value] of Object.entries(parsedPairs)) {
    newConfig[key] = parseConfigValue(key, value)
  }

  // Determine config path
  const workspacePath = resolveWorkspacePath(options['path'] as string, false)
  const projectConfigPath = (options['config'] as string) || path.join(workspacePath, 'autodev-config.json')
  const globalConfigPath = path.join(os.homedir(), '.autodev-cache', 'autodev-config.json')
  const configPath = options['global'] ? globalConfigPath : projectConfigPath

  // Load existing configuration
  const layers = loadConfigLayers(globalConfigPath, projectConfigPath, DEFAULT_CONFIG)
  const existingConfig = (options['global'] ? layers.global.config : layers.project.config) || {}
  const mergedConfig = { ...DEFAULT_CONFIG, ...existingConfig, ...newConfig }

  // Validate merged configuration
  const validationResult = ConfigValidator.validate(mergedConfig as CodeIndexConfig)
  if (!validationResult.valid) {
    console.error('Configuration validation failed:')
    for (const issue of validationResult.issues) {
      console.error(`  - ${issue.path}: ${issue.message}`)
    }
    process.exit(1)
  }

  // Save configuration
  await saveConfig(configPath, mergedConfig, newConfig)
}
