# 顶层调用不被依赖分析器追踪问题

## 主题/需求

依赖分析器 (`src/dependency`) 不会追踪模块顶层代码中的函数调用，导致某些依赖关系缺失。

**问题表现：**
在 `demo/app.js` 中，当 `function main()` 被注释掉后，文件内的所有函数调用（`greetUser()`、`userManager.addUser()` 等）变成顶层代码，不会被依赖分析器追踪到。

**影响：**
- 依赖图不完整，缺少模块初始化代码的依赖关系
- 无法看到入口文件的直接依赖
- 影响代码审查和重构分析的准确性

## 代码背景

### 依赖分析器架构

依赖分析器基于 Tree-sitter 实现，核心逻辑在 `src/dependency/analyzers/base.ts`：

```typescript
// src/dependency/analyzers/base.ts
export abstract class BaseAnalyzer {
  // 第一遍遍历：收集节点（函数、类、方法）
  protected traverseForNodes(
    node: Parser.SyntaxNode,
    currentClass: string | null
  ): void {
    // 检测函数/类定义，创建节点
  }

  // 第二遍遍历：收集调用关系
  protected traverseForCalls(
    node: Parser.SyntaxNode,
    currentFunc: string | null
  ): void {
    // 检测函数调用，创建边
  }
}
```

**两阶段分析：**
1. **第一阶段** - 收集所有函数/类/方法定义，创建节点
2. **第二阶段** - 遍历 AST，查找函数调用，创建依赖边

### 关键代码

**`traverseForCalls()` 方法：**

```typescript
// src/dependency/analyzers/base.ts:205-241
protected traverseForCalls(
  node: Parser.SyntaxNode,
  currentFunc: string | null
): void {
  const nt = this.nodeTypes

  // 更新当前函数上下文
  if (nt.functionTypes.has(node.type) || nt.methodTypes.has(node.type)) {
    const funcName = this.extractFunctionName(node)
    if (funcName) {
      currentFunc = this.findNodeIdByLine(node.startPosition.row + 1)
    }
  }

  // 提取调用 - ⚠️ 关键：必须 currentFunc 不为 null
  if (nt.callTypes.has(node.type) && currentFunc) {  // ← 这里！
    const calleeInfo = this.extractCallInfo(node)
    if (calleeInfo) {
      if (!this.shouldFilterCall(node, calleeInfo)) {
        this.addEdge(currentFunc, calleeInfo.name, ...)  // 创建依赖边
      }
    }
  }

  // 递归遍历子节点
  for (const child of node.children) {
    this.traverseForCalls(child, currentFunc)
  }
}
```

**关键条件：**
```typescript
if (nt.callTypes.has(node.type) && currentFunc) {
  // 只有 currentFunc 不为 null 才会记录调用
}
```

**`currentFunc` 的生命周期：**
- 初始值：`null`（顶层作用域）
- 进入函数/方法时：赋值为函数 ID
- 退出函数/方法时：恢复为 `null` 或父函数 ID
- 顶层代码：始终为 `null`

### 节点类型定义

```typescript
// src/dependency/types.ts
export type ComponentType = 'function' | 'class' | 'method'

export interface DependencyNode {
  id: string
  name: string
  componentType: ComponentType  // 只有这三种类型
  filePath: string
  // ...
}
```

**当前限制：**
- 没有 `module` 类型来表示文件/模块本身
- 依赖边必须有明确的起点（某个函数/类/方法）

### 问题复现

**测试文件：** `demo/app.js`

```javascript
// demo/app.js
const { greetUser, UserManager } = require('./hello');

// 场景1：main 函数未注释（正常）
function main() {
  const userManager = new UserManager();
  const greeting = greetUser('Alice');
  userManager.addUser({ name: 'Alice', email: 'alice@example.com' });
  const allUsers = userManager.getUsers();
}

// 场景2：main 函数注释掉（问题）
// function main() {
  const userManager = new UserManager();
  const greeting = greetUser('Alice');
  userManager.addUser({ name: 'Alice', email: 'alice@example.com' });
  const allUsers = userManager.getUsers();
// }
```

