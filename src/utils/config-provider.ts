/**
 * Config Provider
 * A simplified configuration provider that reads from environment variables and config files
 */
import * as path from 'path'
import * as os from 'os'
import { readFileText, exists } from './filesystem'

/**
 * Configuration file path
 * Located at ~/.autodev-cache/autodev-config.json
 */
const CONFIG_FILE = path.join(os.homedir(), '.autodev-cache', 'autodev-config.json')

/**
 * Environment variable mapping for secrets
 * Maps internal key names to environment variable names
 */
const SECRET_ENV_MAP: Record<string, string> = {
  'codeIndexOpenAiKey': 'OPENAI_API_KEY',
  'codeIndexQdrantApiKey': 'QDRANT_API_KEY',
  'codebaseIndexOpenAiCompatibleApiKey': 'OPENAI_COMPATIBLE_API_KEY',
  'codebaseIndexGeminiApiKey': 'GEMINI_API_KEY',
  'codebaseIndexMistralApiKey': 'MISTRAL_API_KEY',
  'codebaseIndexVercelAiGatewayApiKey': 'VERCEL_AI_GATEWAY_API_KEY',
  'codebaseIndexOpenRouterApiKey': 'OPENROUTER_API_KEY'
}

/**
 * Configuration provider interface
 * Defines the contract for configuration providers
 */
export interface IConfigProvider {
  getGlobalState(key: string): any
  getSecret(key: string): Promise<string>
  refreshSecrets(): Promise<void>
}

/**
 * Simple configuration provider implementation
 * Supports reading from config files and environment variables
 */
export class SimpleConfigProvider implements IConfigProvider {
  private config: Record<string, any> = {}
  private loaded = false

  /**
   * Load configuration from file
   * Does not throw if file doesn't exist
   */
  async loadConfig(): Promise<void> {
    try {
      const configExists = await exists(CONFIG_FILE)
      if (configExists) {
        const content = await readFileText(CONFIG_FILE)
        this.config = JSON.parse(content)
      } else {
        this.config = {}
      }
    } catch {
      // If config file doesn't exist or is invalid, use empty config
      this.config = {}
    }
    this.loaded = true
  }

  /**
   * Ensure configuration is loaded
   * Call this before accessing config data
   */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.loadConfig()
    }
  }

  /**
   * Get a global state value by key
   * @param key - The configuration key to retrieve
   * @returns The configuration value or undefined
   */
  getGlobalState(key: string): any {
    // Note: This is synchronous, so we return whatever is currently loaded
    // Call loadConfig() or ensureLoaded() before using if async initialization is needed
    return this.config[key]
  }

  /**
   * Get a secret value by key
   * Environment variables take priority over config file values
   * @param key - The secret key to retrieve
   * @returns The secret value or empty string
   */
  async getSecret(key: string): Promise<string> {
    // Priority 1: Environment variable
    const envKey = SECRET_ENV_MAP[key]
    if (envKey && process.env[envKey]) {
      return process.env[envKey]!
    }

    // Priority 2: Config file secrets section
    await this.ensureLoaded()
    return this.config['secrets']?.[key] ?? ''
  }

  /**
   * Refresh secrets by reloading the configuration file
   */
  async refreshSecrets(): Promise<void> {
    await this.loadConfig()
  }
}

/**
 * Create a new SimpleConfigProvider instance
 * @returns A new SimpleConfigProvider
 */
export function createSimpleConfigProvider(): SimpleConfigProvider {
  return new SimpleConfigProvider()
}

/**
 * Create and initialize a SimpleConfigProvider
 * @returns An initialized SimpleConfigProvider
 */
export async function createInitializedConfigProvider(): Promise<SimpleConfigProvider> {
  const provider = new SimpleConfigProvider()
  await provider.loadConfig()
  return provider
}

// Global singleton instance
let globalConfigProvider: SimpleConfigProvider | null = null

/**
 * Get the global config provider instance
 * Creates one if it doesn't exist
 * @returns The global SimpleConfigProvider instance
 */
export function getGlobalConfigProvider(): SimpleConfigProvider {
  if (!globalConfigProvider) {
    globalConfigProvider = new SimpleConfigProvider()
  }
  return globalConfigProvider
}

/**
 * Set the global config provider instance
 * @param provider - The config provider to set as global
 */
export function setGlobalConfigProvider(provider: SimpleConfigProvider): void {
  globalConfigProvider = provider
}
