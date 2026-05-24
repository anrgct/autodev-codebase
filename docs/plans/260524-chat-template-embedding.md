# 260524-chat-template-embedding

## 主题/需求

在 `llamacpp-llm` embedder 中增加聊天模板（Chat Template）支持——将文档/查询文本包装为 MiniCPM 的 ChatML 格式后再送入 `getEmbeddingsForTokens`，利用模型的 instruct-tuned 语义空间提升 embedding 质量。

**背景：**

- 实验 #4（`docs/plans/260523-late-chunking.md`）曾测试聊天模板，结论是"hidden state 提取不响应 chat format"
- 但该实验是在 **旧配置** 下做的：`last-token` pooling + L23（最后一层提取）
- 当前最优配置已变为：`mean` pooling + L22（非对称层：index L22, query L23）
- L22 在 `lm_head` 对齐之前，聊天模板的结构信息可能尚未被"吞没"；mean pooling 汇聚全部位置，聊天模板的格式 token 也会参与
- 因此聊天模板的效果**需要重新评估**

**预期成果：**
- `embedderUseChatTemplate` 配置项，默认 `false`
- `LlamaCppLlmEmbedder` 在启用时，将文本包装为 `<|im_start|>user\n{text}<|im_end|>` 后再调用 `getEmbeddingsForTokens`
- 文档端和查询端**对称使用**同一模板

**验证方式：**
- `tsc --noEmit` 类型检查通过
- 单元测试通过
- `npx tsx src/cli.ts index --force --demo` 端到端成功
- `python src/examples/eval_search.py` 对比开关前后的检索质量

## 代码背景

### 关键文件

| 文件 | 用途 |
|------|------|
| `src/code-index/embedders/llamacpp-llm.ts` | 核心：构造函数加 `useChatTemplate` 参数 + `_wrapInChatTemplate()` 方法 |
| `src/code-index/interfaces/config.ts` | `CodeIndexConfig` / `PreviousConfigSnapshot` / `ConfigSnapshot` 加 `embedderUseChatTemplate` |
| `src/code-index/constants/index.ts` | `DEFAULT_CONFIG` 默认 `false` |
| `src/code-index/config-manager.ts` | `REQUIRES_RESTART_KEYS` + snapshot + change detection |
| `src/code-index/config-validator.ts` | boolean 校验 |
| `src/commands/config/metadata.ts` | 元数据条目 |
| `src/code-index/service-factory.ts` | `createEmbedder()` / `createQueryEmbedder()` 参数透传 |
| `demo/autodev-config.json` | 配置项 |

### 当前 `getEmbeddingsForTokens` 的 token 流

```
输入文本 "hello"
  → tokenizeInput() → [token(hello)]
  → resolveBeginningTokenToPrepend() → BOS
  → resolveEndTokenToAppend() → EOS
  → evaluate([BOS, token(hello), EOS])
```

包装聊天模板后：

```
输入文本 "<|im_start|>user\nhello<|im_end|>"
  → tokenizeInput() → [token(<|im_start|>), token(user), token(\n), token(hello), token(<|im_end|>)]
  → BOS/EOS 检查：首 token ≠ BOS → 加 BOS；末 token ≠ EOS → 加 EOS
  → evaluate([BOS, <|im_start|>, user, \n, hello, <|im_end|>, EOS])
```

外层 BOS/EOS 无法通过 `getEmbeddingsForTokens` API 跳过，但这不是问题——训练时对话序列开头就有 BOS。

### MiniCPM ChatML 格式

```
<|im_start|>user
{text}<|im_end|>
<|im_start|>assistant

```

完整的 instruct 对话格式——这是 MiniCPM 训练时的标准输入分布。BOS 由 `getEmbeddingsForTokens` 自动添加。

## 关键决策

### 决策 1：文档和查询使用对称模板

**选择：** 文档（代码块）和查询都用相同的 `user` 角色模板。

**理由：**
- 对称的语义空间更利于 cosine similarity 匹配
- MiniCPM 的 instruct tuning 使 `user` 角色的 hidden states 更适合"理解输入"
- 文档端的代码本质上是"用户提供的上下文"，用 `user` 角色合理

