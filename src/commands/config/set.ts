/**
 * Config set command implementation
 */
import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as jsoncParser from 'jsonc-parser';
import { saveJsoncPreservingComments } from '../../utils/jsonc-helpers';
import { ensureGitGlobalIgnorePatterns } from '../../utils/git-global-ignore';
import { DEFAULT_CONFIG } from '../../code-index/constants';
import { CodeIndexConfig } from '../../code-index/interfaces/config';
import { ConfigValidator } from '../../code-index/config-validator';
import { resolveWorkspacePath } from '../shared';

/**
 * Parse configuration value with type conversion and validation
 */
function parseConfigValue(key: string, value: string): any {
  if (key === 'isEnabled' || key === 'rerankerEnabled') {
    if (value !== 'true' && value !== 'false') {
      console.error(`Invalid boolean value for ${key}: ${value} (must be 'true' or 'false')`);
      process.exit(1);
    }
    return value === 'true';
  }

  const integerKeys = new Set([
    'embedderModelDimension',
    'embedderOllamaBatchSize',
    'embedderOpenAiBatchSize',
    'embedderOpenAiCompatibleBatchSize',
    'embedderGeminiBatchSize',
    'embedderMistralBatchSize',
    'embedderOpenRouterBatchSize',
    'rerankerBatchSize',
    'vectorSearchMaxResults'
  ]);
  const numberKeys = new Set([
    'vectorSearchMinScore',
    'rerankerMinScore'
  ]);

  if (integerKeys.has(key) || numberKeys.has(key)) {
    const isInteger = integerKeys.has(key);
    const pattern = isInteger ? /^-?\d+$/ : /^-?\d+(?:\.\d+)?$/;
    if (!pattern.test(value)) {
      console.error(`Invalid numeric value for ${key}: ${value} (must be a ${isInteger ? 'integer' : 'number'})`);
      process.exit(1);
    }
    const parsed = isInteger ? parseInt(value, 10) : parseFloat(value);
    if (!Number.isFinite(parsed)) {
      console.error(`Invalid numeric value for ${key}: ${value}`);
      process.exit(1);
    }
    if (key === 'embedderModelDimension' && parsed <= 0) {
      console.error(`Invalid value for ${key}: ${value} (must be positive)`);
      process.exit(1);
    }
    return parsed;
  }

  if (key === 'embedderProvider') {
    const validProviders = ['openai', 'ollama', 'openai-compatible', 'jina', 'gemini', 'mistral', 'vercel-ai-gateway', 'openrouter'];
    if (!validProviders.includes(value)) {
      console.error(`Invalid embedderProvider: ${value}`);
      console.error(`Valid providers: ${validProviders.join(', ')}`);
      process.exit(1);
    }
    return value;
  }

  if (key === 'rerankerProvider') {
    const validProviders = ['ollama', 'openai-compatible'];
    if (!validProviders.includes(value)) {
      console.error(`Invalid rerankerProvider: ${value}`);
      console.error(`Valid providers: ${validProviders.join(', ')}`);
      process.exit(1);
    }
    return value;
  }

  return value;
}

/**
 * Config set handler
 */
export default async function configSetHandler(configString: string, options: any): Promise<void> {
  const configPairs = configString.split(',').map(s => s.trim());
  const newConfig: Record<string, any> = {};

  for (const pair of configPairs) {
    const firstEqualIndex = pair.indexOf('=');
    if (firstEqualIndex === -1) {
      console.error(`Invalid configuration format: ${pair} (should be key=value)`);
      process.exit(1);
    }

    const key = pair.substring(0, firstEqualIndex).trim();
    const value = pair.substring(firstEqualIndex + 1).trim();

    if (!key || value === '') {
      console.error(`Invalid configuration format: ${pair} (empty key or value)`);
      process.exit(1);
    }

    newConfig[key] = parseConfigValue(key, value);
  }

  type ConfigKey = keyof CodeIndexConfig;
  const validKeys: ConfigKey[] = [
    'isEnabled',
    'embedderProvider', 'embedderModelId', 'embedderModelDimension',
    'embedderOllamaBaseUrl', 'embedderOllamaBatchSize',
    'embedderOpenAiApiKey', 'embedderOpenAiBatchSize',
    'embedderOpenAiCompatibleBaseUrl', 'embedderOpenAiCompatibleApiKey', 'embedderOpenAiCompatibleBatchSize',
    'embedderGeminiApiKey', 'embedderGeminiBatchSize',
    'embedderMistralApiKey', 'embedderMistralBatchSize',
    'embedderVercelAiGatewayApiKey',
    'embedderOpenRouterApiKey', 'embedderOpenRouterBatchSize',
    'qdrantUrl', 'qdrantApiKey',
    'vectorSearchMinScore', 'vectorSearchMaxResults',
    'rerankerEnabled', 'rerankerProvider',
    'rerankerOllamaBaseUrl', 'rerankerOllamaModelId',
    'rerankerOpenAiCompatibleBaseUrl', 'rerankerOpenAiCompatibleModelId', 'rerankerOpenAiCompatibleApiKey',
    'rerankerMinScore', 'rerankerBatchSize'
  ];

  for (const key of Object.keys(newConfig)) {
    if (!validKeys.includes(key as ConfigKey)) {
      console.error(`Invalid configuration item: ${key}`);
      console.error(`Supported configuration items: ${validKeys.join(', ')}`);
      process.exit(1);
    }
  }

  const workspacePath = resolveWorkspacePath(options.path, false);
  const projectConfigPath = options.config || path.join(workspacePath, 'autodev-config.json');
  const globalConfigPath = path.join(os.homedir(), '.autodev-cache', 'autodev-config.json');
  const configPath = options.global ? globalConfigPath : projectConfigPath;

  let existingConfig: Record<string, any> = {};
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      existingConfig = jsoncParser.parse(content);
    }
  } catch (error) {
    console.error(`Failed to read existing configuration: ${error}`);
    console.error(`File path: ${configPath}`);
    console.error('Please check file format or fix manually using a text editor');
    process.exit(1);
  }

  const mergedConfig = { ...DEFAULT_CONFIG, ...existingConfig, ...newConfig };

  const validationResult = ConfigValidator.validate(mergedConfig as CodeIndexConfig);
  if (!validationResult.valid) {
    console.error('Configuration validation failed:');
    for (const issue of validationResult.issues) {
      console.error(`  - ${issue.path}: ${issue.message}`);
    }
    process.exit(1);
  }

  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    const originalContent = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, 'utf-8')
      : '';

    const content = saveJsoncPreservingComments(originalContent, mergedConfig);

    fs.writeFileSync(configPath, content);
    console.log(`Configuration saved to: ${configPath}`);
    console.log('Updated configuration items:');
    for (const [key, value] of Object.entries(newConfig)) {
      console.log(`  ${key}: ${value}`);
    }

    try {
      const ignoreResult = await ensureGitGlobalIgnorePatterns(['autodev-config.json']);
      if (ignoreResult.didUpdate && ignoreResult.excludesFilePath) {
        console.log(`Added 'autodev-config.json' to git global ignore: ${ignoreResult.excludesFilePath}`);
      }
    } catch {
      // Best-effort; configuration write already succeeded
    }
  } catch (error) {
    console.error(`Failed to save configuration: ${error}`);
    process.exit(1);
  }
}
