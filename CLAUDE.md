# CLAUDE.md

## 项目概述

基于向量嵌入的代码语义搜索工具，支持 MCP (Model Context Protocol) 服务器集成。

**核心功能：**
- 多嵌入提供商支持（Ollama、OpenAI、Jina、OpenAI-Compatible 等）
- MCP HTTP 服务器（http-streamable/stdio 支持）
- LLM 重排序
- 代码结构大纲提取（带 AI 摘要）
- 函数调用图分析（依赖追踪、路径分析）
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
├── commands/           # 命令实现（call, outline 等）
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
codebase outline "src/**/*.ts"                                      # 单个 glob 模式
codebase outline "src/cli.ts,src/index.ts"                          # 逗号分隔多个文件
codebase outline "src/**/*.ts,lib/**/*.js,!**/*.test.ts"            # 混合 glob 和排除模式
codebase outline "src/**/*.ts" --summarize                          # 生成 AI 摘要
codebase outline "src/**/*.ts" --dry-run                            # 预览匹配的文件
codebase outline --clear-cache                                      # 清除摘要缓存

# 代码行级高亮（独立管线，无需索引）
codebase highlight "authentication" src/auth.ts                     # 单文件高亮
codebase highlight "train method" "src/**/*.py"                     # glob 模式
codebase highlight "authentication" src/auth.ts --demo              # demo 工作空间
codebase highlight "login" src/auth.ts --debug                      # token 级热力图
codebase highlight "login" src/auth.ts --json                       # JSON 输出
codebase highlight "login" src/auth.ts --topk 15                    # 覆盖 Top-K
codebase highlight "login" src/auth.ts --mode threshold --threshold 0.3  # threshold 模式
cat src/auth.ts | codebase highlight "authentication"               # stdin 管道

# 调用图分析
# 完整数据模式（无 --query）
codebase call                                   # 显示统计概览
codebase call --json                            # 显示统计概览（JSON 格式，包含示例节点）
codebase call --viz graph.json                  # 导出完整可视化数据
codebase call --open                            # 打开可视化查看器
codebase call --viz graph.json --open           # 导出并打开
codebase call src/commands                      # 分析指定目录

# 查询模式（有 --query）
codebase call --query="main"                    # 查询单个函数的调用树（默认深度3）
codebase call --query="functionA,functionB"     # 多函数连接分析（默认深度10）
codebase call --query="main" --json             # 显示查询结果（JSON 格式）
codebase call --query="main" --depth=5          # 自定义调用树深度
codebase call --query="app,addUser" --depth=15  # 自定义路径搜索深度
codebase call --path=/workspace --query="main"  # 指定工作空间路径

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

## 其他
- 项目测试运行不需要build，直接npx tsx xxx.ts运行
- 可以搜索docs目录了解项目wiki和之前的任务经验
- 项目配置在autodev-config.json中，可以通过codebase config --get/--set命令进行查看和修改，demo目录有单独的autodev-config.json，需要用codebase config --path=demo来指定，项目根目录的autodev-config.json、~/.autodev-cache/autodev-config.json、demo/autodev-config.json是独立的
- 测试脚本写在scripts/evidence目录，用YYMMDD-开头的文件名命名
- 重命名文件时使用git mv命令

<skills_system priority="1">

## Available Skills

<!-- SKILLS_TABLE_START -->
<usage>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills:
- Invoke: `npx openskills read <skill-name>` (run in your shell)
  - For multiple: `npx openskills read skill-one,skill-two`
- The skill content will load with detailed instructions on how to complete the task
- Base directory provided in output for resolving bundled resources (references/, scripts/, assets/)

Usage notes:
- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already loaded in your context
- Each skill invocation is stateless
</usage>

<available_skills>

<skill>
<name>analyzing-codebase</name>
<description>Semantic search, structure extraction, and call graph analysis for codebases using vector embeddings and tree-sitter. Use when working with code search, understanding code structure, or analyzing function call relationships.</description>
<location>project</location>
</skill>

<skill>
<name>chatting-ai</name>
<description>Interact with local AI assistants for conversational dialogue, automatically managing multi-turn conversation state. Use when you need to analyze code, refactor and optimize, write new features, debug issues, or seek technical consultation. Supports multiple input methods (direct input, files, pipes).</description>
<location>project</location>
</skill>

<skill>
<name>creating-smart-docs</name>
<description>Creates code docs (with smart references and text charts) and task docs for development tracking. Use for architecture docs, flow diagrams, implementation planning, or when users mention code documentation, task docs, ASCII diagrams, smart references, or code flow visualization.</description>
<location>project</location>
</skill>

</available_skills>
<!-- SKILLS_TABLE_END -->

</skills_system>
