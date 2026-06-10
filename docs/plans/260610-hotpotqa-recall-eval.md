# 260610-hotpotqa-recall-eval

## 主题/需求

用 autodev-codebase 的检索能力评测 HotpotQA 数据集的 Recall@K，使用基础配置（无 reranker、无 highlighter），与 HippoRAG 的检索指标对齐。

配置基线：
- `embedderProvider: "llamacpp"` + Jina v5 nano GGUF
- `embedderPoolingMode: "late-chunking"`（仅对 `llamacpp-llm` 生效，`llamacpp` 用模型内置 pooling）
- `rerankerEnabled: false`, `highlighterEnabled: false`
- `hybridSearchEnabled: true`（BM25 + Dense）

## 代码背景

### 相关文件

| 文件 | 说明 |
|------|------|
| `scripts/hotpotqa-eval.ts` | 评测主脚本，用 Library API 索引 + 检索 + 算 Recall |
| `scripts/prepare-corpus.py` | 将 HippoRAG 格式的 HotpotQA 语料转成 .md 文件 |
| `src/code-index/search-service.ts` | 搜索服务，含 embedder dispose 逻辑 |
| `src/code-index/vector-store/sqlite-store.ts` | SQLite 向量存储，含 `buildFtsBm25Query` 混合搜索 |
| `src/code-index/manager.ts` | CodeIndexManager 单例管理和初始化 |

### HotpotQA 数据

- 语料：9811 篇文档，位于 `/Users/anrgct/workspace/HippoRAG/reproduce/dataset/hotpotqa_corpus.json`
- Query：1000 条，位于 `/Users/anrgct/workspace/HippoRAG/reproduce/dataset/hotpotqa.json`
- 每条 query 有 `supporting_facts` 和 `context` 标注 gold 文档

## 运行现象

### 首次运行报错

```
SyntaxError: The requested module '../src/utils/logger' does not provide an export named 'getLogger'
```

`getLogger` 不存在于 `utils/logger.ts`（实际 export 的是 `getGlobalLogger`）。

### 混合搜索 FTS5 崩溃

```
SqliteError: fts5: syntax error near "?"
SqliteError: fts5: syntax error near ","
SqliteError: fts5: syntax error near "'"
SqliteError: fts5: syntax error near "."
SqliteError: fts5: syntax error near "#"
SqliteError: fts5: syntax error near "@"
SqliteError: fts5: syntax error near "/"
```

`buildFtsBm25Query` 只对 `FTS5_RESERVED = /["*():^\-+]/` 中的字符做 quote，但 `?`, `,`, `'`, `.`, `#`, `@`, `/` 等常见标点没有被处理，导致 FTS5 解析报错。

### 单个 query 失败后全局锁死

搜索错误后将 state 设为 "Error"，后续 query 全部收到 `"Code index is not ready for search. Current state: Error"`。

### 每次 search 都重载 embedder 模型

```
INFO  [Eval] LlamaCPP model loaded, context size: 8192 tokens
```

同一行日志在 90 个 query 里出现了 89 次，每次 search 都会 `embedder.dispose()` 并后续自动重载。

## 归因分析

1. **logger export 缺失**：`commands/shared.ts` 有 `getLogger()` 包装函数，但 `utils/logger.ts` 导出的是 `getGlobalLogger()`。
2. **FTS5 字符处理**：FTS5 对 bareword 中不能包含标点符号，`buildFtsBm25Query` 的保留字符列表不全导致大量 query 失败。
3. **State 污染**：`CodeIndexSearchService.searchIndex` 在错误时统一设置 state="Error"，对批量评测场景不友好。
4. **Embedder 释放策略**：搜索服务在每次查询后无条件下 dispose embedder，意图是给 reranker/highlighter 腾 GPU 显存，但基础配置下没有这两个组件。

## 关键决策

1. **使用 Library API 而非 CLI**：避免每次 `codebase search` 都重启进程，一次加载模型跑全部 query。
2. **白名单替代黑名单**：FTS5 bareword 改用 `^[a-zA-Z0-9_]+$` 白名单，所有含非字母数字字符的 token 一律 quote，一劳永逸解决标点问题。
3. **有条件 dispose**：只在有 reranker 或 highlighter 时才释放 embedder，基础配置下持久保留。
4. **状态恢复**：单条 query 失败后 catch 异常并恢复 state="Indexed"，继续处理后续 query。
5. **`.md` 文件不加 `#` 标题**：利用 `CodeParser.parseMarkdownContent` 在无 header 时把整个文件当单一 section 处理的特性，每个文档作为一个索引块。

