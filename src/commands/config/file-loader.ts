/**
 * Shared configuration file loading utilities
 *
 * Provides common functions for loading configuration from files,
 * used by both get.ts and set.ts commands.
 */

import * as fs from 'fs'
import * as jsoncParser from 'jsonc-parser'

/**
 * Single configuration layer result
 */
export interface ConfigLayer {
	/** Parsed configuration object (or null if file doesn't exist) */
	config: Record<string, any> | null
	/** File path for this layer */
	path: string
}

/**
 * All configuration layers
 */
export interface ConfigLayers {
	/** Default built-in configuration */
	defaultConfig: Record<string, any>
	/** Global configuration layer */
	global: ConfigLayer
	/** Project configuration layer */
	project: ConfigLayer
	/** Effective configuration (merged: default → global → project) */
	effective: Record<string, any>
}

/**
 * Load a single configuration layer from a file
 *
 * @param filePath - Path to the configuration file
 * @param layerName - Name of the layer (for error messages)
 * @returns Parsed configuration object, or null if file doesn't exist
 */
function loadConfigLayer(filePath: string, layerName: string): Record<string, any> | null {
	try {
		if (fs.existsSync(filePath)) {
			const content = fs.readFileSync(filePath, 'utf-8')
			return jsoncParser.parse(content)
		}
		return null
	} catch (error) {
		console.error(`Failed to read ${layerName} configuration: ${error}`)
		console.error(`Path: ${filePath}`)
		process.exit(1)
	}
}

/**
 * Load all configuration layers
 *
 * Loads configuration from default, global, and project sources,
 * then merges them in priority order (project > global > default).
 *
 * @param globalConfigPath - Path to global configuration file
 * @param projectConfigPath - Path to project configuration file
 * @param defaultConfig - Default built-in configuration
 * @returns All configuration layers
 */
export function loadConfigLayers(
	globalConfigPath: string,
	projectConfigPath: string,
	defaultConfig: Record<string, any>
): ConfigLayers {
	const globalConfig = loadConfigLayer(globalConfigPath, 'global')
	const projectConfig = loadConfigLayer(projectConfigPath, 'project')

	const effectiveConfig = {
		...defaultConfig,
		...(globalConfig ?? {}),
		...(projectConfig ?? {})
	}

	return {
		defaultConfig,
		global: { config: globalConfig, path: globalConfigPath },
		project: { config: projectConfig, path: projectConfigPath },
		effective: effectiveConfig
	}
}
