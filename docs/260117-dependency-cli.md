# Dependency CLI 设计文档

## 主题/需求

将现有的 dependency 模块功能集成到 CLI 工具中，提供命令行接口用于代码依赖分析。

**核心需求：**
1. **索引概览** - 显示依赖分析的统计信息（节点数、关系数、语言分布等）
2. **数据导出** - 生成 JSON 文件供 `graph_viewer.html` 可视化使用
3. **依赖查询** - 根据函数名查询树形依赖关系（双向：callee + caller）
4. **可视化集成** - 导出后可自动打开 HTML 页面查看依赖图

**使用场景：**
- 代码审查：快速了解代码结构，识别复杂依赖
- 重构辅助：修改某个模块时，找出影响范围
- 架构分析：识别循环依赖、入口点、底层组件

## 代码背景

### 现有 CLI 架构

项目使用 commander.js 实现子命令模式（类似 git/npm），主入口为 `src/cli.ts`：

```
codebase
├── search      # 语义搜索
├── index       # 代码索引
├── outline     # 代码大纲
├── stdio       # stdio 适配器
└── config      # 配置管理
```

命令实现位于 `src/commands/` 目录，每个命令是一个独立的文件，遵循以下模式：
- `createXxxCommand()` - 创建并配置 Command 对象
- `xxxHandler()` - 命令处理逻辑
- 共享函数位于 `src/commands/shared.ts`

### Dependency 模块 API

`src/dependency/index.ts` 提供以下核心功能：

**主入口函数：**
- `analyze(path, deps, maxFiles?, options?)` - 分析代码依赖

**图分析函数：**
- `buildGraph(nodes, edges)` - 构建依赖图
- `detectCycles(adj)` - 检测循环依赖（Tarjan 算法）
- `topologicalSort(adj)` - 拓扑排序（Kahn 算法）
- `getLeafNodes(adj)` - 获取叶子节点

**可视化导出：**
- `generateVisualizationData(nodes, relationships, summary?)` - 生成 Cytoscape.js 格式数据

**数据模型：**
```typescript
interface DependencyNode {
  id: string
  name: string
  componentType: 'function' | 'class' | 'module'
  filePath: string
  dependsOn: Set<string>
  // ...
}

interface DependencyEdge {
  caller: string
  callee: string
  callLine: number
  isResolved: boolean
  confidence: number
}

interface DependencyResult {
  nodes: Map<string, DependencyNode>
  relationships: DependencyEdge[]
  summary: DependencySummary
  cycles: string[][]
  topoOrder: string[]
}
```

### 现有测试脚本

`run-dependency-analyzer.ts` 是一个完整的验收测试脚本，展示了：
- 如何调用 `analyze()` 函数
- 如何格式化输出各种统计信息
- 如何导出可视化数据到 `test.json`

该脚本将被重构为 CLI 命令。

## 关键决策

### 决策1：命令结构

**选择：单一命令 + 选项模式**

```
codebase call <path> [options]
```

**理由：**
- call 命令更简洁，避免 typing "dependency" 的冗长
- 与现有 `outline` 命令模式一致
- 用户心智模型简单：一个路径，多种输出方式

**不选择的方案：**
- `codebase dependency`：命令过长，输入效率低
- 子命令模式（`codebase call analyze <path>`）：过于冗长
- 独立命令（`codebase-deps <path>`）：破坏统一 CLI 入口

### 决策2：选项设计

| 选项 | 行为 | 实现方式 |
|------|------|----------|
| 无选项 | 显示索引概览 | 调用 `analyze()` 并格式化输出统计信息 |
| `--output <file>` | 导出 JSON | 调用 `generateVisualizationData()` 写入文件 |
| `--open` | 打开 HTML 可视化 | 使用 `open` 命令（macOS）或 `xdg-open`（Linux） |
| `--query <names>` | 查询依赖 | 从分析结果中提取指定节点的依赖关系 |
| `--depth <n>` | 控制深度 | 递归遍历时限制层级 |
| `--json` | JSON 输出 | 查询结果使用 JSON 格式 |

**交互规则：**
- `--open` 需要配合 `--output` 或使用默认文件名
- `--query` 与 `--output` 可同时使用
- `--json` 仅影响查询输出格式

### 决策3：查询结果展示

**双向依赖树：**

