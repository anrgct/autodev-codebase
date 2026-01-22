# src/cli.ts (41 lines)
└─ 定义CLI入口程序，使用commander.js创建子命令模式，整合搜索、索引、大纲等工具功能，提供命令行接口。

---

# src/index.ts (14 lines)
└─ 导出库中所有核心模块，包括代码索引、抽象层、Node.js适配器、全局处理、搜索功能、Tree-sitter集成、代码库实现和依赖管理。

---

# src/abstractions/config.ts (52 lines)
└─ 配置类型从接口文件重新导出，定义配置提供者抽象接口，获取配置并监听变更，支持多种嵌入器配置

---

# src/abstractions/core.ts (117 lines)
└─ 定义跨平台文件系统操作的核心接口，提供读写、检查、统计、目录管理等基础功能。定义存储操作、事件系统、日志记录、文件监控等核心抽象接口。整合所有平台依赖项，提供统一的基础设施接口。

---

# src/abstractions/index.ts (35 lines)
└─ 导出平台无关核心抽象，包括文件系统、存储、事件总线、日志、文件监听等接口，提供跨平台基础功能抽象

---

# src/abstractions/workspace.ts (105 lines)
└─ 定义平台无关的 workspace 抽象接口，提供根路径管理、忽略规则处理、文件查找等核心功能，支持多根工作区和路径工具操作。

---

# src/cli-tools/data-flow-analyzer.ts (698 lines)
└─ 定义数据流节点和边的数据结构，用于存储函数、类等组件及其调用关系。实现数据流分析器的核心逻辑，递归追踪组件调用链，生成可视化文本树和JSON结果。识别CLI和MCP入口点，分析核心组件创建和调用关系。

---

# src/cli-tools/outline-targets.ts (119 lines)
└─ 解析代码大纲目标，支持文件路径和glob模式，处理忽略规则和目录展开。

---

# src/cli-tools/outline.ts (952 lines)
└─ CLI工具：代码大纲提取器，使用tree-sitter解析源文件结构，支持文本和JSON格式输出及AI摘要功能。

---

# src/cli-tools/summary-cache.ts (670 lines)
└─ 实现AI代码摘要缓存管理器，使用两级哈希机制避免冗余LLM调用，支持文件级和代码块级缓存检测，提供缓存加载、更新、清理等功能。

---

# src/code-index/cache-manager.ts (138 lines)
└─ 实现代码索引缓存管理，支持文件哈希存储、异步保存、缓存清理和批量操作，使用防抖优化性能。

---

# src/code-index/config-manager.ts (530 lines)
└─ 管理代码索引配置，处理加载、验证和重启检测，支持多种嵌入器和重排序器配置。

---

# src/code-index/config-validator.ts (434 lines)
└─ 配置验证器类，验证嵌入器、Qdrant、重排序器和摘要器配置，确保参数完整性和数值范围正确。

---

# src/code-index/i18n.ts (28 lines)
└─ 定义国际化翻译字典，支持多语言错误消息模板，提供参数化字符串替换功能。

---

# src/code-index/index.ts (29 lines)
└─ 导出代码索引核心功能模块，包括管理器、配置、缓存、状态、编排、搜索、服务工厂、接口、嵌入器、处理器、向量存储、常量和工具函数。

---

# src/code-index/manager.ts (535 lines)
└─ 实现代码索引管理器的核心类，负责初始化配置、管理状态、协调搜索和索引服务，提供错误恢复和资源清理功能。

---

# src/code-index/orchestrator.ts (438 lines)
└─ 管理代码索引工作流，协调文件监控、状态管理和向量存储服务，处理增量扫描和全量索引逻辑。

---

# src/code-index/search-service.ts (108 lines)
└─ 实现代码索引搜索服务，处理查询嵌入、向量搜索和重排序，支持配置验证和错误状态管理。

---

# src/code-index/service-factory.ts (353 lines)
└─ 代码索引服务工厂类，负责创建和配置嵌入器、向量存储、目录扫描器等组件，支持多种AI服务提供商

---

# src/code-index/state-manager.ts (126 lines)
└─ 管理代码索引状态，支持四种状态转换，通过事件总线更新进度信息，处理块和文件级别的索引进度报告。

