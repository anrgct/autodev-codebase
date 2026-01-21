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
npm run test:e2e       # e2e 测试
```

## 测试调试规则

**铁律：调试测试时必须使用 `--silent=false`**

```bash
# ✅ 正确：第一次就加 --silent=false
npm run test -- path/to/test.ts --silent=false

# ❌ 错误：不加参数，看不到 console.log 输出
npm run test -- path/to/test.ts
```

**为什么：**
- vitest 默认静默模式会隐藏 `console.log` 输出
- 调试时需要看到测试内部的日志和数据
- 忘记加参数会浪费时间尝试其他调试方法

**什么时候用：**
- 任何需要查看测试输出的场景
- 添加了 `console.log` 调试语句
- 测试失败需要查看详细信息
- 验证测试行为是否符合预期

## 关键命令

**⚠️ 注意：从 v1.0.0 开始，CLI 使用子命令模式（类似 git/npm）**

```bash
# 代码搜索
codebase search "用户认证" --limit=20
codebase search "数据库" --path-filters="src/**/*.ts" --json
codebase search "认证" --log-level=info  # 显示详细日志

# 代码索引
codebase index                          # 一次性索引
codebase index --force                  # 强制重建索引
codebase index --dry-run                # 预览将要索引的文件
codebase index --watch                  # 监听模式
codebase index --serve --port=3001      # 启动 MCP HTTP 服务器
codebase index --clear-cache            # 清除索引缓存

# 代码大纲提取
codebase outline "src/**/*.ts"
codebase outline "src/**/*.ts" --summarize      # 生成 AI 摘要
codebase outline "src/**/*.ts" --dry-run        # 预览匹配的文件
codebase outline --clear-cache                  # 清除摘要缓存

# stdio 适配器
codebase stdio --server-url=http://localhost:3001/mcp

# 配置管理
codebase config --get                           # 查看所有配置层
codebase config --get embedderProvider          # 查看特定配置项
codebase config --set embedderProvider=ollama   # 设置项目配置
codebase config --set key=value --global        # 设置全局配置
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

## 任务文档命名规则

**文档位置**：`docs/plans` 目录

**命名规则**：`YYMMDD-<主题>.md`

- **YYMMDD**：6位日期前缀（YY=年，MM=月，DD=日）
- **主题**：描述性的英文名称，使用连字符分隔多个单词

**示例**：
- `260116-mcp-integration.md` - 2026年1月16日创建的MCP集成文档
- `260120-embedder-guide.md` - 2026年1月20日创建的嵌入器指南

**章节组织规则**：

所有说明文档应按照以下标准章节组织：

1. **主题/需求** - 明确说明文档要解决的问题或需要实现的功能
2. **代码背景** - 描述与问题相关的已有代码、代码结构和依赖关系
3. **关键决策** - 记录技术选型、设计方案等关键决策及理由
4. **实施计划** - 列出具体的实施步骤、时间线和资源需求（可选，复杂实施可单独文件）
5. **实施记录** - 记录实施过程中的具体操作、遇到的问题及解决方案
6. **修订记录** - 记录计划和实施后的修复、调整、bug修复和优化工作（简洁包括修改日期、问题描述、实施记录）
7. **总结** - 总结经验教训、后续优化建议和参考资源


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