```
getUser (src/users/service.ts:45)
  ↓ calls (callee)
  ├── validateInput (src/users/validator.ts:12)
  └── db.query (src/database/client.ts:89)

  ↑ called by (caller)
  ├── handler.getUser (src/api/handler.ts:23)
  └── service.processUser (src/orders/service.ts:67)
```

**多函数连接关系：**

```
Connections between getUser, validateUser, sendEmail:

Direct connections:
  getUser → validateUser
  getUser → sendEmail
  validateUser → sendEmail

Chains found:
  getUser → validateUser → sendEmail
```

### 决策4：缓存策略

复用 dependency 模块现有的 `DependencyCacheManager`：
- 默认启用缓存以提升性能
- 缓存位置：`~/.autodev-cache/dependency/`
- 可通过 `--no-cache` 禁用（未来扩展）

## 实施计划

### 阶段1：基础命令框架

**任务：**
1. 创建 `src/commands/call.ts` 文件
2. 实现 `createCallCommand()` 函数
3. 在 `src/cli.ts` 中注册新命令

**文件结构：**
```
src/commands/
├── call.ts              # 新增
├── shared.ts            # 复用
└── ...
```

**代码框架：**
```typescript
// src/commands/call.ts
import { Command } from 'commander';
import { createNodeDependencies } from '../index';

export function createCallCommand(): Command {
  const command = new Command('call');
  command
    .description('Analyze code dependencies')
    .argument('<path>', 'Path to analyze')
    .option('--output <file>', 'Export JSON file')
    .option('--open', 'Open HTML visualization')
    .option('--query <names>', 'Query dependencies')
    .option('--depth <number>', 'Query depth', '10')
    .option('--json', 'JSON output for query')
    .action(callHandler);
  return command;
}
```

### 阶段2：概览模式（默认）

**任务：**
1. 实现 `callHandler()` 的默认分支
2. 调用 `analyze()` 获取依赖数据
3. 格式化输出统计信息

**输出格式：**
```
Dependency Analysis Summary
==========================
Files:         42
Nodes:         156
Relationships: 342
Languages:     TypeScript, Python
Cycles:        2

Component Types:
  - function: 98
  - class: 34
  - module: 24

Top modules by dependencies:
  - src/users/service.ts (23 deps)
  - src/api/handler.ts (18 deps)
```

### 阶段3：导出模式（--output）

**任务：**
1. 调用 `generateVisualizationData()`
2. 写入 JSON 文件
3. 实现 `--open` 功能

**实现要点：**
- 使用 `open` npm 包跨平台支持
- 默认文件名：`dependency-graph.json`

### 阶段4：查询模式（--query）

**任务：**
1. 解析查询参数（支持逗号分隔、通配符）
2. 实现双向依赖树遍历
3. 实现多函数连接关系分析
4. 支持 `--depth` 限制
5. 支持 `--json` 输出

**核心算法：**
```typescript
function buildDepTree(
  nodeId: string,
  nodes: Map<string, DependencyNode>,
  relationships: DependencyEdge[],
  depth: number
): DepTree {
  // 递归构建 callee 和 caller 树
}

function findConnections(
  nodeIds: string[],
  relationships: DependencyEdge[]
): Connection[] {
  // 找出节点间的直接连接和链式路径
}
```

### 阶段5：测试

**测试用例：**
1. 概览模式输出正确
2. JSON 导出格式正确
3. 查询单个函数
4. 查询多个函数
5. 通配符查询
6. 深度限制
7. `--open` 功能

## 总结

本设计文档定义了 `codebase call` 命令的完整实施方案，将现有 dependency 模块功能集成到 CLI 工具中。

**关键特性：**
- 简洁的命令名称 `call`，避免冗长的 `dependency`
- 统一的命令结构：单一命令 + 选项模式
- 四种输出模式：概览、导出、查询、可视化
- 双向依赖查询（callee + caller）
- 多函数连接关系分析
- 支持通配符和深度控制

**技术要点：**
- 复用现有 dependency 模块 API
- 复用 `src/commands/shared.ts` 中的共享函数
- 使用 `open` 包实现跨平台可视化打开
- 保持与现有命令风格一致

**后续优化方向：**
- 添加 `--no-cache` 选项
- 支持更多输出格式（Graphviz DOT）
- 添加依赖健康度评分
- 支持增量分析