---

# src/code-index/validate-search-params.ts (43 lines)
└─ 验证搜索参数的limit和minScore，确保数值合法且在配置范围内，提供默认值和边界处理。

---

# src/commands/call.ts (533 lines)
└─ 实现代码依赖分析命令，支持总结显示、数据导出、图形可视化和依赖查询功能。

---

# src/commands/index.ts (412 lines)
└─ 实现代码库索引命令，支持多种模式：正常索引、预览分析、清理缓存、启动MCP服务器和监控文件变化。

---

# src/commands/outline.ts (195 lines)
└─ 实现outline命令，处理文件路径或通配符模式，提取代码大纲，支持AI摘要和缓存管理

---

# src/commands/search.ts (303 lines)
└─ 实现代码搜索命令，支持语义搜索、结果格式化、路径过滤和JSON输出

---

# src/commands/shared.ts (187 lines)
└─ 定义CLI命令的共享工具和类型，包括日志管理、路径解析、依赖创建、演示文件处理和代码索引管理器初始化等功能。

---

# src/commands/stdio.ts (59 lines)
└─ stdio命令实现，创建stdio适配器桥接stdio与HTTP MCP服务器，处理信号关闭，支持超时配置和日志级别设置

---

# src/dependency/cache-manager.ts (420 lines)
└─ 实现依赖分析缓存管理器，持久化存储文件分析结果，通过SHA-256哈希验证文件变化，配置指纹确保版本一致性，使用防抖机制优化磁盘写入。

---

# src/dependency/cache-types.ts (117 lines)
└─ 定义依赖分析缓存的数据结构，包括配置指纹、序列化节点、文件缓存条目、完整缓存结构、缓存统计和缓存限制配置，用于存储和管理代码依赖分析结果。

---

# src/dependency/graph.ts (394 lines)
└─ 实现依赖图构建与分析，包括ID解析、模块距离计算、智能边解析、环检测和拓扑排序等核心功能。

---

# src/dependency/index.ts (518 lines)
└─ 导出依赖分析核心接口和工具函数，包含语言映射、缓存管理、图构建和可视化数据生成功能

---

# src/dependency/models.ts (207 lines)
└─ 定义依赖分析的核心数据结构，包括节点、边、结果统计等接口，用于表示代码元素及其依赖关系

---

# src/dependency/parse.ts (399 lines)
└─ 解析器管理模块，提供文件解析、语言配置和缓存功能，支持多种编程语言的语法树分析

---

# src/dependency/query.ts (586 lines)
└─ 实现依赖查询核心功能：模式匹配、双向树构建、连接分析、格式化输出，支持通配符搜索和深度限制

---

# src/glob/index.ts (2 lines)
└─ 导出文件列表工具模块，提供文件操作相关功能

---

# src/glob/list-files.ts (123 lines)
└─ 实现文件列表功能，使用fast-glob高效遍历目录，结合统一忽略服务过滤文件，限制返回数量，处理特殊目录。

---

# src/examples/create-sample-files.ts (1330 lines)
└─ 创建示例文件函数，生成包含JavaScript、Python、Markdown、JSON和多个代码文件的完整项目结构，用于演示Autodev代码库索引系统的功能。

---

# src/examples/demo-sse-mcp-server.ts (64 lines)
└─ 创建MCP服务器实例，注册加法工具，通过Express和SSE实现通信接口

---

# src/examples/embedding-test-simple.ts (254 lines)
└─ 测试向量嵌入模型性能，模拟npm包数据，计算precision指标并分析查询效果

---

# src/examples/memory-vector-search.ts (239 lines)
└─ 实现内存向量搜索类，支持多种嵌入模型，提供文档添加、相似度搜索和批量处理功能

---

# src/examples/nodejs-usage.ts (245 lines)
└─ Node.js环境下的代码库使用示例，包含基础配置、高级设置、文件操作、事件系统、文件监控、代码索引管理器集成、测试工具和CLI命令行工具的实现。

---

# src/examples/run-demo.ts (244 lines)
└─ 演示脚本监控本地demo文件夹，使用Ollama嵌入和Qdrant向量存储索引代码，展示Node.js环境下的代码库库使用方法。

