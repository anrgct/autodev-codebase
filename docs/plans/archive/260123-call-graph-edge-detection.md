# 调用图边检测限制问题

## 主题

记录 `codebase call` 多函数查询时静态分析无法追踪属性访问导致的边丢失问题。

## 代码背景

`codebase call` 命令用于分析函数之间的调用关系，支持：
- 单函数查询：显示完整的调用树（被谁调用 + 调用谁）
- 多函数查询：查找多个函数之间的连接关系

核心实现位于 `src/dependency/query.ts` 和 `src/dependency/analyzers/base.ts`。

## 问题描述

### 现象

```bash
# 单函数查询 - 正常显示调用树
codebase call --query="indexHandler" --depth=10
# 显示：indexHandler → initializeManager → startIndexing → ...

# 多函数查询 - 找不到边
codebase call --query="scanDirectory,indexHandler"
# 输出：
# Found 2 matching node(s):
#   - src/code-index/processors/scanner.DirectoryScanner.scanDirectory
#   - src/commands/index.indexHandler
# Direct connections: (none)
# Chains found: (none)
```

### 实际调用链

```
indexHandler (src/commands/index.ts:232-385)
  └── initializeManager (src/commands/shared.ts:118-155)
        └── CodeIndexManager.startIndexing (src/code-index/manager.ts:199-216)
              └── CodeIndexOrchestrator.startIndexing (src/code-index/orchestrator.ts:142-375)
                    └── this.scanner.scanDirectory()  ← 调用链在此断裂！
```

## 根本原因

**静态分析无法追踪属性访问（property access）**。

### 调用类型与识别能力

| 调用类型 | 示例 | 静态分析能否识别 |
|---------|------|-----------------|
| 直接调用 | `func()` | ✅ 能 |
| 成员调用 | `obj.method()` | ✅ 能 |
| 属性访问调用 | `this.scanner.scanDirectory()` | ❌ 不能 |

### 技术细节

依赖分析基于 AST 静态解析，核心逻辑在 `src/dependency/analyzers/base.ts:208-248`：

```typescript
// 能识别的调用
if (callee.type === 'identifier') {
  // 全局直接调用
  this.addEdge(caller, calleeInfo.name, ...)
}

// 成员调用也能识别
if (callee.type === 'member_expression') {
  // console.log() 等
  this.addEdge(caller, calleeInfo.fullPath, ...)
}
```

但对于 `this.scanner.scanDirectory()`：
- `this.scanner` 是实例属性，AST 中表示为 `member_expression`
- `this.scanner` 的运行时类型无法通过静态分析确定
- 工具不知道 `this.scanner` 指向 `DirectoryScanner` 实例

### 相关代码位置

1. **调用信息提取**：`src/dependency/analyzers/base.ts:644-695` (`extractCallInfo`)
2. **调用边添加**：`src/dependency/analyzers/base.ts:208-248` (`traverseForCalls`)
3. **多函数连接分析**：`src/dependency/query.ts:332-380` (`findShortestPath`, `findChains`)

## 实施计划

### 方案 1：属性访问追踪（复杂）

在 `traverseForCalls` 中识别 `this.property.method()` 模式：
- 记录 `this.property` 的赋值来源
- 通过数据流分析追踪属性指向
- **缺点**：实现复杂，可能影响性能

### 方案 2：注册表映射（折中）

在类初始化时记录实例属性类型：
- `orchestrator.scanner` → `DirectoryScanner`
- 解析时查询映射表
- **缺点**：需要手动维护映射

### 方案 3：文档说明（简单）

在帮助文档中说明限制：
- 告知用户静态分析的局限性
- 提供变通方案（如使用单函数查询）
- **优点**：实现简单，无副作用

## 实施记录

### 2026-01-17

- 创建本文档记录问题
- 分析根本原因：静态分析无法追踪属性访问
- 评估三种解决方案

## 总结

### 经验教训

1. **静态分析有固有局限**：AST 解析只能看到语法结构，无法推断运行时类型
2. **成员调用 vs 属性访问**：`obj.method()` 能识别，但 `this.prop.method()` 难以追踪
3. **工具定位要清晰**：依赖分析工具应明确定位为"静态调用图分析"

### 后续优化建议

1. 短期：在 CLI 帮助文档中说明静态分析的限制
2. 中期：实现方案 2（注册表映射），提升常见模式的识别率
3. 长期：考虑集成 TypeScript 编译器 API 进行更精确的分析

### 参考资源

- AST 解析基础：[tree-sitter 文档](https://tree-sitter.github.io/tree-sitter/)
- TypeScript 编译器 API：[typescript-eslint](https://typescript-eslint.io/)
```

如需调整内容或格式，请告知。