### 决策 2：使用完整的 instruct 格式（含 assistant 前缀）

**选择：** 模板以 `<|im_start|>user\n{text}<|im_end|>\n<|im_start|>assistant\n` 完整格式。

**理由：**
- MiniCPM 在 instruct tuning 阶段用完整 ChatML 格式训练，模型期望看到 role 切换
- `<|im_start|>assistant\n` 前缀让模型进入"准备理解并回复"的状态，此时 hidden states 对输入语义最敏感
- 早期实验 #4 虽然报告"不响应 chat format"，但省略 assistant 前缀可能正是原因之一——不完整的模板反而让 hidden states 处于未定义状态
- 简洁模板（仅 user）下模型可能处于"消息未完成"状态，hidden states 编码的是"等待下一条消息"而非"理解当前内容"

### 决策 3：配置项命名 `embedderUseChatTemplate`，默认 `false`

与现有 `embedderLlmInstructionPrefix` 区分——前者是简单文本前缀，后者是完整的 ChatML 结构化包装。两者互斥：如果同时启用，聊天模板优先生效。

### 决策 4：聊天模板在 `createEmbeddings()` 入口统一套用

**选择：** 在 `createEmbeddings()` 方法中，对所有 pooling 模式统一套用聊天模板包装，而不是在每个 `_xxxCreateEmbeddings()` 内部各自处理。

**理由：**
- 一处修改，所有 pooling 模式（last-token / mean / qr-weighted / late-chunking）自动受益
- late-chunking 的拼接逻辑不受影响——模板在每个 chunk 级别包装，拼接前已完成
- 代码改动最小

## 实施计划

- [ ] 步骤 1：类型系统 & 接口层
  - `CodeIndexConfig` / `PreviousConfigSnapshot` / `ConfigSnapshot` 加 `embedderUseChatTemplate`
  - `DEFAULT_CONFIG` 默认 `false`

- [ ] 步骤 2：`LlamaCppLlmEmbedder` 核心实现
  - 构造函数加 `useChatTemplate` 参数
  - 添加 `_wrapInChatTemplate(text: string): string` 私有方法
  - `createEmbeddings()` 中套用包装

- [ ] 步骤 3：配置层适配
  - `config-manager.ts`：`REQUIRES_RESTART_KEYS` + snapshot + change detection
  - `config-validator.ts`：boolean 校验
  - `metadata.ts`：元数据条目

- [ ] 步骤 4：服务工厂 & Demo 配置
  - `service-factory.ts`：`createEmbedder()` / `createQueryEmbedder()` 参数透传
  - `demo/autodev-config.json`：添加配置项

- [ ] 步骤 5：类型检查 & 单元测试
  - `tsc --noEmit`
  - `npm run test`

- [ ] 步骤 6：端到端评估
  - `npx tsx src/cli.ts index --force --demo`
  - `python src/examples/eval_search.py` 对比 `embedderUseChatTemplate: false` vs `true`

## 实施记录

### 2026-05-24

**改动范围**：7 文件，+64 / -5 行。

**接口层（1）**
- `CodeIndexConfig` / `PreviousConfigSnapshot` / `ConfigSnapshot` 新增 `embedderUseChatTemplate`

**核心算法（1）**
- `LlamaCppLlmEmbedder`：构造函数加 `useChatTemplate` 参数；新增 `_wrapInChatTemplate()` 将文本包装为 `<|im_start|>user\n{text}<|im_end|>\n<|im_start|>assistant\n`；`createEmbeddings()` 入口统一套用模板

**配置层（4）**
- `constants`：默认 `false`
- `config-manager`：`REQUIRES_RESTART_KEYS` + snapshot + change detection（顺便修复了 `embedderLlmInstructionPrefix` 在 snapshot 中缺失的 bug）
- `config-validator`：boolean 类型校验（顺便补了 `embedderLlmInstructionPrefix` 的类型校验）
- `metadata`：配置项描述

**服务层（1）**
- `service-factory`：`createEmbedder()` / `createQueryEmbedder()` 参数透传

**Demo（1）**
- `demo/autodev-config.json`：注释行添加配置项