---

# src/examples/run-dependency-analyzer.ts (237 lines)
└─ 初始化文件系统适配器与路径工具，配置依赖分析器依赖项，准备执行依赖分析流程

---

# src/examples/run-example.ts (25 lines)
└─ 根据命令行参数选择并执行不同的示例代码，包括基础、高级和CLI三种模式

---

# src/examples/simple-demo.ts (104 lines)
└─ 演示脚本创建Node.js依赖，初始化配置，测试文件系统操作，展示基础功能无需外部服务

---

# src/examples/test-embedding.ts (37 lines)
└─ 测试Ollama嵌入功能，创建嵌入器并验证文本嵌入结果

---

# src/examples/test-full-parsing.ts (52 lines)
└─ 测试完整解析流程，加载语言解析器，创建代码解析器，逐个解析测试文件并输出结果

---

# src/examples/test-model-dimension.ts (29 lines)
└─ 测试模型维度函数，验证不同提供商和模型的嵌入维度输出

---

# src/examples/test-parser.ts (31 lines)
└─ 测试解析器加载功能，验证多语言文件解析器初始化与异常处理

---

# src/examples/test-scanner.ts (37 lines)
└─ 测试脚本验证p-limit库的导入和并发控制功能，通过限制并发任务数量确保系统稳定性

---

# src/ignore/IgnoreService.ts (191 lines)
└─ 实现统一忽略服务，提供gitignore语义文件过滤，支持目录跳过和文件忽略功能

---

# src/ignore/default-dirs.ts (31 lines)
└─ 定义全局忽略目录列表，统一版本控制、依赖、构建及缓存目录的过滤规则，支持 ripgrep 隐藏目录通配符

---

# src/lib/codebase.ts (4 lines)
└─ 导出函数返回固定字符串'codebase'，作为代码库标识符

---

# src/mcp/http-server.ts (752 lines)
└─ 实现基于Express的MCP HTTP服务器，提供代码搜索和结构提取工具，支持会话管理和优雅关闭。

---

# src/mcp/stdio-adapter.ts (418 lines)
└─ 实现stdio到HTTP MCP服务器的适配器，处理JSON-RPC消息转发和SSE连接管理

---

# src/ripgrep/index.ts (312 lines)
└─ 封装ripgrep搜索功能，提供跨平台文件正则搜索，支持上下文显示和结果格式化。

---

# src/search/file-search.ts (177 lines)
└─ 使用ripgrep实现文件搜索功能，支持文件和目录查找，集成fzf进行模糊匹配，提供高效的文件系统搜索能力。

---

# src/search/index.ts (2 lines)
└─ 导出文件搜索功能模块，提供文件搜索相关接口

---

# src/shared/api.ts (10 lines)
└─ 定义API处理器选项和基础接口，支持OpenAI和Ollama配置，提供灵活的键值扩展

---

# src/shared/embeddingModels.ts (196 lines)
└─ 定义嵌入模型配置文件，包含不同提供商和模型的维度信息，提供获取模型维度、默认模型ID、查询前缀和相似度阈值的函数。

---

# src/shared/index.ts (2 lines)
└─ 导出共享模块的API和嵌入模型，提供统一入口点

---

# src/tools/file-chunker-cli.ts (271 lines)
└─ 实现文件切块命令行工具，支持多种输出格式和切块策略，提供文件查找和信息查询功能。

---

# src/tools/file-chunker.ts (249 lines)
└─ 实现文件切块工具类，支持tree-sitter解析、批量处理文件，生成带哈希的代码块结构。

---

# src/tools/test-tree-sitter.ts (201 lines)
└─ 测试Tree-sitter解析器的工具脚本，支持解析代码定义和输出JSON格式的捕获详情，提供命令行接口和错误处理。

---

# src/types/vitest.d.ts (140 lines)
└─ 定义Vitest测试框架的全局类型声明，提供describe、it、expect等测试函数的类型支持，并添加Jest兼容性方法。

---

# src/tree-sitter/index.ts (453 lines)
└─ 使用tree-sitter解析代码文件，提取函数、类等定义，支持多种编程语言和Markdown文件，提供代码结构化视图。