**场景1 - 未注释：**
```bash
$ npx tsx src/cli.ts call --demo --json

Relationships: 24
Resolved edges: 4 edges
  • demo/app.main → demo/hello.greetUser:11
  • demo/app.main → demo/hello.UserManager.addUser:15
  • demo/app.main → demo/hello.UserManager.getUsers:20
  • demo/model.Model → demo/model.Model.benchmark:678
```

**场景2 - 注释后：**
```bash
$ npx tsx src/cli.ts call --demo --json

Relationships: 20
Resolved edges: 1 edges
  • demo/model.Model → demo/model.Model.benchmark:678

# ❌ demo/app.js 的 3 条边消失了
```

**差异分析：**
- 节点数：从 43 降到 42（缺少 `demo/app.main` 节点）
- 关系数：从 24 降到 20（缺少 4 条边）
- `greetUser`、`UserManager.addUser`、`UserManager.getUsers` 的调用关系丢失

## 关键决策

### 问题根源分析

**核心原因：** `traverseForCalls()` 的条件 `if (nt.callTypes.has(node.type) && currentFunc)` 要求 `currentFunc` 不为 `null`，而顶层代码的 `currentFunc` 始终为 `null`。

**设计哲学：** 当前设计只关注"函数/类/方法之间的调用关系"，不追踪模块级别的依赖。

### 现有基础设施

**重要发现：**

1. **类型系统已支持 `module`**
   ```typescript
   // src/dependency/models.ts:26
   componentType: 'function' | 'class' | 'method' | 'interface' | 'struct' | 'trait' | 'enum' | 'module'
   ```

2. **代码已在使用 `module` 类型**
   ```typescript
   // src/dependency/index.ts:235 - 为无分析器的文件创建后备节点
   const fileNode: DependencyNode = {
     id: parseResult.filePath,
     name: pathUtils.basename(parseResult.filePath),
     componentType: 'module',
     // ...
   }
   ```

3. **过滤机制已完善**
   ```typescript
   // src/dependency/analyzers/base.ts:627
   protected shouldFilterCall(node, calleeInfo): boolean {
     // 过滤全局内置函数（setTimeout, console.log 等）
     if (calleeInfo.isGlobalCall) {
       return this.getGlobalBuiltins().has(calleeInfo.name)
     }
     // 过滤成员内置调用（console.log, process.exit 等）
     return this.getMemberBuiltins().has(calleeInfo.fullPath)
   }
   ```

### 方案对比

| 方案 | 优点 | 缺点 | 复杂度 |
|------|------|------|--------|
| **方案1：添加 module 节点** | - 完整的依赖图<br>- 支持更多代码模式<br>- 类型系统已支持<br>- 过滤机制已完善 | - 修改核心逻辑<br>- 图节点数增加 | 低（只需修改 base.ts 两处）|
| **方案2：放宽条件（无 module 节点）** | - 实现简单 | - 边的语义不清<br>- caller 为文件路径而非节点 | 中 |
| **方案3：用户 workaround** | - 不修改代码 | - 需要用户配合<br>- 不适合所有场景 | 无 |

### 最终决策：**采用方案1**

**理由：**

1. **技术基础完备**
   - 类型系统已支持 `module` 类型
   - 过滤机制已处理 `console.log` 等噪音
   - 代码已在特定场景使用 `module`

2. **实施复杂度低**
   - 只需修改 `base.ts` 两处关键代码
   - 子类无需修改（继承父类逻辑）
   - 风险可控

3. **价值明确**
   - 支持入口文件、脚本文件、测试文件等常见模式
   - 完整的依赖图，准确的影响分析
   - 解决真实用户场景问题

4. **设计合理**
   - `module` 类型代表文件/模块本身是合理的抽象
   - 顶层代码的依赖关系确实应该被追踪
   - 图的复杂度增加是合理的（每个文件多一个节点）

### 影响范围

**会受益的代码模式：**
- ✅ 入口文件的顶层初始化代码（如 `app.js`）
- ✅ 脚本文件的顶层执行代码
- ✅ 测试文件的顶层 `describe()`、`it()` 调用
- ✅ 配置文件的顶层逻辑

**不受影响：**
- ❌ 函数/方法内部的调用（已正常追踪）
- ❌ 类构造器内的调用（已正常追踪）

