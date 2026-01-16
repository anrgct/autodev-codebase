/**
 * Config get command implementation
 */
import * as path from 'path'
import * as os from 'os'
import { DEFAULT_CONFIG } from '../../code-index/constants'
import { CodeIndexConfig } from '../../code-index/interfaces/config'
import { resolveWorkspacePath } from '../shared'
import { loadConfigLayers, type ConfigLayers } from './file-loader'

/**
 * Format configuration value for display
 */
function formatValue(value: unknown): string {
	if (value === undefined) return 'undefined'
	if (value === null) return 'null'
	if (typeof value === 'object') return JSON.stringify(value)
	return String(value)
}

/**
 * Print all configuration layers in detail
 */
function printAllConfigLayers(layers: ConfigLayers): void {
	const { defaultConfig, global, project, effective } = layers

	console.log('\n=== Configuration Layers (Highest Priority First) ===\n')

	console.log('【1. Effective Configuration】(Final values after merging all layers)')
	console.log(JSON.stringify(effective, null, 2))
	console.log()

	console.log('【2. Project Configuration】(Overrides global and default values)')
	if (project.config) {
		console.log(`File path: ${project.path}`)
		console.log(JSON.stringify(project.config, null, 2))
	} else {
		console.log('(Not configured)')
	}
	console.log()

	console.log('【3. Global Configuration】(Overrides default values)')
	if (global.config) {
		console.log(`File path: ${global.path}`)
		console.log(JSON.stringify(global.config, null, 2))
	} else {
		console.log('(Not configured)')
	}
	console.log()

	console.log('【4. Default Values】(Built-in fallback values)')
	console.log(JSON.stringify(defaultConfig, null, 2))
}

/**
 * Print detailed layers for specific configuration items
 */
function printConfigItemLayers(keys: string[], layers: ConfigLayers): void {
	const { defaultConfig, global, project, effective } = layers

	for (const key of keys) {
		console.log(`\n=== ${key} ===`)

		const defaultValue = defaultConfig[key]
		const globalValue = global.config?.[key]
		const projectValue = project.config?.[key]
		const effectiveValue = effective[key]

		console.log(`Default: ${formatValue(defaultValue)}`)
		console.log(`Global: ${globalValue !== undefined ? formatValue(globalValue) : '(Not set)'}`)
		console.log(`Project: ${projectValue !== undefined ? formatValue(projectValue) : '(Not set)'}`)
		console.log(`Effective: ${formatValue(effectiveValue)}`)
	}
}

/**
 * Config get handler
 */
export default async function configGetHandler(items: string[], options: Record<string, unknown>): Promise<void> {
	const workspacePath = resolveWorkspacePath(options['path'] as string, false)
	const projectConfigPath = (options['config'] as string) || path.join(workspacePath, 'autodev-config.json')
	const globalConfigPath = path.join(os.homedir(), '.autodev-cache', 'autodev-config.json')

	const layers = loadConfigLayers(globalConfigPath, projectConfigPath, DEFAULT_CONFIG)

	if (options['json']) {
		if (items.length === 0) {
			console.log(
				JSON.stringify(
					{
						paths: {
							default: '(Built-in)',
							global: globalConfigPath,
							project: projectConfigPath
						},
						default: layers.defaultConfig,
						global: layers.global.config || {},
						project: layers.project.config || {},
						effective: layers.effective
					},
					null,
					2
				)
			)
		} else {
			const result: Record<string, any> = {}
			for (const key of items) {
				result[key] = {
					default: layers.defaultConfig[key as keyof CodeIndexConfig],
					global: layers.global.config?.[key as keyof CodeIndexConfig] ?? null,
					project: layers.project.config?.[key as keyof CodeIndexConfig] ?? null,
					effective: layers.effective[key as keyof CodeIndexConfig]
				}
			}
			console.log(JSON.stringify(result, null, 2))
		}
	} else if (items.length === 0) {
		printAllConfigLayers(layers)
	} else {
		printConfigItemLayers(items, layers)
	}
}