---

# src/tree-sitter/languageParser.ts (247 lines)
└─ 定义语言解析器接口，加载Tree-sitter WASM模块，初始化解析器，根据文件扩展名加载对应语言的语法解析器和查询规则，支持多种编程语言的语法树解析

---

# src/tree-sitter/markdownParser.ts (217 lines)
└─ 解析Markdown文件，提取标题和章节行范围，生成与tree-sitter兼容的模拟捕获数据。

---

# src/tree-sitter/wasm-loader.ts (116 lines)
└─ 提供统一的 WASM 文件路径解析功能，支持开发与生产环境切换，并创建用于 web-tree-sitter 的 locateFile 函数。

---

# src/utils/config-provider.ts (154 lines)
└─ 配置提供者实现类，支持从环境变量和配置文件读取配置，提供全局状态和密钥管理功能，包含单例模式实现。

---

# src/utils/events.ts (95 lines)
└─ 实现基于Node.js EventEmitter的事件总线，支持订阅、发布、一次性订阅和全局单例实例管理

---

# src/utils/filesystem.ts (118 lines)
└─ 封装fs/promises API，提供文件读写、目录操作、文件检查等工具函数，支持二进制和文本内容处理，自动创建父目录，递归删除和移动文件。

---

# src/utils/fs.ts (68 lines)
└─ 创建文件所需目录，递归构建缺失路径并返回新目录列表。检查路径是否存在，使用异常处理判断文件状态。安全写入JSON数据，自动创建目录并格式化输出。

---

# src/utils/git-global-ignore.ts (221 lines)
└─ 实现Git全局忽略文件管理，确保指定模式被添加到全局排除文件中，支持自动配置和回滚机制。

---

# src/utils/index.ts (56 lines)
└─ 导出文件系统、存储、事件、日志和配置提供程序等工具模块，统一管理各类功能接口。

---

# src/utils/jsonc-helpers.ts (170 lines)
└─ 提供JSONC格式保存功能，保留注释并合并配置，支持错误回退到标准JSON

---

# src/utils/logger.ts (184 lines)
└─ 实现带级别和格式化的控制台日志包装器，支持时间戳、颜色和子日志器

---

# src/utils/path-filters.ts (57 lines)
└─ 解析逗号分隔的路径过滤器，支持大括号扩展，检查全局模式字符

---

# src/utils/path.ts (112 lines)
└─ 实现跨平台路径处理，统一使用正斜杠展示，提供安全路径比较和可读路径转换功能。

---

# src/utils/storage.ts (154 lines)
└─ 实现基于JSON文件的键值存储类，提供异步读写、数据持久化和类型安全操作。

---

# src/adapters/nodejs/config.ts (354 lines)
└─ Node.js配置提供器适配器，实现JSON配置文件管理，支持全局和项目级配置加载、保存、验证及变更通知。

---

# src/adapters/nodejs/event-bus.ts (56 lines)
└─ 实现Node.js事件总线适配器，使用EventEmitter提供事件发布订阅功能，支持监听器管理

---

# src/adapters/nodejs/file-system.ts (84 lines)
└─ 实现Node.js文件系统适配器，提供异步文件读写、目录操作和状态查询功能，支持递归创建目录和递归删除操作。

---

# src/adapters/nodejs/file-watcher.ts (88 lines)
└─ 实现Node.js文件监视器，使用fs.watch API监听文件和目录变化，提供事件回调和清理功能

---

# src/adapters/nodejs/index.ts (94 lines)
└─ 导出Node.js适配器模块，提供文件系统、存储、事件总线、日志、文件监视、工作区和配置功能。创建工厂函数生成平台依赖项，确保全局配置目录存在，初始化各种服务组件。提供简化工厂函数用于基本使用场景。

---

# src/adapters/nodejs/logger.ts (105 lines)
└─ 实现Node.js日志适配器，支持多级别日志输出、时间戳、颜色格式化，通过控制台输出日志信息

---

# src/adapters/nodejs/storage.ts (57 lines)
└─ Node.js存储适配器实现文件系统缓存管理，提供全局存储路径和缓存路径生成功能，支持工作区路径哈希处理。

