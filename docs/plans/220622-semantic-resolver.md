# 220622 Semantic Resolver: 精准调用图的语义分析层

## 主题/需求

给 `codebase call` 的调用图分析增加**语义分析层**，从纯语法匹配（tree-sitter pattern matching）升级为**语言自身的类型检查器参与解析**，实现更精准的调用目标追踪。

**核心矛盾：**
- 纯 tree-sitter 语法分析 → 通用但精度有限（不知道 `obj.method()` 的 `obj` 是什么类型，无法跨模块精确匹配）
- 编译器式语义分析 → 精度高，但必须逐语言实现
- 动态插桩追踪 → 需要运行代码+测试，不通用

**目标：**
- 对 TypeScript：用 tsc TypeChecker API 做类型感知的调用解析，**不运行代码**
- 对 Python/Java/Go 等：后续各自接入对应语言的语义分析工具
- 架构上抽象为 `SemanticResolver` 接口，Tree-sitter 解析层不变，语义分析层可插拔

## 代码背景

### 相关文件

| 文件 | 作用 |
|------|------|
| `src/dependency/analyzers/base.ts` | BaseAnalyzer，语法级调用提取（traverseForCalls, extractCallName） |
| `src/dependency/analyzers/typescript.ts` | TypeScriptAnalyzer，当前只做语法匹配 |
| `src/dependency/analyzers/python.ts` | PythonAnalyzer，同上 |
| `src/dependency/index.ts` | analyze() 主流程，编排 parse → analyze → build graph |
| `src/dependency/graph.ts` | resolveEdges，用模块距离做启发式匹配（兜底） |
| `src/dependency/models.ts` | DependencyNode, DependencyEdge 类型定义 |

### 现有调用解析流程

```
parseFile (tree-sitter AST)
  ↓
TypeScriptAnalyzer.analyze()
  ├── extractImports()       ← 语法级 import 解析
  ├── traverseForNodes()     ← 提取函数/类/方法定义
  └── traverseForCalls()     ← 提取 call_expression → 方法名
  ↓
resolveEdges()               ← 按方法名 + 模块距离猜（启发式）
```

### 当前局限

- `foo()` → 只知道方法名 `foo`，不知道是哪个模块的 `foo`
- `obj.method()` → 只知道方法名 `method`，不知道 `obj` 的类型 → 没法精确匹配
- `export * from './bar'` → 透传导出断了链，无法追踪
- 多态调用 → 完全无能为力
- 跨文件调用 → 靠 `importMap` + `resolveEdges` 猜

## 运行现象

`codebase call --query="processData"` 当前输出：

```
src/processor/main.processData → src/helper/utils.parseRow  (解析成功？实际可能调的是另一个同名函数)
src/processor/main.processData → processDataInDb          (未解析，因为不知道模块)
src/processor/main.processData → this.transform             (只匹配到名字，不清楚 this 类型)
```

这些都是纯语法匹配的结果——按方法名 + 模块距离在猜。当项目里有多个同名函数、或通过接口/抽象类定义时，猜错率很高。

## 归因分析

**根本原因：** tree-sitter 只是语法分析器（CFG parser），它不、也不可能做任何语义分析。

| 语法分析能做到的 | 语义分析才能做到的 |
|---|---|
| `这是一个 call_expression` | `这个 call 绑定到 UserService.getUser` |
| `方法名是 method` | `obj 是 UserService 类型` |
| `import { foo } from './bar'` | `bar.ts 的 foo 签名是 (x: number) => string` |
| 节点位置信息 | 符号跨文件可见性、重载决议、泛型具象化 |
| 作用域（基于大括号） | 名字绑定到声明的哪个符号 |

**核心矛盾无法绕过：** 不做语义分析，call-graph 精度有上限。做语义分析，每种语言都得单独实现。

## 关键决策

### 决策 1：分层架构——解析统一，语义可插拔

```
                        tree-sitter（统一解析 40+ 语言）
                              ↓
                   语法层分析器（BaseAnalyzer）
                   提取定义节点 + 发现调用位置
                              ↓
                   SemanticResolver（接口统一）
                    ├── TscResolver (TS/JS)  ← tsc TypeChecker API
                    ├── PyrightResolver (Python)
                    ├── GoTypesResolver (Go)
                    └── FallbackResolver (兜底 = 用当前语法匹配)
                              ↓
                     graph.ts（图构建，不变）
```

**理由：** tree-sitter 做"发现调用"（哪里调了），SemanticResolver 做"解析调用"（调的是谁）。各司其职，不互相替代。当前架构只需要加一层，不需要改现有代码。

### 决策 2：TypeScript 优先——直接使用 tsc TypeChecker API

**不自己实现类型系统，直接用 `import ts from 'typescript'` 调用官方类型检查器。**

