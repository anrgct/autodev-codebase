# 配置系统流程文档

## 概述

配置系统采用**三层架构**设计，支持项目级和全局级配置，通过优先级合并机制实现灵活的配置管理。

## 配置层级

配置优先级从高到低：

| 优先级 | 配置层 | 文件路径 |
|--------|--------|----------|
| 1 | 项目配置 | `./autodev-config.json` |
| 2 | 全局配置 | `~/.autodev-cache/autodev-config.json` |
| 3 | 默认配置 | 内置代码中 |

## 核心组件

```text-chart
[配置系统架构] (配置系统的核心组件及其关系)
配置系统
├── CLI层
│   ├── createConfigCommand:9    # 命令入口
│   ├── configGetHandler:79      # 获取配置
│   └── configSetHandler:54      # 设置配置
├── 核心管理层
│   ├── NodeConfigProvider:22    # Node.js配置提供者
│   ├── CodeIndexConfigManager:87 # 配置管理器
│   └── ConfigValidator:42       # 配置验证器
└── 工具层
    ├── parser.ts                # 值解析
    ├── file-loader.ts           # 文件加载
    └── metadata.ts              # 元数据定义
```

## 配置加载流程

```text-chart
[配置加载流程] (从文件到内存的完整加载过程)
NodeConfigProvider.loadConfig:137
├── 1. 加载默认配置
│   └── DEFAULT_CONFIG (内置默认值)
├── 2. 加载全局配置 (如果存在)
│   ├── 读取 ~/.autodev-cache/autodev-config.json
│   └── 合并到当前配置
└── 3. 加载项目配置 (如果存在)
    ├── 读取 ./autodev-config.json
    └── 合并到当前配置 (覆盖全局配置)
```

### 加载代码示例

```typescript
// src/adapters/nodejs/config.ts L137-181 (config.NodeConfigProvider.loadConfig:137-181)
async loadConfig(): Promise<CodeIndexConfig> {
  // Start with default configuration
  this.config = { ...DEFAULT_CONFIG }

  // 1. Load global configuration if it exists
  if (await this.fileSystem.exists(this.globalConfigPath)) {
    const globalConfig = jsoncParser.parse(globalText)
    this.config = { ...this.config, ...globalConfig }
  }

  // 2. Load project configuration if it exists
  if (await this.fileSystem.exists(this.configPath)) {
    const projectConfig = jsoncParser.parse(projectText)
    this.config = { ...this.config, ...projectConfig }
  }

  return this.config
}
```

## CLI配置命令流程

### 获取配置 (--get)

```text-chart
[config get流程] (查看配置层级和生效值)
configGetHandler:79
├── 解析路径参数
│   ├── workspacePath (工作目录)
│   ├── projectConfigPath (项目配置路径)
│   └── globalConfigPath (全局配置路径)
├── loadConfigLayers:67          # 加载所有配置层
│   ├── 加载全局配置层
│   ├── 加载项目配置层
│   └── 合并生成effective配置
└── 输出结果
    ├── --json格式 → JSON输出
    ├── 指定key → 显示该key的所有层级值
    └── 无参数 → 显示完整层级结构
```

### 设置配置 (--set)

```text-chart
[config set流程] (设置配置值并验证保存)
configSetHandler:54
├── 解析配置字符串
│   └── parseConfigPairs:106     # 解析key=value格式
├── 类型转换
│   └── parseConfigValue:18      # 根据元数据转换类型
├── 加载现有配置
│   └── loadConfigLayers:67
├── 合并配置
│   ├── DEFAULT_CONFIG (基础)
│   ├── existingConfig (现有)
│   └── newConfig (新值，最高优先级)
├── 验证配置
│   └── ConfigValidator.validate:48
└── 保存配置
    └── saveConfig:187           # 保留JSONC注释
```

## 配置验证流程

```text-chart
[配置验证流程] (ConfigValidator的验证逻辑)
ConfigValidator.validate:48
├── validateEmbedder:75          # 验证嵌入器配置
│   ├── openai → 检查API Key
│   ├── ollama → 检查Base URL
│   ├── openai-compatible → 检查URL和Key
│   └── ...其他提供商
├── validateQdrant:179           # 验证向量存储
├── validateReranker:192         # 验证重排序器 (可选)
├── validateSummarizer:254       # 验证摘要器 (可选)
└── validateBasicConsistency:325 # 验证数值范围
    ├── vectorSearchMinScore (0-1)
    ├── batchSize (>0)
    └── retryDelayMs (>=0)
```