---

# src/adapters/nodejs/workspace.ts (193 lines)
└─ Node.js工作区适配器实现，提供文件系统操作和忽略规则处理，支持工作区管理和路径工具功能。

---

# src/code-index/constants/index.ts (114 lines)
└─ 定义代码索引默认配置、搜索参数、文件处理限制、批处理策略和嵌入器参数，提供动态批处理大小计算功能，支持截断降级和功能开关控制。

---

# src/code-index/constants/search-config.ts (25 lines)
└─ 定义搜索配置常量，包含分页限制和最小分数阈值，确保搜索参数在合理范围内。

---

# src/code-index/embedders/gemini.ts (89 lines)
└─ 封装Gemini嵌入API，继承OpenAI兼容接口，支持模型配置和批量嵌入生成。

---

# src/code-index/embedders/jina-embedder.ts (223 lines)
└─ 实现Jina AI嵌入器，支持批量处理、重试机制和配置验证，用于文本向量转换

---

# src/code-index/embedders/mistral.ts (88 lines)
└─ 实现Mistral嵌入器，封装OpenAI兼容接口，支持codestral-embed-2505模型，提供文本嵌入和配置验证功能。

---

# src/code-index/embedders/ollama.ts (385 lines)
└─ 实现Ollama本地嵌入服务，支持批量文本嵌入、重试机制、代理配置和模型验证

---

# src/code-index/embedders/openai-compatible.ts (522 lines)
└─ 实现OpenAI兼容的嵌入服务，支持批量处理、速率限制和代理配置，提供文本向量化功能。

---

# src/code-index/embedders/openai.ts (261 lines)
└─ 实现OpenAI嵌入器接口，支持批量处理、重试机制和代理配置，处理文本嵌入生成和错误管理。

---

# src/code-index/embedders/openrouter.ts (380 lines)
└─ 实现OpenRouter嵌入器，支持批量处理、速率限制和重试机制，使用OpenAI兼容API生成文本向量表示。

---

# src/code-index/embedders/vercel-ai-gateway.ts (97 lines)
└─ 实现Vercel AI Gateway嵌入器，封装OpenAI兼容接口，支持多种模型配置和验证

---

# src/code-index/interfaces/cache.ts (38 lines)
└─ 定义缓存管理器接口，提供初始化、清空、获取、更新和删除文件哈希的功能，用于文件变更检测和缓存管理。

---

# src/code-index/interfaces/config.ts (302 lines)
└─ 定义代码索引配置接口，支持多种嵌入模型和向量存储，包含重排序和摘要功能配置。

---

# src/code-index/interfaces/embedder.ts (49 lines)
└─ 定义代码索引嵌入器接口，提供创建嵌入、验证配置和获取嵌入器信息的功能，支持多种嵌入服务实现。

---

# src/code-index/interfaces/file-processor.ts (147 lines)
└─ 定义代码文件解析、目录扫描和文件监听的核心接口，提供代码块处理、批量操作和进度跟踪功能，支持多种文件处理策略和错误处理机制。

---

# src/code-index/interfaces/index.ts (7 lines)
└─ 导出模块接口，包含嵌入器、向量存储、文件处理器、管理器、重排序器和摘要器的全部功能

---

# src/code-index/interfaces/manager.ts (92 lines)
└─ 定义代码索引管理器接口，提供索引配置、启动、搜索和状态管理功能，支持多种嵌入模型提供商。

---

# src/code-index/interfaces/reranker.ts (56 lines)
└─ 定义代码索引重排序器接口，包含候选结果、重排序结果、配置信息和核心重排序方法，支持多种AI服务提供商和并发控制

---

# src/code-index/interfaces/summarizer.ts (232 lines)
└─ 定义代码摘要生成器的核心接口，包括请求、结果、配置和批量处理结构，支持多种AI服务提供商

---

# src/code-index/interfaces/vector-store.ts (103 lines)
└─ 定义向量数据库客户端接口，提供初始化、向量搜索、数据管理等功能，支持代码片段的索引和检索。

---

