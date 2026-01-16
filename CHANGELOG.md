# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-01-16

### ⚠️ Breaking Changes

**CLI 重构为子命令模式**

CLI 从基于选项的模式（`--command`）重构为子命令模式（`command`），类似 git/npm 风格。

#### 命令映射

| 旧命令 | 新命令 |
|--------|--------|
| `--search="query"` | `search "query"` |
| `--index` | `index` |
| `--serve` | `index --serve` |
| `--clear` | `index --clear-cache` |
| `--outline "pattern"` | `outline "pattern"` |
| `--clear-summarize-cache` | `outline --clear-cache` |
| `--stdio-adapter` | `stdio` |
| `--get-config` | `config --get` |
| `--set-config` | `config --set` |

**注意**：不再支持旧命令格式，必须使用新的子命令语法。

### Added

- **子命令系统**：新增 `search`、`index`、`outline`、`stdio`、`config` 子命令
- **配置命令**：`config --get` 和 `config --set` 支持层级化配置管理
- **更好的帮助系统**：每个子命令都有详细的 `--help` 文档

### Changed

- **CLI 架构**：使用 commander.js 替代 Node.js native parseArgs
- **命令组织**：
  - `--serve` 合并到 `index --serve`
  - `--clear` 重命名为 `index --clear-cache`
  - `--clear-summarize-cache` 重命名为 `outline --clear-cache`
  - `--get-config` 改为 `config --get`
  - `--set-config` 改为 `config --set`

### Removed

- 移除旧的 `--` 选项风格命令支持

### Fixed

- 修复 data-flow-analyzer.ts 中的 TypeScript 类型错误

### Documentation

- 更新 CLAUDE.md 以反映新的子命令结构
- 添加 MIGRATION.md 迁移指南
- 更新所有命令示例

## [0.0.7] - 2026-01-14

### Added

- 多语言依赖分析器，支持图分析功能
- 改进命名空间成员调用解析

### Fixed

- 修复嵌套成员表达式解析
- 优化依赖分析的准确性

## [0.0.6] - Previous releases

Earlier versions not documented in this changelog.

---

## Migration Notes

### From v1.x to v2.0.0

**Quick Migration**: 大部分情况下，只需将 `--command` 改为 `command`！

**Example**:
```bash
# Before (v1.x)
codebase --search="user auth" --limit=20

# After (v2.0.0)
codebase search "user auth" --limit=20
```

See [MIGRATION.md](./MIGRATION.md) for detailed migration guide.

## Support

- **Issues**: [GitHub Issues](https://github.com/your-org/autodev-codebase/issues)
- **Documentation**: [CLAUDE.md](./CLAUDE.md)
- **Migration Guide**: [MIGRATION.md](./MIGRATION.md)