### 验证

| 验证项 | 结果 |
|--------|------|
| `tsc --noEmit` | 零新增错误（2 个预存 QR_TEMPERATURE TS4111） |
| 单元测试 (115 files) | 全部通过（1045 passed, 7 skipped） |

## 修订记录

### 2026-05-24

**完整实验矩阵：**

| # | 配置 | 命中 | MRR | R@1 | 中位数排名 | 分数范围 |
|:---:|------|:---:|:---:|:---:|:---:|:---:|
| B0 | 无聊天模板（基线，mean+L22/L23） | **9/12** | **0.5486** | **41.7%** | **#1** | 0.10-0.26 |
| T1 | 聊天模板 + BOS/EOS | 4/12 | 0.0757 | 0% | #24 | 0.22-0.39 |
| T2 | 聊天模板 **无** BOS/EOS | 4/12 | 0.0757 | 0% | #24 | 0.22-0.39 |

**实验结论：**

1. **聊天模板对 MiniCPM-V-4.6 有害。** 命中从 9/12 暴跌到 4/12（-56%），MRR 从 0.55 崩溃到 0.08（-86%），R@1 从 41.7% 归零。

2. **BOS/EOS 不是问题根因。** T1 和 T2 结果逐行完全一致（相同命中列表、分数、排名），证实外层 BOS/EOS 不影响 embedding 质量。问题在于聊天模板的结构 token。

3. **实际文本格式**（debug log 验证）：
   - 文档端：`<|im_start|>user\nFile: model.py\nName: [function_definition]predict\nParent: [class_definition]Model\n\n{code}<|im_end|>\n<|im_start|>assistant\n`
   - 查询端：`<|im_start|>user\n保存模型时的额外信息<|im_end|>\n<|im_start|>assistant\n`
   - 文档端带有 `generateBlockEmbeddingText()` 添加的 `File:`/`Name:`/`Parent:` 元数据前缀，构成双重标注

**原因分析：**
- 聊天模板的结构 token（`<|im_start|>`、`<|im_end|>`、`user`、`assistant`）参与 mean pooling
- 每个 embedding 都包含相同的模板结构信号，所有向量被推向超球面同一区域
- 分数整体抬升（0.10→0.22+）但排序崩溃——这是 DC 偏移效应的不同表现

**根本原因：** MiniCPM-V-4.6 是通用 VLM，hidden states 不响应 chat format。专用 embedding 模型（Qwen3-Embedding、jina-v5）才可能从任务格式中获益。

## 总结

**聊天模板对 MiniCPM-V-4.6 不可用。** 完整实验矩阵：

| # | 配置 | 命中 | MRR | R@1 |
|:---:|------|:---:|:---:|:---:|
| B0 | 无聊天模板 | **9/12** | **0.5486** | **41.7%** |
| T1 | 聊天模板 + BOS/EOS | 4/12 | 0.0757 | 0% |
| T2 | 聊天模板 - BOS/EOS | 4/12 | 0.0757 | 0% |

**核心发现：**
1. 聊天模板命中 -56%、MRR -86%、R@1 归零——结构 token 在 mean pooling 中成为固定噪声
2. BOS/EOS 去留无影响（T1=T2 逐行一致），证实问题在模板内部而非边界标记
3. debug log 确认文档端有 `File:`/`Name:`/`Parent:` 元数据 + 聊天模板的双重标注，`_wrapInChatTemplate` 会每实例首次打 log

**代码最终状态：**
- `embedderUseChatTemplate`：类型 + 配置 + 构造 + 服务工厂全链路，默认 `false`
- `_wrapInChatTemplate()`：完整 ChatML 格式（`<|im_start|>user\n{text}<|im_end|>\n<|im_start|>assistant\n`），带首次 debug log
- `createEmbeddings()` 入口统一套用，所有 pooling 模式自动受益
- vendor `skipBoundaryTokens` hack：已撤销，BOS/EOS 保持原生行为

**下一步：** 不换模型的前提下探索空间基本穷尽。后续突破点：换用专用 embedding 模型（Qwen3-Embedding GGUF via llamacpp-llm）或开启 hybrid search + reranker。