# src/code-index/processors/batch-processor.ts (496 lines)
└─ 批量处理器类，实现文件删除、嵌入生成、向量存储和缓存更新，支持重试和截断回退机制。

---

# src/code-index/processors/file-watcher.ts (574 lines)
└─ 实现了文件监控与批量处理机制，监听文件变化事件，解析代码块并嵌入向量存储

---

# src/code-index/processors/index.ts (4 lines)
└─ 导出解析器、扫描器和文件监视器模块，统一索引处理功能入口

---

# src/code-index/processors/parser.ts (1059 lines)
└─ 实现代码解析器，支持多种语言和Markdown文件，使用Tree-sitter进行语法分析，将代码块分割为语义单元并构建父子关系链。

---

# src/code-index/processors/scanner.ts (458 lines)
└─ 代码目录扫描器，过滤支持文件并并行处理代码块，生成嵌入向量存储到向量数据库。

---

# src/code-index/rerankers/index.ts (3 lines)
└─ 导出ollama和openai兼容模块的索引文件，统一暴露外部接口

---

# src/code-index/rerankers/ollama.ts (495 lines)

---

# src/code-index/rerankers/openai-compatible.ts (575 lines)
└─ 实现了OpenAI兼容API的代码重排序器，支持批量处理、并发控制和重试机制，通过LLM评分对候选结果进行智能排序

---

# src/code-index/shared/block-text-generator.ts (38 lines)
└─ 生成代码块嵌入文本，添加文件路径、标识符和父级链等上下文信息，增强语义搜索准确性

---

# src/code-index/shared/get-relative-path.ts (32 lines)
└─ 生成规范化绝对路径，处理路径解析和标准化，确保跨平台一致性。生成相对文件路径，从绝对路径转换，保证路径分隔符统一。

---

# src/code-index/shared/openai-error-handler.ts (20 lines)
└─ 处理OpenAI API错误，特别是ByteString转换错误，返回格式化错误信息

---

# src/code-index/shared/supported-extensions.ts (35 lines)
└─ 定义文件扩展名处理逻辑，包括扫描器扩展、回退扩展列表及回退分块判断函数，用于确定文件解析策略。

---

# src/code-index/shared/validation-helpers.ts (212 lines)
└─ 提供错误消息清理、HTTP错误处理、状态码映射和验证错误处理的核心功能，确保敏感信息被移除并提供一致的错误响应。

---

# src/code-index/search/query-prefill.ts (37 lines)
└─ 为Qwen3嵌入模型提供查询预填充模板，指导模型生成更好的代码搜索嵌入。仅适用于ollama提供商的qwen3-embedding模型，防止重复预填充并返回处理后的查询。

---

# src/code-index/summarizers/index.ts (3 lines)
└─ 导出Ollama和OpenAI兼容的摘要器模块，提供统一的接口

---

# src/code-index/summarizers/ollama.ts (424 lines)
└─ 实现了基于本地Ollama实例的代码摘要生成器，支持批量处理和代理配置。

---

# src/code-index/summarizers/openai-compatible.ts (403 lines)
└─ 实现了基于OpenAI兼容API的代码摘要生成器，支持批量处理和代理配置，包含JSON提取和超时控制。

---

# src/code-index/vector-store/qdrant-client.ts (817 lines)
└─ 实现了Qdrant向量存储接口，提供向量索引、搜索、删除等功能，支持路径过滤和元数据管理。

---

# src/commands/config/file-loader.ts (88 lines)
└─ 加载配置文件的工具模块，支持全局和项目层级配置的读取与合并，提供默认配置作为基础。

---

# src/commands/config/get.ts (123 lines)
└─ 实现配置获取命令，支持查看默认、全局和项目配置层的详细信息或特定配置项的值。

---

# src/commands/config/index.ts (38 lines)
└─ 配置命令入口，实现配置获取与设置逻辑，支持全局配置和JSON输出，动态加载子命令处理器

---

# src/commands/config/metadata.ts (147 lines)
└─ 定义配置键元数据类型和验证规则，集中管理所有配置项的常量和约束条件，确保配置一致性和正确性。

---

# src/commands/config/parser.ts (146 lines)
└─ 解析配置值并进行类型转换与验证，支持布尔、整数、数字、枚举和字符串类型。解析键值对字符串，验证格式和有效性。

