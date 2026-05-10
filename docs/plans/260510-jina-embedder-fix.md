# 250510-jina-embedder-fix

## 主题/需求

修复并完善 Jina embedder provider 在 `autodev-codebase` 项目中的支持，包括：

1. **配置绕过问题**：`embedderModelId` 配置项被注释但仍可正常使用
2. **运行时崩溃**：执行 `codebase index --force --demo` 报错 `Cannot create services: Code indexing is not properly configured`
3. **缺失配置项**：Jina provider 缺少 `embedderJinaApiKey` 和 `embedderJinaBaseUrl` 配置字段
4. **代码缺陷**：`config-validator.ts` 中 Jina 校验误用了 Gemini 的 API key 字段

预期成果：Jina provider 能完整通过配置验证、服务创建，并正常调用 Jina API。

## 代码背景

### 项目定位

基于向量嵌入的代码语义搜索工具，支持 MCP 服务器集成，使用 Qdrant 向量数据库后端和 Tree-sitter 代码解析。

### 技术栈

- 语言：TypeScript
- 构建：tsx（直接运行 TypeScript）
- 配置：JSONC（JSON with Comments）
- DI：手动依赖注入模式

### 相关文件

| 文件 | 用途 |
|------|------|
| `src/code-index/interfaces/config.ts` (config.CodeIndexConfig) | 配置类型定义，所有配置项的 TS 接口 |
| `src/code-index/service-factory.ts` (service-factory.CodeIndexServiceFactory.createEmbedder) | 服务工厂，根据 provider 创建 embedder 实例 |
| `src/code-index/config-manager.ts` (config-manager.CodeIndexConfigManager) | 配置管理器，包含 `isConfigured()` 和重启检测逻辑 |
| `src/code-index/config-validator.ts` (config-validator.ConfigValidator) | 配置校验器 |
| `src/code-index/i18n.ts` | 国际化错误信息 |
| `src/code-index/embedders/jina-embedder.ts` (jina-embedder.JinaEmbedder) | Jina embedder 实现 |
| `src/adapters/nodejs/config.ts` (NodeConfigProvider) | Node.js 配置提供者适配器 |
| `src/commands/config/metadata.ts` | CLI 配置元数据 |

### 依赖关系

```
service-factory.CodeIndexServiceFactory
  → config-manager.CodeIndexConfigManager.getConfig()     # 读取配置
  → jina-embedder.JinaEmbedder                            # 创建 embedder 实例
  → i18n.t()                                              # 错误信息

config-manager.CodeIndexConfigManager
  → config.CodeIndexConfig                                # 配置类型
  → isConfigured()                                        # 检查是否就绪

NodeConfigProvider
  → config.CodeIndexConfig                                # 配置类型
  → getEmbedderConfig()                                   # 转换为旧格式
  → isConfigured() / validateConfig()                     # 校验
```

## 关键决策

### 1. 配置项命名风格

| 选项 | 方案 | 结果 |
|------|------|------|
| ✅ **遵循现有约定**：`embedder{Provider}ApiKey` / `embedder{Provider}BaseUrl` | 与其他 provider 一致，无需特殊处理 | 采用 |
| ❌ 自定义命名 | 不一致，增加学习成本 | 否决 |

最终：`embedderJinaApiKey`、`embedderJinaBaseUrl`、`embedderJinaBatchSize`

### 2. JinaBaseUrl 默认值

| 选项 | 方案 | 结果 |
|------|------|------|
| ✅ **构造函数硬编码** + 可选参数覆盖 | `https://api.jina.ai/v1` 作为默认值，用户可配置 | 采用 |
| ❌ 必须由配置文件提供 | 对用户不友好，额外配置负担 | 否决 |

最终：`jina-embedder.ts` 中 `this.baseUrl = options?.jinaBaseUrl || 'https://api.jina.ai/v1'`

### 3. 修复策略范围

| 选项 | 方案 | 结果 |
|------|------|------|
| ✅ **全链路修复**：接口类型 → 校验 → 工厂 → 适配器 → 元数据 | 一次性解决所有问题 | 采用 |
| ❌ 仅修运行时错误 | 治标不治本，配置校验、元数据等仍不一致 | 否决 |

最终：修改 8 个文件，覆盖类型定义、校验、工厂创建、适配器转换、CLI 元数据全链路。

## 实施计划

- [x] **步骤 1**：诊断问题根源，识别所有缺失的配置项和代码分支
- [x] **步骤 2**：修改 `src/code-index/interfaces/config.ts` — 添加 `embedderJinaApiKey`、`embedderJinaBaseUrl`、`embedderJinaBatchSize`
- [x] **步骤 3**：修改 `src/code-index/service-factory.ts` — 添加 Jina 分支，创建 `JinaEmbedder` 实例
- [x] **步骤 4**：修改 `src/code-index/i18n.ts` — 添加 `jinaConfigMissing` 错误信息
- [x] **步骤 5**：修改 `src/code-index/config-manager.ts` — `isConfigured()` 添加 Jina 分支、重启检测添加 Jina 字段
- [x] **步骤 6**：修改 `src/code-index/config-validator.ts` — 修复 `embedderGeminiApiKey` → `embedderJinaApiKey` 的 bug
- [x] **步骤 7**：修改 `src/adapters/nodejs/config.ts` — `getEmbedderConfig()`、`isConfigured()`、`validateConfig()` 三处添加 Jina 支持
- [x] **步骤 8**：修改 `src/commands/config/metadata.ts` — 添加 Jina 配置项元数据
- [x] **步骤 9**：修改 `src/code-index/embedders/jina-embedder.ts` — 支持自定义 `jinaBaseUrl`
- [x] **步骤 10**：类型检查验证 + 实际运行验证