## 实施计划

### 阶段1：核心实现

**修改1：在分析开始时创建 module 节点**

```typescript
// src/dependency/analyzers/base.ts - 在 analyze() 方法开始处
public async analyze(): Promise<ParseOutput> {
  // 创建 module 节点
  this.createModuleNode()
  
  const tree = this.parser.parse(this.content)
  // ... 现有逻辑
}

private createModuleNode(): void {
  const moduleId = this.getModulePath()  // 复用现有方法，保持 ID 格式一致
  const moduleNode: DependencyNode = {
    id: moduleId,
    name: path.basename(this.filePath),
    componentType: 'module',
    filePath: this.filePath,
    relativePath: this.getRelativePath(),
    startLine: 1,
    endLine: this.lines.length,
    dependsOn: new Set(),
    language: this.nodeTypes.extensions.values().next().value,
  }
  this.nodes.set(moduleId, moduleNode)
}

private getModuleNodeId(): string {
  return this.getModulePath()  // 直接使用现有的 getModulePath() 方法
}
```

**修改2：支持顶层调用追踪**

```typescript
// src/dependency/analyzers/base.ts:220 - 修改 traverseForCalls 方法
protected traverseForCalls(
  node: Parser.SyntaxNode,
  currentFunc: string | null
): void {
  const nt = this.nodeTypes

  // 更新当前函数上下文
  if (nt.functionTypes.has(node.type) || nt.methodTypes.has(node.type)) {
    const funcName = this.extractFunctionName(node)
    if (funcName) {
      currentFunc = this.findNodeIdByLine(node.startPosition.row + 1)
    }
  }

  // 提取调用 - 支持顶层调用
  if (nt.callTypes.has(node.type)) {  // ← 移除 && currentFunc
    const calleeInfo = this.extractCallInfo(node)
    if (calleeInfo) {
      if (!this.shouldFilterCall(node, calleeInfo)) {
        // 使用 currentFunc 或 module ID 作为 caller
        const caller = currentFunc || this.getModuleNodeId()  // ← 新增
        
        if (calleeInfo.isGlobalCall) {
          this.addEdge(caller, calleeInfo.name, node.startPosition.row + 1)
        } else {
          this.addEdge(caller, calleeInfo.fullPath, node.startPosition.row + 1)
        }
      }
    }
  }

  // 递归遍历子节点
  for (const child of node.children) {
    this.traverseForCalls(child, currentFunc)
  }
}
```

### 阶段2：测试验证

**单元测试：**
```typescript
// src/dependency/__tests__/top-level-calls.test.ts
describe('Top-level calls tracking', () => {
  it('should track top-level function calls', async () => {
    const code = `
      const { greetUser } = require('./hello');
      greetUser('Alice');  // 顶层调用
    `
    // 验证创建了 module 节点
    // 验证创建了 module → greetUser 的边
  })

  it('should create module node for each file', async () => {
    // 验证 module 节点的 id、name、componentType
  })

  it('should still filter builtin calls', async () => {
    const code = `
      console.log('test');  // 应该被过滤
      setTimeout(() => {}, 100);  // 应该被过滤
    `
    // 验证这些调用不会创建边
  })
})
```

**集成测试：**
```bash
# 验证 demo/app.js（main 函数注释后）
$ npx tsx src/cli.ts call --demo

# 预期输出应包含：
# • demo/app (module) → demo/hello.greetUser:11
# • demo/app (module) → demo/hello.UserManager.addUser:15
# • demo/app (module) → demo/hello.UserManager.getUsers:20
```

### 阶段3：文档更新

**API 文档更新：**
```markdown
## DependencyNode

### componentType

节点类型：
- `function` - 函数定义
- `class` - 类定义
- `method` - 方法定义
- `module` - 模块/文件本身（用于追踪顶层调用）

#### module 节点说明

每个分析的文件都会自动创建一个 `module` 节点，用于追踪文件顶层代码的依赖关系。

**示例：**
```javascript
// app.js
const { greetUser } = require('./hello');
greetUser('Alice');  // 顶层调用

// 依赖图：
// app (module) → hello.greetUser
```

**注意：** 内置函数调用（如 `console.log`）会被自动过滤。
```