---

# src/commands/config/set.ts (91 lines)
└─ 实现配置设置命令，解析键值对，合并配置，验证并保存到指定路径，同时更新Git全局忽略文件。

---

# src/dependency/analyzers/base.ts (699 lines)
└─ 定义依赖分析抽象基类，提供节点遍历、导入解析、调用关系提取等核心分析能力，支持多语言扩展

---

# src/dependency/analyzers/c.ts (117 lines)
└─ 定义C语言分析器，支持解析函数、结构体和头文件导入，提取标识符并处理内置函数。

---

# src/dependency/analyzers/cpp.ts (57 lines)
└─ 扩展C分析器，支持C++特定语法，处理类、命名空间和函数定义，提取组件类型和名称。

---

# src/dependency/analyzers/csharp.ts (134 lines)
└─ 定义C#分析器，支持解析类、方法、调用和导入语句，提取组件类型和名称映射。

---

# src/dependency/analyzers/go.ts (117 lines)
└─ 定义Go语言分析器，支持解析函数、类型、方法和导入声明，处理全局内置函数和组件类型判断。

---

# src/dependency/analyzers/index.ts (134 lines)
└─ 注册表映射文件扩展名到分析器类，支持多种编程语言，提供获取分析器、检查支持和获取WASM语言名称的功能。

---

# src/dependency/analyzers/java.ts (98 lines)
└─ Java分析器实现，支持类、方法、调用和导入的解析，处理Java语法结构并映射依赖关系。

---

# src/dependency/analyzers/python.ts (150 lines)
└─ 定义Python分析器类，支持解析Python文件，提取函数、类、方法、调用和导入信息，处理全局内置函数和相对导入。

---

# src/dependency/analyzers/rust.ts (112 lines)
└─ 定义Rust语言分析器，支持解析函数、结构体、枚举等类型，处理导入语句和函数调用，提取依赖关系。

---

# src/dependency/analyzers/typescript.ts (265 lines)
└─ 定义 TypeScript/JavaScript 分析器，支持解析函数、类、方法调用和导入语句，识别全局和成员内置函数，处理 TSX 文件扩展名。

---

# src/tree-sitter/queries/c-sharp.ts (66 lines)
└─ 定义C#语言Tree-Sitter查询模式，支持命名空间、类、接口、方法等元素的语义标记和定义识别。

---

# src/tree-sitter/queries/c.ts (91 lines)
└─ 定义C语言语法查询规则，支持函数、结构体、联合体、枚举、类型定义、变量声明和预处理指令的语义标记。

---

# src/tree-sitter/queries/cpp.ts (97 lines)
└─ 定义C++语言结构查询规则，识别类、函数、变量等声明，支持代码分析和导航功能。

---

# src/tree-sitter/queries/css.ts (72 lines)
└─ 定义CSS Tree-Sitter查询模式，匹配规则集、媒体查询、关键帧、变量等元素，支持语义化标记和测试用例验证。

---

# src/tree-sitter/queries/elisp.ts (41 lines)
└─ 定义Emacs Lisp查询模式，捕获函数、宏、自定义变量、面、组和建议的定义名称，排除注释行。

---

# src/tree-sitter/queries/elixir.ts (71 lines)
└─ 定义Elixir语言的Tree-sitter查询规则，识别模块、函数、宏、结构体、守卫、行为回调、字面量、模块属性、测试、管道操作符和for推导式等语法结构。

---

# src/tree-sitter/queries/embedded_template.ts (20 lines)
└─ 定义嵌入式模板查询规则，支持代码块、输出块和注释的语义标记与分类

---

# src/tree-sitter/queries/go.ts (24 lines)
└─ 定义Go语言Tree-Sitter查询模式，捕获包、导入、类型、函数等顶层声明节点。

---

# src/tree-sitter/queries/html.ts (52 lines)
└─ 定义HTML文档结构，包括元素、脚本、样式、属性、注释等语义规则，实现HTML语法的高效解析与分类。

---

# src/tree-sitter/queries/index.ts (29 lines)
└─ 导出多种编程语言的查询模块，包括Solidity、PHP、Vue、TypeScript等，为不同语言提供语法树查询功能。

