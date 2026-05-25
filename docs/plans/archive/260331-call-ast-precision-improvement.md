# 260331-call-ast-precision-improvement

## 主题/需求

当前 `codebase call` 的 AST 分析方案在以下场景精确度低：
1. **`this` 调用**：`this.validate()` 无法解析到 `ClassName.validate`
2. **链式调用**：`api.client.users.fetch()` 丢失上下文，只提取 "fetch"
3. **变量重命名**：`const svc = new UserService()` 后 `svc.getUser()` 无法追踪

**目标**：通过变量作用域追踪和类型推断，提升调用图构建的精确度。

## 代码背景

### 相关文件
- `src/dependency/analyzers/base.ts` - 基础分析器，包含 AST 遍历和边提取逻辑
- `src/dependency/analyzers/typescript.ts` - TypeScript/JavaScript 语言分析器
- `src/dependency/graph.ts` - 图构建和边解析算法
- `src/dependency/models.ts` - 核心数据结构定义

### 现有实现分析

#### 1. 调用提取流程 (base.ts)
```
traverseForCalls:205
├── extractCallInfo:662          # 从调用节点提取信息
│   ├── extractMemberPath:606    # 递归提取成员路径
│   └── 返回 CallInfo {name, fullPath, isGlobalCall}
├── shouldFilterCall:704         # 过滤内置调用
└── addEdge:374                  # 添加边到 edges 数组
    ├── importMap 解析           # 尝试通过导入映射解析
    └── 回退到原始名称           # 无法解析时保留原样
```

#### 2. 现有 `extractMemberPath` 实现 (base.ts:606-655)
```typescript
private extractMemberPath(node: Parser.SyntaxNode): string {
  // 基础情况：identifier → 返回文本
  // this 关键字 → 返回 "this"
  // member_expression → 递归提取 object.path + property
  // 问题：返回 "this.validate" 但无法解析到类方法
}
```

#### 3. 现有 `addEdge` 解析逻辑 (base.ts:374-411)
```typescript
protected addEdge(caller: string, calleeName: string, line: number): void {
  // 1. 尝试 importMap 直接匹配
  // 2. 尝试解析 prefix.member 格式（如 myModule.doSomething）
  // 3. 回退：保持原样，交给 graph.ts 的 resolveEdges 处理
}
```

#### 4. 现有 `resolveEdges` 启发式匹配 (graph.ts:111-186)
```typescript
export function resolveEdges(nodes, edges) {
  // 策略1: 完全匹配（callee 已是完整 ID）
  // 策略2: 同模块优先匹配
  // 策略3: 按模块距离排序（兜底启发式）
  // 问题：无法处理 "this.validate" 或 "svc.getUser" 格式
}
```

### 关键数据结构

#### CallInfo (base.ts:11-15)
```typescript
interface CallInfo {
  name: string           // 方法名，如 "log"
  fullPath: string       // 完整路径，如 "console.log"
  isGlobalCall: boolean  // 是否全局直接调用
}
```

#### DependencyEdge (models.ts)
```typescript
interface DependencyEdge {
  caller: string
  callee: string
  callLine?: number
  isResolved: boolean
  confidence: number
}
```

## 关键决策

### 决策 1: 变量追踪方案选择

| 方案 | 优点 | 缺点 | 决策 |
|------|------|------|------|
| **A. 完整类型推断** | 最精确 | 需要 TypeScript 编译器 API，复杂度高 | ❌ 不采用 |
| **B. 轻量变量映射表** | 实现简单，覆盖常见场景 | 无法处理复杂类型推断 | ✅ 采用 |
| **C. LLM 辅助解析** | 灵活 | 延迟高，成本高 | ❌ 不采用 |

**决策理由**：方案 B 在实现复杂度和覆盖范围之间取得平衡，能解决 80% 的常见问题。

### 决策 2: `this` 解析策略

**方案**：在类方法上下文中，维护 `currentClass` 变量，将 `this.xxx` 解析为 `ClassName.xxx`

**实现位置**：修改 `traverseForCalls` 和 `extractMemberPath`

### 决策 3: 变量重命名追踪范围

**支持**：
- `const x = new ClassName()` → `x → ClassName`
- `const x = this.method()` → `x → CurrentClass.method` 的返回类型（可选）
- `import { A as B }` → `B → A`（已由 importMap 支持）

**不支持**（留待后续）：
- 函数参数类型推断
- 复杂表达式类型推断
- 跨文件变量追踪

## 实施计划

### 阶段 1: 变量映射表实现
- [ ] 1.1 在 `BaseAnalyzer` 中添加 `variableBindings: Map<string, VariableBinding>` 字段
- [ ] 1.2 实现 `collectVariableDeclarations` 方法，遍历 AST 收集变量声明
- [ ] 1.3 支持 `const/let/var` 声明和 `new` 表达式类型推断
- [ ] 1.4 支持赋值表达式（`x = y`）的变量追踪

### 阶段 2: `this` 解析增强
- [ ] 2.1 修改 `traverseForCalls`，在类方法上下文中传递 `currentClass`
- [ ] 2.2 修改 `extractMemberPath`，将 `this` 替换为 `currentClass`
- [ ] 2.3 添加单元测试验证 `this` 解析

### 阶段 3: 边解析增强
- [ ] 3.1 修改 `addEdge`，使用变量映射表解析变量名调用
- [ ] 3.2 修改 `graph.ts` 的 `resolveEdges`，支持变量名解析
- [ ] 3.3 添加置信度计算（变量追踪的置信度低于 import 解析）

### 阶段 4: 测试和验证
- [ ] 4.1 编写单元测试覆盖三种场景
- [ ] 4.2 在真实项目上验证调用图精确度
- [ ] 4.3 性能测试（确保不显著增加分析时间）

## 实施记录

### 2026-03-31
**需求分析完成**
- 分析了现有 `base.ts`、`graph.ts` 的实现
- 确定了三个核心问题：`this` 调用、链式调用、变量重命名
- 设计了轻量变量映射表方案

## 修订记录

（暂无）

## 总结

（待实施完成后填写）