## 实施记录

### 2025-05-10

#### 问题诊断

1. 运行 `npx tsx src/cli.ts index --force --demo` 报错 `Cannot create services: Code indexing is not properly configured`
2. 追查发现 `config-manager.ts` (config-manager.CodeIndexConfigManager.isConfigured:143) 中没有 `jina` 分支，永远返回 `false`
3. 进一步发现 `service-factory.ts` (service-factory.CodeIndexServiceFactory.createEmbedder:57) 中也没有 `jina` 分支，直接走到最后的 `throw`
4. `CodeIndexConfig` 接口中缺少 `embedderJinaApiKey` 字段
5. `config-validator.ts` 中 Jina case 错误地检查了 `config.embedderGeminiApiKey` 而不是 `embedderJinaApiKey`

#### 修复过程

**文件 1：`src/code-index/interfaces/config.ts`**

- `CodeIndexConfig`：在 Embedder - Jina 特定参数区块添加 `embedderJinaApiKey`、`embedderJinaBaseUrl`、`embedderJinaBatchSize`
- `JinaEmbedderConfig`：添加 `baseUrl?: string` 字段
- `PreviousConfigSnapshot` 和 `ConfigSnapshot`：同步添加三个 Jina 字段

**文件 2：`src/code-index/service-factory.ts`**

- 导入 `JinaEmbedder`
- 在 `createEmbedder()` 的 `"openai-compatible"` 和 `"gemini"` 之间插入 `"jina"` 分支
- 读取 `embedderJinaApiKey`，传入 `JinaEmbedder` 构造函数的 `apiKey`、`modelId` 和 `options`

**文件 3：`src/code-index/i18n.ts`**

- 添加 `"embeddings:serviceFactory.jinaConfigMissing": "Jina API key missing for embedder creation"`

**文件 4：`src/code-index/config-manager.ts`**

- `isConfigured()`：添加上 `"jina"` 分支，检查 `embedderJinaApiKey` 和 `qdrantUrl`
- `_createConfigSnapshot()`：添加 `embedderJinaApiKey`、`embedderJinaBaseUrl`、`embedderJinaBatchSize`
- `doesConfigChangeRequireRestart()`：添加 `currentJinaBaseUrl` 读取和 `embedderJinaBaseUrl` 变更比较

**文件 5：`src/code-index/config-validator.ts`**

- 修复：`case 'jina'` 中 `config.embedderGeminiApiKey` → `config.embedderJinaApiKey`

**文件 6：`src/adapters/nodejs/config.ts`**

- `getEmbedderConfig()`：添加 `"jina"` 分支，返回 `provider`、`model`、`dimension`、`apiKey`、`baseUrl`
- `isConfigured()`：添加 `"jina"` 分支，检查 `embedderJinaApiKey` 和 `embedderModelId`
- `validateConfig()`：添加 `"jina"` case，验证 `embedderJinaApiKey`、`embedderModelId`、`embedderModelDimension`

**文件 7：`src/commands/config/metadata.ts`**

- 添加 `embedderJinaApiKey`（string）、`embedderJinaBaseUrl`（string）、`embedderJinaBatchSize`（integer, minValue: 1）元数据

**文件 8：`src/code-index/embedders/jina-embedder.ts`**

- 构造函数 `options` 参数扩展支持 `jinaBaseUrl?: string`
- `baseUrl` 赋值改为 `options?.jinaBaseUrl || 'https://api.jina.ai/v1'`

#### 验证

- ✅ 类型检查通过：`npm run type-check` 无错误
- ✅ 实际运行验证：`npx tsx src/cli.ts index --force --demo` 从"配置未就绪"错误 → 成功走到 Jina API 调用阶段（HTTP 403 余额不足，证明完整链路打通）

## 修订记录

（本任务首次实施，暂无修订）

## 总结

### 关键收获

1. **接口与实现分离的陷阱**：Jina provider 在 `EmbedderProvider` 类型和 `JinaEmbedder` 类层面得到了定义，但配置接口、校验器、服务工厂、适配器各层均未同步支持，导致"看起来支持、用起来报错"。
2. **全链路思维**：此类多 provider 架构中，添加新 provider 需要检查以下所有节点：
   - 类型定义（config interface、snapshot types）
   - 配置校验（validator）
   - 服务创建（factory）
   - 适配器转换（node adapter）
   - CLI 元数据（metadata）
   - 错误信息（i18n）
3. **代码复制粘贴 Bug**：`config-validator.ts` 中 Jina case 使用了 `embedderGeminiApiKey` 而非 `embedderJinaApiKey`——典型的 copy-paste 失误。

### 后续优化建议

- 添加 `jina-embeddings-v5-text-small` 到 `EMBEDDING_MODEL_PROFILES`（当前仅有 `v2-base-code`、`code-embeddings-0.5b/1.5b`、`v4`）
- 在 `config-validator.ts` 中添加 Jina baseUrl 的格式校验（可选）
- 考虑为各 provider 添加集成测试，避免类似遗漏
