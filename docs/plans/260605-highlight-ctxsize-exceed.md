# 260605-highlight-ctxsize-exceed

## 主题/需求

`codebase highlight` 命令对较大的文件返回 "No highlight results"，缺少高亮结果。

## 代码背景

- **命令入口**：`src/commands/highlight.ts` → `highlightHandler()`
- **高亮器**：`src/code-index/highlighters/semantic-highlight.ts` (`SemanticHighlightHighlighter`)
- **调用链**：`highlightHandler` → `manager.highlight()` → `searchService.highlight()` → `highlighter.highlight()`
- **配置**：`highlighterProvider: "semantic-highlight"`，模型为 `semantic-highlight-bilingual-v1-Q8_0-unified.gguf`

## 运行现象

复现命令：

```bash
npm run dev -- highlight "高度概括代码" src/code-index/embedders/llamacpp-llm.ts --topk=20 --log-level=debug
```

输出：

```
WARN  [CLI] Failed to highlight ...llamacpp-llm.ts: Input is longer than the context size.
      Try to increase the context size or use another model that supports longer contexts.
No highlight results for query: "高度概括代码"
```

## 归因分析

两个根因：

1. **模型 context window 不足**：`bert.context_length = 8192` tokens，目标文件 `llamacpp-llm.ts` 为 36,584 bytes（约 9000+ tokens），输入构造为 `[Query] ${query} [Code] ${codeChunk}` 后超出 context 限制。

2. **`SemanticHighlightHighlighter.highlight()` 无自动分块**：直接将整个文件内容一次性传入 `getEmbeddingsForTokens(input)`，没有对大文件做 context-aware 的分片处理。

错误在 `highlight.ts` 中被 catch 后仅记录 warn，`results` 数组为空，最终输出 "No highlight results"。

## 关键决策

（暂未决策——仅记录问题）

> ⚠️ 此问题仅在使用 `highlighterProvider=semantic-highlight` 时发现并验证。`semantic-highlight-bilingual-v1-Q8_0-unified.gguf` 是一个 XLM-RoBERTa 架构的模型，context_length=8192，且 `SemanticHighlightHighlighter` 做的是全量 forward pass（对每个 token 计算 PruningHead keep prob），入参为完整文件内容。
>
> 其他 highlighter（`qrranker`、`llamacpp-llm`）是否也有类似 context 限制问题，未验证。

## 实施计划

（暂未实施计划——仅记录问题）

## 实施记录

### 2026-06-05
- 定位问题：模型 context_size=8192，目标文件 ~36KB 超出限制
- `llamacpp-llm.ts` 是 embedder 实现文件，约 900+ 行、36KB
- 如果用 `highlighterTopK=10` 本来只保留 10 行，但模型根本无法处理完整输入

## 修订记录

### 2026-06-05
**问题：** 首次记录时未明确说明此问题仅发生在 `semantic-highlight` provider 上
**修复：** 在关键决策章节补充 provider 对比说明

## 总结

当前 `SemanticHighlightHighlighter` 对大文件无分块机制。若要支持任意大小文件，需要实现类似 `LlamaCppLlmEmbedder._lateChunkingCreateEmbeddings` 的 context-aware 分片逻辑，对长输入按 context window 切分子批次。
