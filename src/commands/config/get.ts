/**
 * Config get command implementation
 */
import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as jsoncParser from 'jsonc-parser';
import { DEFAULT_CONFIG } from '../../code-index/constants';
import { CodeIndexConfig } from '../../code-index/interfaces/config';
import { resolveWorkspacePath } from '../shared';

/**
 * Format configuration value for display
 */
function formatValue(value: any): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Format config value for display (with sensitive value masking)
 */
function formatConfigValueForDisplay(key: string, value: any): string {
  return formatValue(value);
}

/**
 * Print all configuration layers in detail
 */
function printAllConfigLayers(
  defaultConfig: Record<string, any>,
  globalConfig: Record<string, any> | null,
  projectConfig: Record<string, any> | null,
  effectiveConfig: Record<string, any>,
  globalConfigPath: string,
  projectConfigPath: string
): void {
  console.log('\n=== Configuration Layers (Highest Priority First) ===\n');

  console.log('【1. Effective Configuration】(Final values after merging all layers)');
  console.log(JSON.stringify(effectiveConfig, null, 2));
  console.log();

  console.log('【2. Project Configuration】(Overrides global and default values)');
  if (projectConfig) {
    console.log(`File path: ${projectConfigPath}`);
    console.log(JSON.stringify(projectConfig, null, 2));
  } else {
    console.log('(Not configured)');
  }
  console.log();

  console.log('【3. Global Configuration】(Overrides default values)');
  if (globalConfig) {
    console.log(`File path: ${globalConfigPath}`);
    console.log(JSON.stringify(globalConfig, null, 2));
  } else {
    console.log('(Not configured)');
  }
  console.log();

  console.log('【4. Default Values】(Built-in fallback values)');
  console.log(JSON.stringify(defaultConfig, null, 2));
}

/**
 * Print detailed layers for specific configuration items
 */
function printConfigItemLayers(
  keys: string[],
  defaultConfig: Record<string, any>,
  globalConfig: Record<string, any> | null,
  projectConfig: Record<string, any> | null,
  effectiveConfig: Record<string, any>
): void {
  for (const key of keys) {
    console.log(`\n=== ${key} ===`);

    const defaultValue = defaultConfig[key];
    const globalValue = globalConfig?.[key];
    const projectValue = projectConfig?.[key];
    const effectiveValue = effectiveConfig[key];

    console.log(`Default: ${formatConfigValueForDisplay(key, defaultValue)}`);
    console.log(`Global: ${globalValue !== undefined ? formatConfigValueForDisplay(key, globalValue) : '(Not set)'}`);
    console.log(`Project: ${projectValue !== undefined ? formatConfigValueForDisplay(key, projectValue) : '(Not set)'}`);
    console.log(`Effective: ${formatConfigValueForDisplay(key, effectiveValue)}`);
  }
}

/**
 * Config get handler
 */
export default async function configGetHandler(items: string[], options: any): Promise<void> {
  const workspacePath = resolveWorkspacePath(options.path, false);
  const projectConfigPath = options.config || path.join(workspacePath, 'autodev-config.json');
  const globalConfigPath = path.join(os.homedir(), '.autodev-cache', 'autodev-config.json');

  const defaultConfig = DEFAULT_CONFIG;

  let globalConfig: Record<string, any> | null = null;
  try {
    if (fs.existsSync(globalConfigPath)) {
      const content = fs.readFileSync(globalConfigPath, 'utf-8');
      globalConfig = jsoncParser.parse(content);
    }
  } catch (error) {
    console.error(`Failed to read global configuration: ${error}`);
    console.error(`Path: ${globalConfigPath}`);
    process.exit(1);
  }

  let projectConfig: Record<string, any> | null = null;
  try {
    if (fs.existsSync(projectConfigPath)) {
      const content = fs.readFileSync(projectConfigPath, 'utf-8');
      projectConfig = jsoncParser.parse(content);
    }
  } catch (error) {
    console.error(`Failed to read project configuration: ${error}`);
    console.error(`Path: ${projectConfigPath}`);
    process.exit(1);
  }

  const effectiveConfig = {
    ...defaultConfig,
    ...(globalConfig ?? {}),
    ...(projectConfig ?? {})
  };

  if (options.json) {
    if (items.length === 0) {
      console.log(JSON.stringify({
        paths: {
          default: '(Built-in)',
          global: globalConfigPath,
          project: projectConfigPath
        },
        default: defaultConfig,
        global: globalConfig || {},
        project: projectConfig || {},
        effective: effectiveConfig
      }, null, 2));
    } else {
      const result: Record<string, any> = {};
      for (const key of items) {
        const globalValue = globalConfig?.[key as keyof CodeIndexConfig] ?? null;
        const projectValue = projectConfig?.[key as keyof CodeIndexConfig] ?? null;
        const effectiveValue = effectiveConfig[key as keyof CodeIndexConfig];

        result[key] = {
          default: defaultConfig[key as keyof CodeIndexConfig],
          global: globalValue,
          project: projectValue,
          effective: effectiveValue
        };
      }
      console.log(JSON.stringify(result, null, 2));
    }
  } else {
    if (items.length === 0) {
      printAllConfigLayers(defaultConfig, globalConfig, projectConfig, effectiveConfig, globalConfigPath, projectConfigPath);
    } else {
      printConfigItemLayers(
        items,
        defaultConfig,
        globalConfig,
        projectConfig,
        effectiveConfig
      );
    }
  }
}
