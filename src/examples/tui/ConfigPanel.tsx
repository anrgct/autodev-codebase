import React from 'react';
import { Box, Text } from 'ink';

interface ConfigPanelProps {
  config: any;
  onConfigUpdate: (config: any) => void;
  onLog: (message: string) => void;
}

export const ConfigPanel: React.FC<ConfigPanelProps> = ({ config, onConfigUpdate, onLog }) => {
  const maskKey = (key?: string) => {
    if (!key) return 'Not set';
    if (key.length <= 3) return '*'.repeat(key.length);
    return `${key.slice(0, 2)}***${key.slice(-1)}`;
  };

  const provider = config?.embedder?.provider ?? config?.embedderProvider;
  const modelId = config?.embedder?.model ?? config?.modelId;
  const dimension = config?.embedder?.dimension;

  const ollamaUrl = provider === 'ollama'
    ? (config?.embedder?.baseUrl || config?.ollamaOptions?.ollamaBaseUrl)
    : undefined;

  const openAiBaseUrl = provider === 'openai-compatible'
    ? config?.embedder?.baseUrl
    : undefined;

  const qdrantUrl = config?.qdrantUrl;
  const isEnabled = config?.isEnabled ?? false;

  const openAiKey = provider === 'openai' ? config?.embedder?.apiKey : undefined;
  const ollamaKey = provider === 'ollama' ? config?.embedder?.apiKey : undefined;
  const openAiCompatKey = provider === 'openai-compatible' ? config?.embedder?.apiKey : undefined;
  const qdrantKey = config?.qdrantApiKey;

  return (
    <Box flexDirection="column">
      <Text bold color="yellow">⚙️  Configuration</Text>
      {config ? (
        <Box flexDirection="column" key="config-loaded" marginTop={1}>
          <Text color="green">✔ Configuration loaded</Text>
          <Box key="provider">
          <Text>
              <Text color="gray">Provider: </Text>
              <Text color="white">{provider || 'Not set'}</Text>
            </Text>
          </Box>
          <Box key="model">
            <Text>
              <Text color="gray">Model: </Text>
              <Text color="white">{modelId || 'Not set'}</Text>
            </Text>
          </Box>
          <Box key="dimension">
            <Text>
              <Text color="gray">Dimension: </Text>
              <Text color="white">{dimension || 'Not set'}</Text>
            </Text>
          </Box>
          <Box key="ollama-url">
            <Text>
              <Text color="gray">Ollama URL: </Text>
              <Text color="white">{ollamaUrl || 'Not set'}</Text>
            </Text>
          </Box>
          <Box key="openai-base-url">
            <Text>
              <Text color="gray">OpenAI Compatible URL: </Text>
              <Text color="white">{openAiBaseUrl || 'Not set'}</Text>
            </Text>
          </Box>
          <Box key="qdrant-url">
            <Text>
              <Text color="gray">Qdrant URL: </Text>
              <Text color="white">{qdrantUrl || 'Not set'}</Text>
            </Text>
          </Box>
          <Box key="api-keys" flexDirection="column" marginTop={1}>
            <Text color="gray">API Keys:</Text>
            <Text>• Ollama: <Text color="white">{maskKey(ollamaKey)}</Text></Text>
            <Text>• OpenAI: <Text color="white">{maskKey(openAiKey)}</Text></Text>
            <Text>• OpenAI Compatible: <Text color="white">{maskKey(openAiCompatKey)}</Text></Text>
            <Text>• Qdrant: <Text color="white">{maskKey(qdrantKey)}</Text></Text>
          </Box>
          <Box key="status">
            <Text>
              <Text color="gray">Status: </Text>
              <Text color={isEnabled ? 'green' : 'red'}>
                {isEnabled ? 'Enabled' : 'Disabled'}
              </Text>
            </Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" key="config-default" marginTop={1}>
          <Text color="gray">Default settings:</Text>
          <Box flexDirection="column" key="default-list">
            <Text key="default-provider">• Provider: ollama</Text>
            <Text key="default-model">• Model: nomic-embed-text</Text>
            <Text key="default-ollama">• Ollama: http://localhost:11434</Text>
            <Text key="default-qdrant">• Qdrant: http://localhost:6333</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};
