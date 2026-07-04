/**
 * `codebase escalate` — start the auto flash → pro HTTP proxy.
 *
 * The proxy listens on a local port and forwards OpenAI-compatible
 * `POST /v1/chat/completions` requests to the upstream LLM API, injecting
 * the `ESCALATION_CONTRACT` and watching for the `<<<NEEDS_PRO>>>` self-
 * report marker to transparently retry the call on the pro model.
 *
 * Configuration priority: CLI options > project config > global config > defaults.
 * Uses the same NodeConfigProvider as every other command.
 */
import { Command } from 'commander'
import * as path from 'path'
import * as os from 'os'
import { startEscalateServer, type EscalateServerHandle } from '../escalate/server'
import { resolveForceAdvisorRules } from '../escalate/dispatcher'
import type { EscalateConfig } from '../escalate/types'
import { NodeFileSystem } from '../adapters/nodejs/file-system'
import { NodeEventBus } from '../adapters/nodejs/event-bus'
import { NodeConfigProvider } from '../adapters/nodejs/config'
import { initGlobalLogger, getLogger, resolveWorkspacePath } from './shared'

export interface EscalateCommandOptions {
  port: string
  host: string
  apiBase: string
  apiKey?: string
  flashModel: string
  proModel: string
  path: string
  config?: string
  demo: boolean
  logLevel: string
}

/**
 * Load the escalate config using the standard ConfigProvider
 * (JSONC-compatible, 3-layer: default → global → project).
 * CLI options are applied on top as the highest-priority layer.
 */
async function loadEscalateConfig(options: EscalateCommandOptions): Promise<EscalateConfig> {
  const workspacePath = resolveWorkspacePath(options.path, options.demo)
  const projectConfigPath = options.config || path.join(workspacePath, 'autodev-config.json')
  const globalConfigPath = path.join(os.homedir(), '.autodev-cache', 'autodev-config.json')

  // Reuse the project's standard NodeConfigProvider — same JSONC parsing,
  // same 3-layer merge, same stability as every other subcommand.
  const fileSystem = new NodeFileSystem()
  const eventBus = new NodeEventBus()
  const provider = new NodeConfigProvider(fileSystem, eventBus, {
    configPath: projectConfigPath,
    globalConfigPath,
  })
  const fullConfig = await provider.loadConfig()

  // CLI overrides (highest priority)
  const cliOverrides: Record<string, unknown> = {}
  if (options.apiBase) cliOverrides['escalateApiBase'] = options.apiBase
  if (options.apiKey !== undefined) cliOverrides['escalateApiKey'] = options.apiKey
  if (options.flashModel) cliOverrides['escalateFlashModel'] = options.flashModel
  if (options.proModel) cliOverrides['escalateProModel'] = options.proModel
  if (options.port) {
    if (!/^\d+$/.test(options.port)) {
      throw new Error(`Invalid --port value: "${options.port}" (must be a numeric string)`)
    }
    cliOverrides['escalatePort'] = parseInt(options.port, 10)
  }
  if (options.host) cliOverrides['escalateHost'] = options.host

  // Merge: CLI > ConfigProvider (global+project+default)
  const apiBase = String(cliOverrides['escalateApiBase'] ?? fullConfig.escalateApiBase)
  const apiKey = cliOverrides['escalateApiKey'] ?? fullConfig.escalateApiKey ?? undefined
  const flashModel = String(cliOverrides['escalateFlashModel'] ?? fullConfig.escalateFlashModel)
  const proModel = String(cliOverrides['escalateProModel'] ?? fullConfig.escalateProModel)
  const host = String(cliOverrides['escalateHost'] ?? fullConfig.escalateHost)

  const portRaw = cliOverrides['escalatePort'] ?? fullConfig.escalatePort
  const port = typeof portRaw === 'number' ? portRaw : parseInt(String(portRaw), 10) || 8080
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid escalatePort: ${port} (must be an integer in [1, 65535])`)
  }

  const stickyProTtlMsRaw = fullConfig.escalateStickyProTtlMs
  const stickyNum = typeof stickyProTtlMsRaw === 'number' ? stickyProTtlMsRaw : parseInt(String(stickyProTtlMsRaw), 10)
  const stickyProTtlMs = Number.isFinite(stickyNum) && stickyNum >= 0 ? stickyNum : 300000

  const escalationMode = fullConfig.escalateMode as 'self-report' | 'advisor'

  const thinkingBudget = typeof fullConfig.escalateThinkingBudget === 'number'
    ? fullConfig.escalateThinkingBudget
    : 8000

  const maxTokens = typeof fullConfig.escalateMaxTokens === 'number'
    ? fullConfig.escalateMaxTokens
    : 4096

  const rawForceAdvisor = fullConfig.escalateForceAdvisor
  const forceAdvisor: boolean | string =
    rawForceAdvisor === true ? true
    : typeof rawForceAdvisor === 'string' ? rawForceAdvisor
    : false

  return {
    mode: escalationMode,
    apiBase,
    apiKey: apiKey ? String(apiKey) : undefined,
    flashModel,
    proModel,
    port,
    host,
    stickyProTtlMs,
    thinkingBudget,
    maxTokens,
    forceAdvisor,
  }
}

/**
 * Print the config to the user — first run / start of the proxy.
 */
function printStartupBanner(cfg: EscalateConfig, port: number): void {
  const bar = '─'.repeat(56)
  console.log(bar)
  console.log('  codebase escalate — flash → pro auto-escalation proxy')
  console.log(bar)
  console.log(`  Listening on : http://${cfg.host}:${port}`)
  console.log(`  Upstream API : ${cfg.apiBase}`)
  console.log(`  Mode         : ${cfg.mode}  (${cfg.mode === 'self-report' ? "model self-reports <<<NEEDS_PRO>>> marker" : "virtual 'advisor' tool — flash calls it, proxy routes to pro"})`)
  console.log(`  Flash model  : ${cfg.flashModel}  (first attempt)`)
  console.log(`  Pro model    : ${cfg.proModel}    (needs stronger tier)`)
  console.log(`  API key      : ${cfg.apiKey ? '(configured)' : '(forwarded from client)'}`)
  console.log(`  Sticky pro   : ${cfg.stickyProTtlMs > 0 ? `${cfg.stickyProTtlMs}ms TTL` : 'disabled'}`)
  console.log(`  Thinking bud : ${cfg.thinkingBudget}`)
  console.log(`  Max tokens   : ${cfg.maxTokens}`)
  const forceAdvisorDisplay = typeof cfg.forceAdvisor === 'string'
    ? resolveForceAdvisorRules(cfg.forceAdvisor)
    : cfg.forceAdvisor
  const forceAdvisorStr = forceAdvisorDisplay === 'all' ? 'ON (all rules)'
    : forceAdvisorDisplay ? `ON (rules: ${cfg.forceAdvisor})`
    : 'off'
  console.log(`  Force advisor: ${forceAdvisorStr}`)
  console.log(bar)
  console.log('')
  console.log('  Point any Anthropic-compatible client at this URL. Example:')
  console.log(`    export ANTHROPIC_BASE_URL=http://${cfg.host}:${port}`)
  console.log('')
  console.log('  Health check:')
  console.log(`    curl http://${cfg.host}:${port}/health`)
  console.log('')
  console.log('  Press Ctrl+C to stop.')
  console.log('')
}

