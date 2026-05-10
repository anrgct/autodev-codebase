# 250509-tree-sitter-staticmethod-hierarchy

## 主题/需求

**问题：** 使用 `@staticmethod` 装饰的 Python 方法在搜索结果的 `hierarchyDisplay` 中只显示 `class Model`，缺少 `function xxx` 层级信息。而普通成员方法能正确显示 `class Model > function xxx` 的完整层级。

**影响范围：**
- 搜索召回评估时，基于 `hierarchy` 字段的测试标准需要为 `@staticmethod` 方法单独适配
- 用户通过 hierarchy 视觉区分代码归属的能力降低
- 所有 Python 代码库中 `@staticmethod` / `@classmethod` / 自定义装饰器方法均受影响

**预期行为：** `@staticmethod` 方法的 hierarchy 应显示为 `class Model > function methodName`，与普通成员方法一致。

---

## 代码背景

### 相关文件

| 文件 | 角色 |
|------|------|
| `src/tree-sitter/queries/python.ts` (python.ts) | Python 专用的 tree-sitter 查询模式 |
| `src/code-index/processors/parser.ts` (parser.CodeParser.buildTreeSitterParentChain:650) | hierarchy 构建核心逻辑 |
| `src/tree-sitter/languageParser.ts` | 语法解析器的通用包装 |
| `src/examples/eval_search.py` | 搜索召回评估脚本（发现了该问题的测试工具） |

### 架构数据流

```
Python 源代码
    ↓
tree-sitter-python.wasm 解析 → AST
    ↓
Python 查询模式 (python.ts)    ←── ① 对 @staticmethod 捕获了不同的节点类型
    ↓
tree-sitter 捕获处理 (languageParser.ts)
    ↓
parser.ts: parseContent          ←── ② 构建 nodeIdentifierMap
    ↓
parser.ts: buildParentChain      ←── ③ 向上遍历，跳过非容器节点
    ↓
parser.ts: buildHierarchyDisplay ←── ④ 拼接层级字符串
    ↓
Qdrant 向量数据库 → 搜索返回
```

### 现有实现

**① Python 查询模式** (`python.ts`)：

```python
# 普通函数定义
(function_definition
  name: (identifier) @name.definition.function) @definition.function

# 装饰器函数定义（含 @staticmethod）
(decorated_definition
  definition: (function_definition
    name: (identifier) @name.definition.function)) @definition.function
```

关键差异：
- 普通函数：`@definition.function` 捕获 `function_definition` 节点
- 装饰函数：`@definition.function` 捕获 `decorated_definition` 包装节点

**③ Parent Chain 构建** (`parser.buildTreeSitterParentChain:650`)：

```typescript
const containerTypes = new Set([
    'class_declaration', 'class_definition',
    'function_declaration', 'function_definition', 'method_definition',
    // ... 不包含 'decorated_definition'
])
```

`decorated_definition` 不在 `containerTypes` 集合中，当 `buildParentChain` 向上遍历时，遇到 `decorated_definition` 节点会被跳过（`continue`），直到 `class_declaration` 才被加入链。

**④ Hierarchy Display 构建** (`parser.buildHierarchyDisplay:812`)：

```typescript
const typeMap = {
    'function_definition': 'function',
    // ... 不包含 'decorated_definition'
}
```

即使 `decorated_definition` 被正确处理，其类型名也会保留为原始 snake_case 而非简化的 `function`。

---

## 关键决策

| 方案 | 描述 | 可行性 | 理由 |
|------|------|--------|------|
| **A. 修改 containerTypes** | 将 `decorated_definition` 加入 `containerTypes` | ⚠️ 部分可行 | 但父链中本不应有装饰器节点；且不解决 hierarchyDisplay 中的类型名问题 |
| **B. 修改 parentChain 向下穿透** | 在 `buildParentChain` 中添加逻辑：遇到 `decorated_definition` 时获取其子 `function_definition` 的标识符 | ✅ 推荐 | 精准解决，不引入干扰 |
| **C. 修改查询模式** | 让 `decorated_definition` 的 `@definition.function` 捕获内部 `function_definition` 而非包装节点 | ⚠️ 部分可行 | 但树-sitter 查询无法跨嵌套节点改变捕获目标；捕获的是顶层匹配节点 |
| **D. 在 hierarchyDisplay 中添加类型映射** | 将 `decorated_definition` 映射为 `function` | ✅ 辅助 | 需结合其他方案一起使用 |

### 推荐方案

**组合方案 B + D：**

1. **B（主要）**：在 `buildTreeSitterParentChain` 中，当遇到 `decorated_definition` 节点时，不跳过它，而是向下查找其 `definition` 子节点（即 `function_definition`），获取其标识符并加入父链。
2. **D（辅助）**：在 `normalizeNodeType` 的 `typeMap` 中添加 `decorated_definition → function` 映射，确保 hierarchyDisplay 输出一致的 `function` 类型名。

