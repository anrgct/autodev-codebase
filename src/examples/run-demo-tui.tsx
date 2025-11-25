#!/usr/bin/env node

import React from 'react';
import { render, Box, Text } from 'ink';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createNodeDependencies } from '../adapters/nodejs';
import { CodeIndexManager } from '../code-index/manager';
import { App } from './tui/App';
import fs from 'fs';
import createSampleFiles from './create-sample-files';

const DEMO_FOLDER = path.join(process.cwd(), 'demo');
const OLLAMA_BASE_URL = 'http://localhost:11434';
const QDRANT_URL = 'http://localhost:6333';
const OLLAMA_MODEL = 'nomic-embed-text';


const AppWithData: React.FC = () => {
  const [codeIndexManager, setCodeIndexManager] = React.useState<any>(null);
  const [dependencies, setDependencies] = React.useState<any>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    async function initialize() {
      const deps = createNodeDependencies({
        workspacePath: DEMO_FOLDER,
        storageOptions: {
          globalStoragePath: path.join(process.cwd(), '.autodev-storage'),
        },
        loggerOptions: {
          name: 'Demo-Codebase-TUI',
          level: 'error',
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
      });
      try {
        const demoFolderExists = await deps.fileSystem.exists(DEMO_FOLDER);
        if (!demoFolderExists) {
          fs.mkdirSync(DEMO_FOLDER, { recursive: true });
          await createSampleFiles(deps.fileSystem, DEMO_FOLDER);
        }

        deps.logger?.info('[run-demo]⚙️ 加载配置...');
        const config = await deps.configProvider.loadConfig();
        deps.logger?.info('[run-demo]📝 配置内容:', JSON.stringify(config, null, 2));

        deps.logger?.info('[run-demo]✅ 验证配置...');
        const validation = await deps.configProvider.validateConfig();
        deps.logger?.info('[run-demo]📝 验证结果:', validation);

        if (!validation.isValid) {
          deps.logger?.warn('[run-demo]⚠️ 配置验证警告:', validation.errors);
          deps.logger?.info('[run-demo]⚠️ 继续初始化（调试模式）');
          // 在调试模式下，我们允许配置验证失败但继续初始化
        } else {
          deps.logger?.info('[run-demo]✅ 配置验证通过');
        }

        setDependencies(deps);

        deps.logger?.info('Creating CodeIndexManager with dependencies:', {
          hasFileSystem: !!deps.fileSystem,
          hasStorage: !!deps.storage,
          hasEventBus: !!deps.eventBus,
          hasWorkspace: !!deps.workspace,
          hasPathUtils: !!deps.pathUtils,
          hasConfigProvider: !!deps.configProvider,
          workspaceRootPath: deps.workspace.getRootPath()
        });

        const manager = CodeIndexManager.getInstance(deps);
        deps.logger?.info('CodeIndexManager instance created:', !!manager);

        if (!manager) {
          setError('Failed to create CodeIndexManager - workspace root path may be invalid');
          return;
        }

        deps.logger?.info('[run-demo]⚙️ 初始化 CodeIndexManager...');
        const initResult = await manager.initialize();
        deps.logger?.info('[run-demo]✅ CodeIndexManager 初始化成功:', initResult);
        deps.logger?.info('[run-demo]📝 管理器状态:', {
          isInitialized: manager.isInitialized,
          isFeatureEnabled: manager.isFeatureEnabled,
          isFeatureConfigured: manager.isFeatureConfigured,
          state: manager.state
        });
        deps.logger?.info('[run-demo]🔄 设置 CodeIndexManager 到状态中...');
        setCodeIndexManager(manager);
        deps.logger?.info('[run-demo]✅ CodeIndexManager 已设置到状态');

        // Start indexing in background
        deps.logger?.info('[run-demo]🚀 准备开始索引...');
        // 设置进度监控
        manager.onProgressUpdate((progressInfo) => {
          deps.logger?.info('[run-demo]📊 索引进度:', progressInfo);
        });

        setTimeout(() => {
          if (manager.isFeatureEnabled && manager.isInitialized) {
            deps.logger?.info('[run-demo]🚀 开始索引进程...');
            deps.logger?.info('[run-demo]📊 当前状态:', manager.state);

            // 添加超时保护
            const indexingTimeout = setTimeout(() => {
              deps.logger?.warn('[run-demo]⚠️ 索引进程超时（30秒），可能卡住了');
            }, 30000);

            manager.startIndexing()
              .then(() => {
                clearTimeout(indexingTimeout);
                deps.logger?.info('[run-demo]✅ 索引完成');
              })
              .catch((err: any) => {
                clearTimeout(indexingTimeout);
                deps.logger?.error('[run-demo]❌ 索引失败:', err);
                deps.logger?.error('[run-demo]❌ 错误堆栈:', err.stack);
                setError(`Indexing failed: ${err.message}`);
              });
          } else {
            deps.logger?.warn('[run-demo]⚠️ 跳过索引 - 功能未启用或未初始化');
            deps.logger?.error('[run-demo]📊 功能状态:', {
              isFeatureEnabled: manager.isFeatureEnabled,
              isInitialized: manager.isInitialized,
              state: manager.state
            });
          }
        }, 1000);
        deps.logger?.info('[run-demo]✅ 初始化完成');

      } catch (err: any) {
        deps.logger?.error('[run-demo]❌ 初始化失败:', err);
        deps.logger?.error('[run-demo]❌ 错误堆栈:', err.stack);
        setError(`Initialization failed: ${err.message}`);
      }
    }

    initialize();
  }, []);

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="red">❌ 初始化失败</Text>
        <Text color="white">{error}</Text>
        <Text color="gray">请检查配置或服务连接状态</Text>
      </Box>
    );
  }

  return <App codeIndexManager={codeIndexManager} dependencies={dependencies} />;
};


if (import.meta.url === `file://${process.argv[1]}`) {
  render(<AppWithData />);
}

export default AppWithData;
