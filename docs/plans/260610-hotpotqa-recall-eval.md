# 260610-hotpotqa-recall-eval

## 主题/需求

用 autodev-codebase 的检索能力评测多数据集 Recall@K，使用基础配置（无 reranker、无 highlighter），与 HippoRAG 的检索指标对齐。

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
| `scripts/prepare-corpus.py` | 将 HippoRAG 格式的语料转成 .md 文件 |
| `src/code-index/search-service.ts` | 搜索服务，含 embedder dispose 逻辑 |
| `src/code-index/vector-store/sqlite-store.ts` | SQLite 向量存储，含 `buildFtsBm25Query` 混合搜索 |
| `src/code-index/manager.ts` | CodeIndexManager 单例管理和初始化 |

### 数据格式

#### HotpotQA / 2WikiMultihopQA

格式一致，位于 HippoRAG `reproduce/dataset/` 目录：

- 语料：`hotpotqa_corpus.json` / `2wikimultihopqa_corpus.json`，格式 `[{title, text, idx}]`
- Query：`hotpotqa.json` / `2wikimultihopqa.json`，格式 `[{_id, question, answer, supporting_facts: [[title, sent_idx]], context: [[title, [sentences]]]}]`

#### Musique

- 语料：`musique_corpus.json`，格式 `[{title, text}]`（无 `idx` 字段）
- Query：`musique.json`，格式 `[{id, question, answer, paragraphs: [{title, paragraph_text, is_supporting}]}]`（使用 `paragraphs[].is_supporting` 替代 `supporting_facts`）

#### 数据集统计

| 数据集 | 语料文档数 | 平均 gold/query | 最大 gold/query | Query 数 |
|--------|-----------|----------------|----------------|---------|
| HotpotQA | 9,811 | 2.00 | 2 | 1,000 |
| 2WikiMultihopQA | 6,119 | 2.47 | 4 | 1,000 |
| Musique | 11,656 | 2.60 | 4 | 1,000 |

#### 格式差异处理

脚本 `scripts/hotpotqa-eval.ts` 自动检测 query 格式：
- 如果含 `paragraphs` 字段 → Musique 格式，从 `is_supporting` 提取 gold 文档
- 如果含 `supporting_facts` 字段 → HotpotQA/2WikiMultihopQA 格式，从 `supporting_facts` + `context` 提取
- `_id` / `id` 字段自动兼容

脚本 `scripts/prepare-corpus.py` 修复了 `idx` 字段可选，兼容 Musique corpus 无 `idx` 的情况。

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
6. **自动检测 query 格式**：支持 HotpotQA / 2WikiMultihopQA / Musique 三种数据集，无需手动切换脚本。

## 实施计划

- [x] 编写 `scripts/prepare-corpus.py` 数据准备脚本
- [x] 编写 `scripts/hotpotqa-eval.ts` 评测主脚本
- [x] 修复 logger import 问题
- [x] 修复 FTS5 特殊字符崩溃
- [x] 修复 embedder 每 query 重载问题
- [x] 修复单 query 失败后全局锁死
- [x] HotpotQA 首次全量评测（1000 query 全部通过）
- [x] 修正配置显示（llamacpp GGUF 文件名、llamacpp-llm GGUF 文件名）
- [x] Musique 格式兼容 + 评测
- [x] 2WikiMultihopQA 评测
- [x] `prepare-corpus.py` 兼容无 `idx` 字段的 corpus 格式
- [x] 更新文档汇总三数据集对比结果

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
- 扩展 `scripts/hotpotqa-eval.ts` 支持 Musique 格式（auto-detect `paragraphs` 字段）
  - 新增 `MusiqueQuery` 接口、`getQueryId()`、`extractGoldTitles()` 自动分支
- 修复 `scripts/prepare-corpus.py` 中 `idx` 字段为可选，兼容 Musique corpus（无 `idx`）
- Musique 评测完成：R@1=26.95%（1000 queries, 0 失败）
- 2WikiMultihopQA 评测完成：R@1=39.05%（1000 queries, 0 失败）

## 修订记录

### 2026-06-10
**问题：** FTS5 对 `?`, `,`, `'`, `.`, `#`, `@`, `/`, `>` 等标点报语法错误
**修复：** `src/code-index/vector-store/sqlite-store.ts` 将 `FTS5_RESERVED` 黑名单替换为 `FTS5_BAREWORD_SAFE = /^[a-zA-Z0-9_]+$/` 白名单