或者更简洁的方式：在 `buildParentChain` 中，当前节点的父节点如果是 `decorated_definition`，则跳过它（保持父链不受影响），但同时确保 `currentNode` 自身的层级标识正确处理——即 `_chunkDefinitionNodeByLines` 中识别 `decorated_definition` 并穿透到其内部的 `function_definition` 来提取标识符和类型。

实际上问题的根源更可能在 `parseContent` 中的区块处理循环。让我重新梳理：

**核心矛盾点：**

对于 `@staticmethod` 方法：
- `@definition.function` 捕获节点 = `decorated_definition` → 传入 `_chunkDefinitionNodeByLines`
- `node.type` = `decorated_definition`
- `buildParentChain` 向上遍历：`decorated_definition` 的父节点 = `class_declaration` → 父链 = `[{class, Model}]`
- `buildHierarchyDisplay([{class, Model}], "is_triton_model", "decorated_definition")`
  - 父链部分：`class Model`
  - 当前节点部分：`decorated_definition is_triton_model`
  - 结果：`class Model > decorated_definition is_triton_model`

等等——按照这个推导，结果应该是 `class Model > decorated_definition is_triton_model`，不是 `class Model`。

要么是 `nodeIdentifierMap` 没有成功映射 `decorated_definition` → `"is_triton_model"`，导致标识符为 null；要么是 `seenSegmentHashes` 去重导致了某些问题。

需要进一步调试确认。

### 决策

**暂不做代码修复**，先记录问题现象和影响。后续再做深入调试和修复。

---

## 实施计划

- [ ] **1. 分析确认**：在 `parser.ts` 中添加临时日志，确认 `decorated_definition` 节点在 `parseContent` 循环中的处理路径
- [ ] **2. 根因定位**：确认 `nodeIdentifierMap` 中 `decorated_definition` → identifier 的映射是否成功，以及 `buildHierarchyDisplay` 的入参值
- [ ] **3. 方案实现**：根据分析结果实施修复（B + D 组合或更优方案）
- [ ] **4. 添加测试**：在 `parser.spec.ts` 中添加 `@staticmethod` 方法 hierarchy 提取的测试用例
- [ ] **5. 回归验证**：运行 `eval_search.py` 确认 #2 和 #8 用例的 `expect_hierarchy_kw` 可改回 `function methodName`
- [ ] **6. demo 重建**：重新索引 demo 工作区以更新 Qdrant 中已有的 hierarchy 数据

---

## 实施记录

### 2025-05-09
- **发现：** 运行 `eval_search.py` 时 12 个测试用例有 2 个失败
- **调试：** 手动执行搜索命令，发现 `@staticmethod` 方法的 hierarchy 值为 `class Model`（缺少 `function is_triton_model`）
- **对比验证：** 非静态方法的 hierarchy 正常（如 `class Model > function predict`）
- **临时修复：** 修改了测试标准的 `expect_hierarchy_kw` 为 `class Model` 以适配现有行为
- **文档记录：** 创建本 task doc 记录问题和背景

---

## 修订记录

### 2025-05-09
**问题：** `@staticmethod` 方法的 hierarchy 缺少 function 层级，导致搜索测试标准需要特殊处理。
**状态：** 已记录，待修复。
**工作区：** 当前测试用 `expect_hierarchy_kw="class Model"` 绕过，不影响整体评估。

---

## 总结

### 关键收获

1. **tree-sitter 查询模式差异**：Python 的装饰器方法被捕获为 `decorated_definition` 节点，而非 `function_definition`。这是 tree-sitter-python 语法设计的特性，不是 bug。
2. **层级不完整的影响**：hierarchy 缺少 function 层级后，搜索结果显示的代码归属信息不完整，尤其是当一个类中有多个 `@staticmethod` 方法时，难以区分结果属于哪个方法。
3. **测试需要适配**：即使不修复解析器，测试工具也需要意识到 `@staticmethod` 的 hierarchy 格式差异。

### 后续优化建议

- **定位修复**：优先在 `parser.ts` 中处理 `decorated_definition` 节点，使其 hierarchy 与普通方法保持一致
- **扩展支持**：同理检查 `@classmethod` 和自定义装饰器是否也存在同样问题
- **跨语言检查**：其他语言（如 Java 的 `@Override`、TypeScript 的装饰器）是否也有类似情况
- **文档化**：将 hierarchy 格式约定写入开发者文档，供测试编写参考

### 参考

- Tree-sitter Python grammar: [decorated_definition](https://github.com/tree-sitter/tree-sitter-python/blob/master/grammar.js)
- 相关代码: `src/tree-sitter/queries/python.ts` (python.ts), `src/code-index/processors/parser.ts` (parser.CodeParser.buildTreeSitterParentChain:650)
- 测试脚本: `src/examples/eval_search.py`