## 配置管理器流程

```text-chart
[配置管理器初始化] (CodeIndexConfigManager的工作流程)
CodeIndexConfigManager.constructor:90
↓
_loadAndSetConfiguration:106
↓
loadConfiguration:120
├── _createConfigSnapshot:177    # 创建配置快照
├── 加载新配置
└── doesConfigChangeRequireRestart:235
    ├── 检查关键配置变更
    │   ├── embedderProvider (提供商)
    │   ├── embedderModelId (模型)
    │   ├── qdrantUrl (向量库地址)
    │   └── ...等REQUIRES_RESTART_KEYS
    └── 返回是否需要重启
```

### 热重载 vs 需要重启

```text-chart
[配置变更影响] (哪些配置可以热重载)
配置变更
├── 需要重启 (REQUIRES_RESTART_KEYS)
│   ├── isEnabled               # 功能开关
│   ├── embedderProvider        # 嵌入提供商
│   ├── embedderModelId         # 模型ID
│   ├── embedderModelDimension  # 向量维度
│   ├── qdrantUrl              # 向量库地址
│   └── ...核心配置
└── 可热重载 (HOT_RELOADABLE_KEYS)
    ├── vectorSearchMinScore    # 搜索阈值
    ├── vectorSearchMaxResults  # 最大结果数
    ├── rerankerEnabled        # 重排序开关
    └── ...运行时参数
```

## 配置元数据

所有配置项的元数据定义在 `metadata.ts` 中：

```typescript
// src/commands/config/metadata.ts L37-132 (metadata.CONFIG_KEY_METADATA)
export const CONFIG_KEY_METADATA: Record<ConfigKey, ConfigKeyMetadata> = {
  embedderProvider: {
    type: 'enum',
    enumValues: ['openai', 'ollama', 'openai-compatible', ...],
    description: 'Embedding provider to use'
  },
  vectorSearchMinScore: {
    type: 'number',
    minValue: 0,
    maxValue: 1,
    description: 'Minimum similarity score for search results'
  },
  // ...更多配置项
}
```

## 默认配置值

```typescript
// src/code-index/constants/index.ts L15-39 (index.DEFAULT_CONFIG)
export const DEFAULT_CONFIG: CodeIndexConfig = {
  isEnabled: true,
  embedderProvider: "ollama",
  embedderModelId: "nomic-embed-text",
  embedderModelDimension: 768,
  embedderOllamaBaseUrl: "http://localhost:11434",
  qdrantUrl: "http://localhost:6333",
  vectorSearchMinScore: 0.1,
  vectorSearchMaxResults: 20,
  rerankerEnabled: false,
  // ...
}
```

## 使用示例

### 查看所有配置层级

```bash
codebase config --get
```

### 查看特定配置项

```bash
codebase config --get embedderProvider vectorSearchMinScore
```

### 设置项目配置

```bash
codebase config --set embedderProvider=ollama,qdrantUrl=http://localhost:6333
```

### 设置全局配置

```bash
codebase config --set embedderProvider=openai --global
```

## 文件位置

| 文件 | 路径 | 说明 |
|------|------|------|
| 配置接口 | `src/code-index/interfaces/config.ts` | CodeIndexConfig定义 |
| 默认配置 | `src/code-index/constants/index.ts` | DEFAULT_CONFIG |
| Node配置提供者 | `src/adapters/nodejs/config.ts` | NodeConfigProvider |
| 配置管理器 | `src/code-index/config-manager.ts` | CodeIndexConfigManager |
| 配置验证器 | `src/code-index/config-validator.ts` | ConfigValidator |
| CLI配置命令 | `src/commands/config/index.ts` | createConfigCommand |
| 获取配置 | `src/commands/config/get.ts` | configGetHandler |
| 设置配置 | `src/commands/config/set.ts` | configSetHandler |
| 配置解析 | `src/commands/config/parser.ts` | parseConfigValue |
| 文件加载 | `src/commands/config/file-loader.ts` | loadConfigLayers |
| 元数据 | `src/commands/config/metadata.ts` | CONFIG_KEY_METADATA |