## 实施计划

- [x] 编写 `scripts/prepare-corpus.py` 数据准备脚本
- [x] 编写 `scripts/hotpotqa-eval.ts` 评测主脚本
- [x] 修复 logger import 问题
- [x] 修复 FTS5 特殊字符崩溃
- [x] 修复 embedder 每 query 重载问题
- [x] 修复单 query 失败后全局锁死
- [x] 首次全量评测（1000 query 全部通过）
- [x] 修正配置显示（llamacpp GGUF 文件名、llamacpp-llm GGUF 文件名）

## 实施记录

### 2026-06-10

- 创建 `scripts/prepare-corpus.py`：将 HotpotQA corpus JSON 转为 `.md` 文件，不加标题头
- 创建 `scripts/hotpotqa-eval.ts`：使用 `createNodeDependencies` + `CodeIndexManager` 做索引和批量检索
- 首次运行失败：`getLogger` 不存在 → 改为 `getGlobalLogger`
- 索引成功，但第一个 search 就报 FTS5 error
- 添加 `?` 到 `FTS5_RESERVED` → 测试发现还有 `,` `.` `#` `@` `/` `>` `'` 等问题
- 改用白名单策略 `FTS5_BAREWORD_SAFE = /^[a-zA-Z0-9_]+$/`，所有非字母数字 token 全部 quote
- 发现 embedder 每 query 重载（89次/90 queries）
- 分析 search-service.ts：`embedder.dispose()` 无条件调用 → 改为仅在有 reranker/highlighter 时 dispose
- 单个 query 失败后 state="Error" 导致后续全部失败 → 添加 catch + state 恢复逻辑
- 第一次完整跑完：1000/1000 成功，0 失败，Recall@1=41.10%
- 配置显示 `unknown` → 修复 `await getConfig()`

## 修订记录

### 2026-06-10
**问题：** FTS5 对 `?`, `,`, `'`, `.`, `#`, `@`, `/`, `>` 等标点报语法错误
**修复：** `src/code-index/vector-store/sqlite-store.ts` 将 `FTS5_RESERVED` 黑名单替换为 `FTS5_BAREWORD_SAFE = /^[a-zA-Z0-9_]+$/` 白名单

**问题：** 每次 search 都重载 embedder 模型，性能极差
**修复：** `src/code-index/search-service.ts` 只在有 reranker 或 highlighter 时 `embedder.dispose()`

## 总结

### 最终结果

```
配置: llamacpp / v5-nano-retrieval-Q8_0-pooling-LAST
Pooling: model-builtin, 混合搜索: true
Query 数: 1000

Recall@1    = 41.10%
Recall@2    = 62.75%
Recall@5    = 83.75%
Recall@10   = 91.10%
Recall@20   = 93.85%
Recall@50   = 95.95% (此后停滞)
```

### 使用命令

```bash
# 1. 数据准备：将 HotpotQA 语料转为 .md 文件
python scripts/prepare-corpus.py \
    --corpus /path/to/hipporag/reproduce/dataset/hotpotqa_corpus.json \
    --out /tmp/hotpotqa-corpus

# 2. 运行评测（索引 + 检索 + 算 Recall）
npx tsx scripts/hotpotqa-eval.ts \
    --corpus-dir /tmp/hotpotqa-corpus \
    --queries /path/to/hipporag/reproduce/dataset/hotpotqa.json \
    --config autodev-config.json \
    --k-list 1,2,5,10,20,50,100,150,200 \
    --log-level info
```

### 关键收获

1. **autodev-codebase 可作为通用检索系统的评估工具**：只需将语料转成 `.md` 文件即可索引和检索，不需要任何代码解析能力。
2. **混合搜索的 BM25 (FTS5) 对标点敏感**：需要 quote 所有非字母数字 token。
3. **embedder dispose 策略需要感知组件状态**：无 reranker/highlighter 时应保留 embedder。
4. **基础配置 Recall@10=91.10% 对 HotpotQA 是合理的 baseline**，后续加 reranker 应有进一步提升空间。
