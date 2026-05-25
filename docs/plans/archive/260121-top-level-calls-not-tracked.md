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

### 2026-01-21：核心实现完成

**阶段：** 代码实施与测试验证

**活动：**

1. **核心代码修改**（已完成）
   - 在 `base.ts:141` 添加 `createModuleNode()` 调用
   - 实现 `createModuleNode()` 方法（`base.ts:310-333`）
   - 实现 `getModuleNodeId()` 辅助方法（`base.ts:335-341`）
   - 修改 `traverseForCalls()` 支持顶层调用（`base.ts:221-241`）
   - 修复 `extractCallInfo()` 支持 `new_expression`（`base.ts:633-673`）

2. **测试验证**（已完成）
   - 创建单元测试文件 `src/dependency/__tests__/top-level-calls.test.ts`
   - 编写 12 个测试用例，覆盖：
     - Module 节点创建
     - 顶层函数调用追踪
     - 构造器调用（`new` 表达式）
     - 内置函数过滤
     - TypeScript 支持
     - 边界情况处理
   - **测试结果**：12/12 通过 ✅

3. **集成测试验证**（已完成）
   - 测试 `demo/app.js`（main 函数已注释）
   - **结果**：
     - 创建 1 个 module 节点：`demo/app`
     - 追踪 7 条边：
       - `UserManager` (构造器)
       - `greetUser`
       - `userManager.addUser` (×3)
       - `userManager.getUsers`
       - `allUsers.forEach`
   - **验证通过** ✅

**关键修复：**

在实施过程中发现 `new_expression` 未被追踪，原因是 `extractCallInfo()` 方法只处理 `call_expression`。通过以下修改修复：

```typescript
// 修复前：只获取 children[0]
const callee = node.children[0]

// 修复后：处理 new_expression
if (node.type === 'new_expression') {
  const constructorNode = node.childForFieldName('constructor')
  if (!constructorNode) return null
  callee = constructorNode
} else {
  callee = node.children[0]
}
```

**测试覆盖率：**
- ✅ Module 节点创建
- ✅ 顶层函数调用
- ✅ 顶层构造器调用（`new` 表达式）
- ✅ 顶层成员方法调用
- ✅ 内置函数过滤（`console.log`、`setTimeout` 等）
- ✅ 函数内调用与顶层调用的区分
- ✅ 空文件和无调用文件的处理

**下一步：** 更新文档，记录 module 节点类型和顶层调用支持

## 修订记录

### 2026-01-23：优化 module 节点创建策略（按需创建）

**问题：**
- 每个文件都创建 module 节点，导致大量没有边的 module 节点
- 图中冗余节点过多，影响可读性和性能
- 例如：4 个文件创建 4 个 module 节点，但只有 1 个有实际依赖关系

**解决方案：** 按需创建 module 节点

**实施修改：**

1. **删除预创建逻辑**（`src/dependency/analyzers/base.ts:141`）
   ```typescript
   // ❌ 删除：在 analyze() 开始时创建 module 节点
   async analyze(): Promise<ParseOutput> {
     // this.createModuleNode()  // ← 删除这一行
     
     const tree = this.parser.parse(this.content)
     // ...
   }
   ```

2. **修改顶层调用追踪**（`src/dependency/analyzers/base.ts:221-241`）
   ```typescript
   // 将 getModuleNodeId() 改为 ensureModuleNode()
   const caller = currentFunc || this.ensureModuleNode()
   ```

3. **添加懒加载方法**（`src/dependency/analyzers/base.ts:351-371`）
   ```typescript
   protected ensureModuleNode(): string {
     const moduleId = this.getModuleNodeId()
     
     // 如果已存在，直接返回 ID
     if (this.nodes.has(moduleId)) {
       return moduleId
     }
     
     // 否则创建新节点
     this.createModuleNode()
     return moduleId
   }
   ```

**测试更新：**

更新 2 个测试用例以反映新的按需创建行为：

1. `should NOT create module node when there are no top-level calls`
   - 旧行为：总是创建 module 节点
   - 新行为：无顶层调用时不创建

2. `should NOT create module node for files with no calls at all`
   - 旧行为：空文件也创建 module 节点
   - 新行为：无调用时不创建

**测试结果：** ✅ 12/12 测试通过

**集成测试验证（demo 目录）：**

- 文件数：4（`demo/app.js`、`demo/hello.js`、`demo/model.py`、`demo/utils.py`）
- **优化前**：应该有 4 个 module 节点
- **优化后**：只有 1 个 module 节点（`demo/app`）
- **减少节点数**：3 个无边节点（75% 减少）
- **依赖边验证**：`demo/app` 有 5 条依赖边，功能正常