---

# src/tree-sitter/queries/java.ts (77 lines)
└─ 定义Java语言结构查询模式，包括模块、包、类、接口、枚举、记录、注解、构造器、方法、字段等元素的语义规则，用于代码分析和导航。

---

# src/tree-sitter/queries/javascript.ts (131 lines)
└─ 定义JavaScript语法查询规则，捕获类、方法、函数、装饰器及JSON结构，支持文档注释关联和类型标记。

---

# src/tree-sitter/queries/kotlin.ts (111 lines)
└─ 定义Kotlin语言的各种语法结构查询规则，包括类、接口、函数、对象、属性等声明，通过树查询语法识别并标记不同类型的定义节点。

---

# src/tree-sitter/queries/lua.ts (38 lines)
└─ 定义Lua语言的结构化查询规则，包括函数、表构造器、变量声明和类结构的语义标记，用于代码分析和索引。

---

# src/tree-sitter/queries/ocaml.ts (32 lines)
└─ 定义OCaml语言的Tree-sitter查询规则，捕获模块、类型、函数、类、方法和值绑定等语法结构的定义节点。

---

# src/tree-sitter/queries/php.ts (173 lines)
└─ 定义PHP语言结构查询规则，捕获类、接口、方法、属性等构造，支持代码导航和分析

---

# src/tree-sitter/queries/python.ts (89 lines)
└─ 定义Python语言Tree-sitter查询模式，实现类、函数、lambda表达式、生成器、推导式、with语句、try语句、导入语句、全局/非局部语句、match case语句、类型注解和文档字符串的语义节点捕获。

---

# src/tree-sitter/queries/ruby.ts (205 lines)
└─ 定义Ruby语言语法查询规则，捕获方法、类、模块等结构，支持元编程和现代Ruby特性。

---

# src/tree-sitter/queries/rust.ts (81 lines)
└─ 定义Rust语言结构查询规则，捕获函数、结构体、枚举、特征等所有核心构造的语义节点，用于tree-sitter解析器识别代码定义。

---

# src/tree-sitter/queries/scala.ts (45 lines)
└─ 定义Scala语言语法查询规则，识别类、对象、特征、方法、变量、类型和命名空间的定义节点，用于代码分析和索引。

---

# src/tree-sitter/queries/solidity.ts (45 lines)
└─ 定义Solidity语言的Tree-sitter查询规则，识别合约、函数、变量等语法结构并标记定义类型。

---

# src/tree-sitter/queries/swift.ts (79 lines)
└─ 定义Swift语言树查询模式，捕获类、结构体、协议、扩展、方法、属性、初始化器、下标和类型别名等构造的语义定义。

---

# src/tree-sitter/queries/systemrdl.ts (34 lines)
└─ 定义SystemRDL语法查询规则，识别组件、字段、属性、参数和枚举声明，实现语法树节点标记。

---

# src/tree-sitter/queries/tlaplus.ts (33 lines)
└─ 定义TLA+语言的语法查询规则，包括模块、操作符、函数、变量和常量的声明结构，用于代码分析和语义提取。

---

# src/tree-sitter/queries/toml.ts (25 lines)
└─ 定义TOML语法查询模式，捕获表、键值对、数组等节点，实现语法元素语义识别

---

# src/tree-sitter/queries/tsx.ts (88 lines)
└─ 定义TSX文件中React组件的Tree-sitter查询，包括函数组件、类组件、接口、类型别名、JSX元素和泛型组件的语义规则。

---

# src/tree-sitter/queries/typescript.ts (124 lines)
└─ 定义TypeScript语法查询规则，捕获函数、类、模块、接口等结构，支持测试用例和装饰器识别

---

# src/tree-sitter/queries/vue.ts (30 lines)
└─ 定义Vue组件、模板、脚本和样式的语义查询规则，实现语法树节点的语义标注功能。

---

# src/tree-sitter/queries/zig.ts (22 lines)
└─ 定义Zig语言的Tree-sitter查询规则，识别函数、结构体、枚举和变量声明，实现语法高亮和语义分析。

---

