# Migration Guide: v0.x → v1.0.0

## 概述

v1.0.0 引入了新的子命令结构（类似 git/npm 风格），替代了旧的 `--` 选项风格。

**⚠️ 重要提示：v1.0.0 不支持旧命令格式，这是一个破坏性更新。**

## 核心变更

### CLI 命令结构

**旧版 (v0.x)**：使用 `--` 选项作为命令
```bash
codebase --search="query"
codebase --index
codebase --serve
```

**新版 (v1.0.0)**：使用子命令模式
```bash
codebase search "query"
codebase index
codebase index --serve
```

## 完整命令映射

| 旧命令 (v0.x) | 新命令 (v1.0.0) | 说明 |
|---------------|-----------------|------|
| `--search="query"` | `search "query"` | 语义搜索 |
| `--index` | `index` | 索引代码库 |
| `--serve` | `index --serve` | 启动 MCP 服务器 |
| `--index --watch` | `index --watch` | 监听模式 |
| `--clear` | `index --clear-cache` | 清除索引缓存 |
| `--outline "pattern"` | `outline "pattern"` | 代码大纲 |
| `--clear-summarize-cache` | `outline --clear-cache` | 清除摘要缓存 |
| `--stdio-adapter` | `stdio` | stdio 适配器 |
| `--get-config` | `config --get` | 查看配置 |
| `--set-config` | `config --set` | 设置配置 |

## 详细迁移示例

### 1. 搜索命令

```bash
# 旧版
codebase --search="user authentication" --limit=20
codebase --search="database" --path-filters="src/**/*.ts"

# 新版
codebase search "user authentication" --limit=20
codebase search "database" --path-filters="src/**/*.ts"
```

### 2. 索引命令

```bash
# 旧版
codebase --index --path=. --force
codebase --index --dry-run

# 新版
codebase index --path=. --force
codebase index --dry-run
```

### 3. MCP 服务器

```bash
# 旧版
codebase --serve --port=3001 --path=.

# 新版
codebase index --serve --port=3001 --path=.
```

**逻辑变更**：`--serve` 现在是 `index` 命令的选项，因为服务器启动时会自动进行索引。

### 4. 清除缓存

```bash
# 旧版
codebase --clear
codebase --clear-summarize-cache

# 新版
codebase index --clear-cache
codebase outline --clear-cache
```

**逻辑变更**：清除操作现在是相应命令的选项，更符合操作的语义。

### 5. 代码大纲

```bash
# 旧版
codebase --outline "src/**/*.ts"
codebase --outline "src/**/*.ts" --summarize

# 新版
codebase outline "src/**/*.ts"
codebase outline "src/**/*.ts" --summarize
```

### 6. stdio 适配器

```bash
# 旧版
codebase --stdio-adapter --server-url=http://localhost:3001/mcp

# 新版
codebase stdio --server-url=http://localhost:3001/mcp
```

### 7. 配置管理

```bash
# 旧版
codebase --get-config
codebase --get-config embedderProvider
codebase --set-config embedderProvider=ollama
codebase --set-config --global key=value

# 新版
codebase config --get
codebase config --get embedderProvider
codebase config --set embedderProvider=ollama
codebase config --set --global key=value
```

## 破坏性变更

### 不支持旧命令

v1.0.0 **完全移除**了旧的命令格式支持。运行旧命令会直接报错：

```bash
$ codebase --search="user auth"
error: unknown option '--search="user auth"'
```

**必须使用新语法**：

```bash
$ codebase search "user auth"
Found 5 results in 3 files for: "user auth"
...
```

## 脚本迁移

如果你在脚本中使用了 codebase 命令，建议尽快更新：

**自动化脚本示例**

```bash
# 旧版脚本
#!/bin/bash
codebase --index --path=/my/project
codebase --search="TODO" --json > results.json

# 新版脚本
#!/bin/bash
codebase index --path=/my/project
codebase search "TODO" --json > results.json
```

## CI/CD 集成

如果你在 CI/CD 流程中使用 codebase，请更新配置：

**GitHub Actions 示例**

```yaml
# 旧版
- name: Index codebase
  run: codebase --index --force

# 新版
- name: Index codebase
  run: codebase index --force
```

## 优势

新的子命令结构带来以下改进：

1. **更清晰的命令层级**
   - `index` 命令统一管理索引、监听、服务器、清理
   - 命令关系更直观

2. **符合主流工具习惯**
   - 类似 git、npm、docker 的子命令模式
   - 降低学习成本

3. **更易扩展**
   - 新增子命令不会与选项冲突
   - 支持多层次的命令组织

4. **更好的帮助系统**
   - `codebase --help` 显示所有子命令
   - `codebase <subcommand> --help` 显示子命令详情

## 需要帮助？

- 查看 [CLAUDE.md](./CLAUDE.md) 了解新命令的完整文档
- 运行 `codebase --help` 查看所有可用命令
- 运行 `codebase <subcommand> --help` 查看特定子命令的帮助

## 总结

迁移步骤：

1. ✅ 查看上述命令映射表
2. ✅ 更新脚本和 CI/CD 配置
3. ✅ 测试新命令是否正常工作
4. ✅ 升级到 v1.0.0

**关键原则**：大部分情况下，只需将 `--command` 改为 `command` 即可！

**注意**：v1.0.0 不支持旧命令，请在升级前完成所有脚本和配置的更新。