/**
 * Command handler.
 */
async function escalateHandler(options: EscalateCommandOptions): Promise<void> {
  const logLevel = (options.logLevel || 'info') as 'debug' | 'info' | 'warn' | 'error'
  initGlobalLogger(logLevel)
  const logger = getLogger()

  let cfg: EscalateConfig
  try {
    cfg = await loadEscalateConfig(options)
  } catch (err) {
    logger.error(`[escalate] config error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  // If port was specified as 0, allow OS to pick; the resolved port is in handle.port.
  // We listen on cfg.port, then startEscalateServer returns the actual port (in case of 0).
  let handle: EscalateServerHandle
  try {
    handle = await startEscalateServer({
      config: cfg,
      logger: {
        info: (m) => logger.info(m),
        warn: (m) => logger.warn(m),
        error: (m) => logger.error(m),
        debug: (m) => logger.debug(m),
      },
    })
  } catch (err) {
    logger.error(`[escalate] failed to start server: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  printStartupBanner(cfg, handle.port)

  // Graceful shutdown on SIGINT / SIGTERM.
  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`\n[escalate] received ${signal}, shutting down...`)
    try {
      await handle.stop()
      console.log('[escalate] stopped.')
    } catch (err) {
      console.error(`[escalate] error during shutdown: ${err instanceof Error ? err.message : String(err)}`)
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  // Keep the process alive (commander would otherwise exit after action).
  await new Promise(() => { /* never resolves */ })
}

/**
 * Create the `codebase escalate` subcommand.
 */
export function createEscalateCommand(): Command {
  const command = new Command('escalate')

  command
    .description('Start a local HTTP proxy that auto-escalates flash → pro (self-report markers or advisor tool)')
    .option('--port <port>', 'Listening port (default: 8080)')
    .option('--host <host>', 'Listening host (default: localhost)')
    .option('--api-base <url>', 'Upstream Anthropic-compatible API base URL (default: https://api.deepseek.com/anthropic)')
    .option('--api-key <key>', 'Upstream API key (if not set, forwards client Authorization header)')
    .option('--flash-model <id>', 'Flash (cheap) model ID (default: deepseek-v4-flash)')
    .option('--pro-model <id>', 'Pro (strong) model ID (default: deepseek-v4-pro)')
    .option('-p, --path <path>', 'Working directory (for project config lookup)', '.')
    .option('-c, --config <path>', 'Configuration file path')
    .option('--demo', 'Use demo workspace')
    .option('--log-level <level>', 'Log level: debug|info|warn|error', 'info')
    .action(escalateHandler)

  return command
}