**效果对比：**

| 指标 | 优化前 | 优化后 | 改进 |
|------|--------|--------|------|
| Module 节点总数 | 4 | 1 | ↓ 75% |
| 有边的 module 节点 | 1 | 1 | - |
| 无边的 module 节点 | 3 | 0 | ↓ 100% |
| 总节点数 | 46 | 43 | ↓ 6.5% |
| 功能完整性 | ✅ | ✅ | - |

**优势：**

1. ✅ **自动优化** - 无需配置，自动过滤无用节点
2. ✅ **向后兼容** - 不影响现有功能和 API
3. ✅ **性能提升** - 减少节点数量，图更清晰
4. ✅ **符合直觉** - "有依赖才显示" 是合理的默认行为
5. ✅ **实施简单** - 只需修改 3 处代码

**影响范围：**

- 核心逻辑：`src/dependency/analyzers/base.ts`（3 处修改）
- 测试文件：`src/dependency/__tests__/top-level-calls.test.ts`（2 个测试用例更新）
- API 保持不变：对外接口无变化
- 行为变化：仅影响内部节点创建时机

### 2026-01-21：改进 `--clear-cache` 的用户反馈

**问题：**
- `--clear-cache` 选项在默认日志级别（`error`）下没有任何输出
- 用户不知道缓存是否真的被清除了

**修改：**
1. 使用 `console.log()` 替代 `logger.info()` 确保消息始终显示
2. 获取清除前的缓存统计信息并显示
3. 提供友好的格式化输出

**输出示例：**
```bash
# 有缓存时
✓ Dependency cache cleared successfully
  Repository: /Users/user/project
  Cached files cleared: 4/4

# 空缓存时
✓ Dependency cache cleared successfully
  Repository: /Users/user/project
  (Cache was empty)
```

**影响：**
- ✅ 用户操作有明确反馈
- ✅ 显示清除的缓存文件数量
- ✅ 显示仓库路径，便于确认操作的项目

### 2026-01-21：统一 module 节点的 name 字段格式

**问题：** 
- module 节点的 `name` 字段包含文件扩展名（如 `app.js`）
- 其他节点类型（function/class/method）的 `name` 都不包含扩展名
- 导致查询时不一致：`--query="app"` 无法匹配 `app.js` 模块

**修改：**
1. 修改 `createModuleNode()` 方法（`src/dependency/analyzers/base.ts:320-336`）
   - 在设置 `name` 字段前移除文件扩展名
   - 保持与其他节点类型的一致性
   
2. 更新测试用例（`src/dependency/__tests__/top-level-calls.test.ts`）
   - 修改断言：`expect(moduleNode?.name).toBe('app')` 而非 `'app.js'`
   - 添加注释说明一致性原则

**理由：**
- **统一性优先**：所有节点的 `name` 字段都应该是"简短标识符"，不包含路径或扩展名
- **查询体验更好**：用户输入 `--query="app"` 就能匹配 `app.js` 模块
- **完整信息不丢失**：`filePath` 和 `relativePath` 字段保留完整路径信息

**影响：**
- ✅ 查询体验提升：`--query="app"` 可以匹配 `demo/app` 模块
- ✅ 数据模型更一致：所有节点 `name` 字段格式统一
- ✅ 测试全部通过：12/12 测试用例通过

### 2026-01-21：添加 `--clear-cache` 选项

**问题：** 在开发过程中发现缓存了旧的分析结果（没有 module 节点），导致新功能无法生效。

**修改：**
1. 导出 `findGitRoot()` 函数（`src/dependency/index.ts:76`）
   - 从私有函数改为公开导出
   - 添加 JSDoc 文档说明
   
2. 为 `call` 命令添加 `--clear-cache` 选项（`src/commands/call.ts`）
   - 添加选项定义：`.option('--clear-cache', 'Clear dependency analysis cache')`
   - 实现清除逻辑：复用 `analyze()` 函数的 repo path 确定策略
   - 优先级：Git root → Workspace root → Start path

**使用方法：**
```bash
# 清除依赖分析缓存
npx tsx src/cli.ts call --clear-cache

# 查看详细日志
npx tsx src/cli.ts call --clear-cache --log-level=info
```

**影响：**
- ✅ 用户可以方便地清除缓存
- ✅ 调试依赖分析器时更方便
- ✅ 与 `index`/`outline` 命令的 `--clear-cache` 保持一致

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
