# CLAUDE.md

## 项目概述

基于向量嵌入的代码语义搜索工具，支持 MCP (Model Context Protocol) 服务器集成。

**核心功能：**
- 多嵌入提供商支持（Ollama、OpenAI、Jina、OpenAI-Compatible 等）
- MCP HTTP 服务器（http-streamable/stdio 支持）
- LLM 重排序
- 代码结构大纲提取（带 AI 摘要）
- 40+ 语言的 Tree-sitter 解析
- Qdrant 向量数据库后端

## 项目结构

```
src/
├── cli.ts              # CLI 入口
├── index.ts            # 库主导出
├── abstractions/       # 核心接口定义
├── adapters/nodejs/    # Node.js 平台适配
├── cli-tools/          # CLI 工具（outline, search 等）
├── config/             # 配置管理
├── glob/               # 文件匹配
├── mcp/                # MCP 服务器
├── search/             # 搜索服务
├── tree-sitter/        # 代码解析
└── lib/                # 核心库逻辑
```

## 核心 API

**CodeIndexManager** (`src/search/manager.ts`) - 库的主入口：

```typescript
import { CodeIndexManager, createNodeDependencies } from './src/index.ts';

const deps = createNodeDependencies();
const manager = CodeIndexManager.getInstance(deps);
await manager.initialize();
await manager.startIndexing();
const results = await manager.searchIndex(query, { limit: 20 });
```

## 重要原则

1. **依赖注入** - 通过构造函数注入依赖
2. **接口优先** - 使用 I* 前缀的接口
3. **平台无关** - 核心库不直接导入平台模块
4. **配置优先级** - CLI > 项目配置 > 全局配置 > 默认值

## 构建与运行

```bash
npm run build          # 构建
npm run type-check     # 类型检查
npm run dev            # 用 demo 目录的开发模式
npm run mcp-server     # 启动 MCP 服务器（端口 3001）
npm run test           # vitest 单元测试
npm run test -- --silent=false  # vitest 测试（显示详细输出）
npm run test:e2e       # e2e 测试
```

## 关键命令

```bash
# 索引代码库
codebase --index --path=. --force

# 语义搜索
codebase --search="用户认证" --limit=20
codebase --search="数据库" --path-filters="src/**/*.ts" --json
codebase --search="认证" --log-level=info  # 显示详细日志

# 提取代码大纲
codebase --outline "src/**/*.ts"

# 生成带 AI 摘要的代码大纲
codebase --outline "src/**/*.ts" --summarize

# 预览 outline 操作
codebase --outline "src/**/*.ts" --dry-run

# 清除摘要缓存
codebase --outline "src/**/*.ts" --clear-summarize-cache

# 启动 MCP HTTP 服务器
codebase --serve --port=3001 --path=.

# 启动 stdio 适配器
codebase --stdio-adapter --server-url=http://localhost:3001/mcp
```

## MCP 工具

### search_codebase - 语义搜索

```json
{
  "query": "用户认证逻辑",
  "limit": 20,
  "filters": {
    "pathFilters": ["src/**/*.ts"],
    "minScore": 0.3
  }
}
```

## 配置位置

- **项目配置**：`./autodev-config.json`
- **全局配置**：`~/.autodev-cache/autodev-config.json`

---

## 代码库开发通用经验

### 主控与子代理的分工

- **主控**：制定验收标准、把控流程、协调子代理、不写代码
- **子代理**：根据设计文档编写代码
- **关键**：主控必须明确指定设计文档路径，子代理不知道它在哪里

### 设计文档驱动的开发

1. **先有设计，再有代码** - 设计文档是唯一真相来源
2. **验收测试先行** - 在开发前先写好验收测试
3. **设计文档路径显式传递** - 每次调用子代理都要明确告诉它

### 数据模型变更的影响

修改核心模型会产生连锁反应，建议：
- 先用子代理批量修改所有依赖文件
- 再统一测试

### 多语言解析器的架构模式

```typescript
class LanguageAnalyzer extends BaseAnalyzer {
  getNodeTypes(): NodeTypes      // 配置节点类型
  extractFunctionName(node): string | null
  extractClassName(node): string | null
  extractCallName(node): string | null
  extractImports(root): void
}
```

### 验收测试的价值

- 快速验证每次修改
- 暴露接口不匹配
- 展示 API 正确使用方式



<skills_system priority="1">

## Available Skills

<!-- SKILLS_TABLE_START -->
<usage>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills:
- Invoke: Bash("openskills read <skill-name>")
- The skill content will load with detailed instructions on how to complete the task
- Base directory provided in output for resolving bundled resources (references/, scripts/, assets/)

Usage notes:
- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already loaded in your context
- Each skill invocation is stateless
</usage>

<available_skills>

<skill>
<name>chatting-ai-skill</name>
<description>与本地AI助手（codex/claude code）交互式对话，自动管理多轮对话状态。当你需要分析代码、重构优化、编写新功能、调试问题或技术咨询时使用。支持多种输入方式（直接输入、Here document、文件、管道）。</description>
<location>project</location>
</skill>

<skill>
<name>create-agent-skills</name>
<description>Expert guidance for creating, writing, and refining Claude Code Skills. Use when working with SKILL.md files, authoring new skills, improving existing skills, or understanding skill structure and best practices.</description>
<location>project</location>
</skill>

<skill>
<name>planning-with-files</name>
<description>Transforms workflow to use Manus-style persistent markdown files for planning, progress tracking, and knowledge storage. Use when starting complex tasks, multi-step projects, research tasks, or when the user mentions planning, organizing work, tracking progress, or wants structured output.</description>
<location>project</location>
</skill>

<skill>
<name>searching-codebase-skill</name>
<description>基于向量嵌入的代码库语义搜索与大纲提取工具。当你需要快速定位代码功能、理解代码结构、进行代码审查或重构分析时使用。支持智能语义搜索（理解代码意图）和代码结构分析（AI摘要）。</description>
<location>project</location>
</skill>

</available_skills>
<!-- SKILLS_TABLE_END -->

</skills_system>