**用户指南更新：**
```markdown
## 依赖分析功能

### 支持的依赖类型

1. **函数间调用** - `functionA → functionB`
2. **类间调用** - `ClassA → ClassB`
3. **方法间调用** - `ClassA.methodX → ClassB.methodY`
4. **模块级调用** - `module → function/class` (新增)

### 顶层代码支持

依赖分析器会自动追踪文件顶层代码的函数调用：

```javascript
// 入口文件 app.js
const service = new UserService();  // ✅ 会追踪
service.initialize();               // ✅ 会追踪
console.log('Ready');               // ❌ 自动过滤（内置函数）
```

这对以下场景特别有用：
- 入口文件的初始化逻辑
- 脚本文件的执行流程
- 测试文件的顶层 describe/it 调用
```

## 实施记录

### 2026-01-21：问题分析与方案决策

**阶段：** 问题调研与方案设计

**活动：**
1. 分析了 `demo/app.js` 中 main 函数注释前后的行为差异
2. 定位问题根源：`base.ts:220` 的 `&& currentFunc` 条件
3. 调研了现有代码基础设施：
   - 发现类型系统已支持 `module` 类型
   - 发现代码已在特定场景使用 `module`（后备节点）
   - 确认过滤机制已完善（`shouldFilterCall`）
4. 对比了三个方案，决策采用方案1

**关键发现：**
- `src/dependency/models.ts:26` 已定义 `'module'` 类型
- `src/dependency/index.ts:235` 已为无分析器文件创建 module 节点
- `shouldFilterCall()` 已处理 `console.log` 等噪音调用

**决策：** 采用方案1（添加 module 节点），理由：
- 技术基础完备，实施复杂度低
- 价值明确，设计合理
- 只需修改 `base.ts` 两处代码

**下一步：** 实施核心代码修改和测试验证

## 修订记录

无

## 总结

### 问题本质

顶层调用不被追踪是依赖分析器的**设计限制**，根本原因是 `traverseForCalls()` 要求 `currentFunc` 不为 `null`，而顶层代码的 `currentFunc` 始终为 `null`。

### 解决方案

采用**方案1：添加 module 节点**，为每个文件创建一个 `module` 类型的节点，代表文件/模块本身。顶层调用时，使用 module 节点作为 caller。

### 技术优势

1. **基础完备** - 类型系统已支持，过滤机制已完善
2. **复杂度低** - 只需修改 `base.ts` 两处关键代码
3. **设计合理** - `module` 类型代表文件本身是合理的抽象
4. **向后兼容** - 不破坏现有功能，子类无需修改

### 预期收益

- ✅ 完整的依赖图，包括入口文件的顶层依赖
- ✅ 支持脚本文件、测试文件等常见模式
- ✅ 更准确的代码审查和影响分析
- ✅ 解决真实用户场景问题

### 实施要点

**核心修改：**
1. `createModuleNode()` - 为每个文件创建 module 节点
2. `traverseForCalls()` - 移除 `&& currentFunc` 条件，支持顶层调用

**测试重点：**
- 验证 module 节点正确创建
- 验证顶层调用正确追踪
- 验证内置函数仍被过滤
- 验证 demo/app.js 的行为符合预期

**文档更新：**
- API 文档说明 `module` 节点类型
- 用户指南说明顶层代码支持

### 经验教训

1. **先调研再决策** - 发现类型系统已支持 `module`，大幅降低实施复杂度
2. **重视现有机制** - `shouldFilterCall()` 已解决噪音问题，无需额外处理
3. **设计一致性** - 将 `module` 从"后备机制"扩展为"正式功能"是自然的演进

### 后续优化建议

1. **配置化（可选）** - 添加 `trackTopLevelCalls` 配置项，允许用户关闭此功能
2. **可视化优化** - 在依赖图中用不同样式区分 module 节点
3. **性能监控** - 监控 module 节点对图复杂度和性能的影响

### 参考资源

- Tree-sitter 文档：https://tree-sitter.github.io/tree-sitter/
- 依赖分析器设计：`src/dependency/README.md`
- 相关测试：`src/dependency/__tests__/`