**问题：** 每次 search 都重载 embedder 模型，性能极差
**修复：** `src/code-index/search-service.ts` 只在有 reranker 或 highlighter 时 `embedder.dispose()`

**问题：** Musique corpus 无 `idx` 字段导致 `prepare-corpus.py` 崩溃
**修复：** `scripts/prepare-corpus.py` 将 `doc["idx"]` 改为 `doc.get("idx")`

**问题：** HotpotQA eval 脚本不支持 Musique 格式（`paragraphs` vs `supporting_facts`）
**修复：** `scripts/hotpotqa-eval.ts` 自动检测 `paragraphs` 字段并切换提取逻辑

## 总结

### 最终结果

```
配置: llamacpp / v5-nano-retrieval-Q8_0-pooling-LAST
Pooling: model-builtin, 混合搜索: true
Query 数: 1000 (各数据集)
```

| Recall@K | **HotpotQA** | **2WikiMultihopQA** | **Musique** |
|:---------|:-----------|:-------------------|:----------|
| 1        | **41.10%** | **39.05%** | **26.95%** |
| 2        | **62.75%** | **57.35%** | **38.97%** |
| 5        | **83.75%** | **66.88%** | **54.12%** |
| 10       | **91.10%** | **70.78%** | **63.81%** |
| 20       | **93.85%** | **73.38%** | **73.38%** |
| 50       | **95.95%** | **77.60%** | **83.64%** |
| 100+     | —          | 77.60% (停滞)    | 83.64% (停滞) |

#### 额外观察

- 2WikiMultihopQA 有 **461/1000** query 在 top-200 内无法召回全部 gold 文档
- Musique 和 2WikiMultihopQA 的 R@50 后几乎停滞，说明约 16-22% 的 gold 文档完全不在 top-200 检索结果中
- HotpotQA 在 R@50 即接近饱和（95.95%），是三个数据集中检索难度最低的

### 使用命令

```bash
# 1. 数据准备
python scripts/prepare-corpus.py \
    --corpus /path/to/hipporag/reproduce/dataset/hotpotqa_corpus.json \
    --out /tmp/hotpotqa-corpus

python scripts/prepare-corpus.py \
    --corpus /path/to/hipporag/reproduce/dataset/musique_corpus.json \
    --out /tmp/musique-corpus

python scripts/prepare-corpus.py \
    --corpus /path/to/hipporag/reproduce/dataset/2wikimultihopqa_corpus.json \
    --out /tmp/2wikimultihopqa-corpus

# 2. 运行评测（自动检测数据集格式）
npx tsx scripts/hotpotqa-eval.ts \
    --corpus-dir /tmp/hotpotqa-corpus \
    --queries /path/to/hipporag/reproduce/dataset/hotpotqa.json \
    --config autodev-config.json \
    --k-list 1,2,5,10,20,50,100,150,200 \
    --log-level info

npx tsx scripts/hotpotqa-eval.ts \
    --corpus-dir /tmp/musique-corpus \
    --queries /path/to/hipporag/reproduce/dataset/musique.json \
    --config autodev-config.json \
    --k-list 1,2,5,10,20,50,100,150,200 \
    --log-level info

npx tsx scripts/hotpotqa-eval.ts \
    --corpus-dir /tmp/2wikimultihopqa-corpus \
    --queries /path/to/hipporag/reproduce/dataset/2wikimultihopqa.json \
    --config autodev-config.json \
    --k-list 1,2,5,10,20,50,100,150,200 \
    --log-level info
```

### 关键收获

1. **autodev-codebase 可作为通用检索系统的评估工具**：只需将语料转成 `.md` 文件即可索引和检索，不需要任何代码解析能力。
2. **混合搜索的 BM25 (FTS5) 对标点敏感**：需要 quote 所有非字母数字 token。
3. **embedder dispose 策略需要感知组件状态**：无 reranker/highlighter 时应保留 embedder。
4. **不同数据集的检索难度差异显著**：基础配置下 HotpotQA（R@10=91.10%）远易于 Musique（R@10=63.81%）和 2WikiMultihopQA（R@10=70.78%）。
5. **评测脚本一次编写、多数据集通用**：通过自动检测 query 格式，`hotpotqa-eval.ts` 可以无需修改地跑 HotpotQA、2WikiMultihopQA、Musique 三种数据集。