- tsc API 提供 `getResolvedSignature()`、`getSymbolAtLocation()`、`getTypeAtLocation()`
- 对于 TypeScript，这是最高精度、最低成本的选择
- 项目已安装 `typescript@^5.6.2`

### 决策 3：接口驱动——SemanticResolver 统一抽象

```typescript
interface SemanticResolver {
  resolveCallTarget(params: {
    filePath: string
    line: number       // 0-based, 来自 tree-sitter
    column: number     // 0-based, 来自 tree-sitter
    sourceText: string
  }): Promise<ResolveResult | null>
}

interface ResolveResult {
  targetSymbol: string    // 如 "src/utils/helper.parseDate"
  targetFile: string      // 定义所在文件
  confidence: number      // 0.0-1.0
}
```

**理由：** 接口抽象后，每个语言一个实现类。`BaseAnalyzer` 不直接依赖任何语言的语义分析工具，通过依赖注入接入。

### 决策 4：Fallback 机制——语义分析失败不崩，降级到语法匹配

tsc 可能因为文件不在 `tsconfig` 内、语法错误、或跨语言调用等原因无法解析。此时不阻塞，**保留现有语法分析的兜底逻辑**。

### 决策 5：渐近式集成，不改现有数据模型

`DependencyNode`、`DependencyEdge` 的数据结构不动。语义分析只影响 `edge.callee` 的解析精度，不影响上下游。

## 实施计划

### 阶段一：基础设施（SemanticResolver 接口 + TscResolver）

- [ ] 新建 `src/dependency/semantic/` 目录
- [ ] 定义 `SemanticResolver` 接口和 `ResolveResult` 类型
- [ ] 实现 `TscResolver`（单文件模式：createSourceFile + 最小 CompilerHost）
- [ ] 实现 `TscResolver`（全量模式：读 tsconfig.json，全量 Program）
- [ ] 辅助函数：`findNodeAtPosition()`（在 tsc AST 中按位置查找节点）
- [ ] 辅助函数：`resolveAccessChain()`（处理 `obj.method().prop.call()` 等链式调用）
- [ ] 实现 `FallbackResolver`（永远返回 null，让上层走语法匹配）

### 阶段二：集成到 TypeScriptAnalyzer

- [ ] TypeScriptAnalyzer 构造函数注入可选的 `SemanticResolver`
- [ ] `traverseForCalls` 逻辑增强：优先调 SemanticResolver，失败则回退到提取方法名
- [ ] 处理 tsx/jsx 文件
- [ ] 处理 JavaScript 文件（同 tsc API，TS 对 JS 也做类型推断）

### 阶段三：验证与评估

- [ ] 在 demo 项目上跑对比测试
  - 语义分析前 vs. 后的 call-graph
  - 解析率提升（% of edges 从 unresolved → resolved）
  - 精度提升（是否匹配到正确的同名函数）
- [ ] 对真实仓库（本项目 autodev-codebase 自己的代码）跑全量分析

### 阶段四：其他语言扩展

- [ ] Python: 调研 Pyright API 或 Jedi 的集成方式
- [ ] Go: `go/types` 包的调用方式
- [ ] Java: Eclipse JDT 或 javac API
- [ ] Rust: rust-analyzer 的语义分析

## 实施记录

### 2026-06-22
创建文档。完成方案设计讨论。

**结论：**
1. 纯语法分析（tree-sitter）是通用的 baseline，精度有限
2. 语义分析（tsc TypeChecker 等）是提升精度的正确方向
3. 架构是"统一 parse + 逐语言 semantic resolver"，不改现有数据模型
4. TypeScript 是突破口，因为 tsc API 免费可用且零额外依赖

关键认知：**tree-sitter 做"发现调用"，SemanticResolver 做"解析调用目标"。前者通用，后者逐语言实现。**

## 修订记录

（待补充）

## 总结

### 核心认知

1. **call-graph 精度的天花板 = 语义分析的深度。** 不做语义分析，就永远在"按名字猜"。
2. **通用性和精度之间没有银弹。** 每种语言的类型系统不同，语义分析必须逐语言实现。但**接口可以统一**。
3. **tsc TypeChecker API 是 TypeScript 给的最好礼物。** 对其他语言来说，只能各找各的语义分析库。
4. **不要从零造类型系统。** 用语言已有的类型检查器（tsc/Pyright/Go types）才是最务实的选择。
5. **Fallback 策略很重要。** 语义分析失败时，语法匹配是有效的降级方案。

### 后续方向

- 阶段一跑通后，TypeScript 的 call-graph 精度应该能接近 IDE "go to definition" 的水准
- 对于动态语言（Python/JS），语义分析也只能做到"可能的调用集"，接受这个局限性
- 远期可以考虑 LSP 作为通用语义分析层，覆盖更多语言
