# src/cli.ts (1616 lines)
└─ 实现了一个简化的CLI工具，提供代码索引、搜索、MCP服务器、配置管理等功能，支持多种运行模式和参数配置。

   25--33 | function initGlobalLogger
   └─ 初始化全局日志记录器，配置名称、级别、时间戳和颜色输出

   43--52 | interface SearchResult
   └─ 定义搜索结果接口，包含文件路径、代码片段、行号和分数信息

   60--160 | function formatSearchResults
   └─ 格式化搜索结果，按文件分组、去重、排序并生成可读输出
   162--238 | function formatSearchResultsAsJson
   └─ 将搜索结果转换为JSON格式，包含去重统计和结构化数据

   241--261 | interface SimpleCliOptions
   └─ 定义CLI选项接口，配置服务器、搜索、索引等参数

   313--460 | function printHelp
   └─ 打印CLI帮助信息，展示所有命令和选项的详细用法
   465--498 | function resolveOptions
   └─ 解析命令行参数，解析路径和配置选项，返回结构化配置对象
   503--522 | function createDependencies
   └─ 创建Node.js依赖项，包括文件系统、存储和配置管理器
   529--571 | function initializeManager
   └─ 初始化代码索引管理器，加载配置并验证，准备索引服务
   576--640 | function startMCPServer
   └─ 启动MCP服务器，处理HTTP连接和后台索引任务，支持优雅关闭
   646--674 | function waitForIndexingCompletion
   └─ 轮询检查索引状态直到完成或失败
   679--708 | function indexCodebase
   └─ 启动代码索引流程并监控进度
   715--748 | function parsePathFilters
   └─ 解析路径过滤器支持花括号扩展
   753--839 | function searchIndex
   └─ 执行代码搜索并处理索引未就绪情况
   844--864 | function clearIndex
   └─ 清理索引数据避免触发后台索引
   869--896 | function clearSummarizeCache
   └─ 清理项目中的所有AI摘要缓存文件
   904--935 | function startStdioAdapter
   └─ 启动stdio适配器桥接MCP客户端与HTTP服务器
   940--945 | function formatValue
   └─ 格式化配置值为字符串表示
   950--971 | function sanitizeConfig
   └─ 过滤敏感配置信息保护密钥安全
   973--976 | function isSensitiveConfigKey
   └─ 检测配置键是否包含敏感关键字
   985--1023 | function printAllConfigLayers
   └─ 打印配置层次结构，显示有效、项目、全局和默认配置
   1028--1048 | function printConfigItemLayers
   └─ 显示特定配置项在各层的值，便于调试配置覆盖
   1053--1141 | function getConfigHandler
   └─ 处理获取配置命令，读取并合并多层配置数据
   1146--1216 | function parseConfigValue
   └─ 解析配置值，验证布尔、数字和枚举类型参数
   1221--1344 | function setConfigHandler
   └─ 设置配置值，验证并保存到指定路径，更新Git忽略
   1356--1543 | function handleOutlineCommand
   └─ 处理代码大纲提取命令，支持glob模式匹配和文件过滤，提供dry-run预览功能
   1548--1612 | function main
   └─ 解析命令行参数并分发到不同功能模块，实现CLI主流程控制

---

# src/index.ts (13 lines)
└─ 导出库的核心模块，包括代码索引、抽象层、Node.js适配器、全局搜索、Tree-Sitter解析和代码库实现。


---

# src/abstractions/config.ts (52 lines)
└─ 定义配置提供者接口，支持获取和监听配置变化，并重新导出配置类型和提供者枚举。

   22--32 | interface IConfigProvider
   └─ 定义配置提供者接口，支持获取完整配置和监听配置变更，实现平台无关的配置管理逻辑

---

# src/abstractions/core.ts (65 lines)
└─ 定义平台无关的文件系统操作接口，提供读写、检查、统计等核心功能。定义存储操作接口，管理全局和缓存路径。定义事件总线接口，支持事件的发布订阅机制。定义日志接口，提供不同级别的日志记录功能。定义文件监视器接口，监听文件和目录的变化事件。定义平台依赖容器接口，整合所有核心抽象组件。

   4--12 | interface IFileSystem
   └─ 提供跨平台文件系统操作抽象，支持读写、检查、统计和目录管理
   17--21 | interface IStorage
   └─ 管理全局存储路径和缓存路径生成，提供存储位置抽象
   26--31 | interface IEventBus
   └─ 实现事件发布订阅机制，支持事件监听、触发和一次性订阅
   36--41 | interface ILogger
   └─ 提供分级日志记录功能，支持调试、信息、警告和错误级别输出
   46--49 | interface IFileWatcher
   └─ 监听文件和目录变化事件，提供文件系统变化通知机制
   51--54 | interface FileWatchEvent
   └─ 定义文件系统事件类型，包含创建、修改、删除三种事件类型及文件URI
   59--65 | interface IPlatformDependencies
   └─ 封装平台核心依赖，提供文件系统、存储、事件总线等基础服务接口

---

# src/abstractions/index.ts (35 lines)
└─ 导出平台无关的核心抽象类型，包括文件系统、存储、事件总线、日志、文件监听器、工作区、路径工具、配置提供者等，支持多平台解耦实现。


---

# src/abstractions/workspace.ts (96 lines)
└─ 定义平台无关的工作区抽象接口，提供路径管理、忽略规则处理和文件查找功能，包含工作区文件夹和路径工具接口。

   4--45 | interface IWorkspace
   └─ 定义工作空间核心接口，提供路径管理、忽略规则和文件查找功能
   47--51 | interface WorkspaceFolder
   └─ 表示工作空间文件夹，包含名称、URI和索引信息
   56--96 | interface IPathUtils
   └─ 实现路径工具抽象，提供路径拼接、解析和规范化操作

---

# src/cli-tools/outline.ts (928 lines)
└─ 实现代码结构提取工具，支持文本和JSON格式输出，集成AI摘要功能，使用tree-sitter解析代码结构

   31--58 | interface OutlineOptions
   └─ 定义代码大纲提取的配置参数，包含文件路径、工作区、输出格式等选项
   63--71 | interface OutlineDefinition
   └─ 表示代码结构定义，包含名称、类型、行号范围和可选摘要信息
   76--83 | interface OutlineData
   └─ 存储文件大纲数据，包含文件路径、语言、定义列表和文件级摘要

   91--131 | function extractOutline
   └─ 主入口函数，解析文件路径并验证存在性，根据格式调用相应输出方法
   133--144 | function createFallbackWorkspace
   └─ 创建简化工作区对象，提供基本的路径解析和忽略规则功能
   157--211 | function getOutlineAsText
   └─ 生成文本格式代码大纲，支持AI摘要和缓存管理
   223--271 | function getOutlineAsJson
   └─ 生成JSON格式代码大纲，处理文件类型不支持情况
   277--327 | function buildOutlineDefinitions
   └─ 解析文件内容，构建结构化代码定义数据
   332--451 | function extractDefinitionsFromCaptures
   └─ 从tree-sitter捕获中提取代码定义，过滤重复项
   456--492 | function renderDefinitionsAsText
   └─ 渲染代码定义为文本格式，包含类型和摘要信息
   497--520 | function renderDefinitionsAsJson
   └─ 将代码结构数据转换为格式化JSON输出，包含文件信息和定义详情
   525--545 | function createStorageForOutline
   └─ 为代码大纲工具创建存储抽象层，管理配置和日志设置
   550--594 | function createSummarizerForOutline
   └─ 构建AI摘要生成器实例，处理配置加载和服务初始化
   599--626 | function loadSummarizerConfig
   └─ 加载摘要配置信息，支持自定义配置路径和默认值
   637--790 | function generateSummariesWithRetry
   └─ 批量处理代码摘要生成，实现重试机制和并发控制
   792--927 | function applySummaryCache
   └─ 实现AI摘要缓存管理，支持批量生成、错误重试和缓存清理，优化代码摘要性能

---

# src/cli-tools/summary-cache.ts (664 lines)
└─ 实现AI代码摘要缓存管理器，使用两级哈希机制避免冗余LLM调用，支持配置变更检测和缓存清理功能。

   25--31 | interface CacheFingerprint
   └─ 定义缓存配置指纹，包含AI模型参数和语言设置，用于检测配置变更
   36--45 | interface BlockSummary
   └─ 表示代码块摘要缓存条目，存储代码哈希、上下文哈希和AI生成的摘要
   50--57 | interface SummaryCache
   └─ 表示完整文件摘要缓存，包含版本信息、配置指纹、文件哈希和块级摘要
   62--67 | interface CacheStats
   └─ 统计缓存命中情况，记录总块数、缓存块数、命中率及缓存失效原因
   72--76 | interface FilterResult
   └─ 过滤需要摘要的代码块，返回更新后的块列表、文件摘要和缓存统计信息
   81--88 | interface CodeBlock
   └─ 定义代码块结构，包含名称、类型、行号和摘要信息

   111--663 | class SummaryCacheManager
   └─ 管理AI代码摘要缓存，实现两级哈希机制避免重复调用

   115--119 | property logger
   └─ 配置可选日志记录器，支持信息、错误和警告输出

   121--135 | method constructor
   └─ 初始化缓存管理器，设置工作路径和依赖服务
   144--148 | method hashBlock
   └─ 计算代码块SHA256哈希值，用于缓存键生成和内容比较
   153--157 | method hashFile
   └─ 计算文件内容的SHA256哈希值，用于文件级缓存验证
   169--179 | method createFingerprint
   └─ 根据配置生成缓存指纹，包含模型、语言等影响输出的参数
   192--221 | method getCachePathForSourceFile
   └─ 构建缓存文件路径，包含项目哈希和相对路径，防止路径遍历攻击
   230--254 | method loadCache
   └─ 加载并验证缓存文件，检查版本匹配，处理异常情况
   265--366 | method filterBlocksNeedingSummarization
   └─ 过滤需要重新生成的代码块，实现缓存命中/未命中逻辑
   371--462 | method updateCache
   └─ 更新缓存文件，应用大小限制并原子性写入
   471--535 | method cleanOrphanedCaches
   └─ 清理孤立缓存文件，删除已删除源文件的缓存
   540--601 | method cleanOldCaches
   └─ 清理过期缓存文件，基于最后访问时间LRU策略
   611--662 | method clearAllCaches
   └─ 清除项目所有缓存文件，强制重新生成AI摘要

---

# src/code-index/cache-manager.ts (138 lines)
└─ 实现代码索引缓存管理，提供文件哈希存储、更新和持久化功能，支持防抖写入和缓存清理。

   14--137 | class CacheManager
   └─ 实现缓存管理接口，提供文件哈希存储和持久化功能

   23--30 | method constructor
   └─ 初始化缓存管理器，生成唯一缓存路径并设置防抖保存
   51--58 | method initialize
   └─ 加载缓存文件，解析JSON数据到内存哈希映射
   63--71 | method _performSave
   └─ 将内存哈希映射序列化为JSON并写入缓存文件
   77--89 | method clearCacheFile
   └─ 清除缓存文件并重置内存中的哈希映射状态
   105--108 | method updateHash
   └─ 更新文件哈希值并触发防抖保存缓存
   114--117 | method deleteHash
   └─ 删除指定文件哈希值并触发防抖保存缓存
   123--128 | method deleteHashes
   └─ 批量删除多个文件哈希值并触发防抖保存缓存

---

# src/code-index/config-manager.ts (524 lines)
└─ 管理代码索引配置，处理加载、验证和重启检测，支持多种嵌入器和重排序器配置。

   69--81 | function getConfigValue
   └─ 安全获取配置值，处理嵌套对象和原始值

   87--503 | class CodeIndexConfigManager
   └─ 管理代码索引配置，处理加载、验证和重启检测

   90--94 | method constructor
   └─ 异步初始化配置，避免构造函数阻塞
   120--138 | method loadConfiguration
   └─ 加载配置并检测是否需要重启服务
   143--172 | method isConfigured
   └─ 验证不同AI提供商的配置完整性
   177--227 | method _createConfigSnapshot
   └─ 创建配置快照，保存当前所有配置项用于后续变更检测
   232--325 | method doesConfigChangeRequireRestart
   └─ 检测配置变更是否需要重启，处理启用/禁用状态和关键参数变化
   330--353 | method _hasVectorDimensionChanged
   └─ 检查模型维度是否变更，确保向量存储兼容性
   358--363 | method getConfig
   └─ 获取当前配置，提供默认值确保配置始终可用
   397--410 | method currentModelDimension
   └─ 计算当前模型维度，优先使用模型内置维度，回退到自定义维度
   417--429 | method currentSearchMinScore
   └─ 实现搜索最小分数获取，优先使用用户配置，其次模型阈值，最后默认值
   436--439 | method currentSearchMaxResults
   └─ 获取搜索最大结果数，使用验证函数确保数值在有效范围内
   451--473 | method rerankerConfig
   └─ 返回重排序器配置，仅在启用且提供提供者时返回完整配置对象
   480--497 | method summarizerConfig
   └─ 生成总结器配置，为所有字段提供默认值确保配置完整性

---

# src/code-index/config-validator.ts (410 lines)
└─ 配置验证器类，验证嵌入器、Qdrant、重排序器和摘要器配置，确保参数完整性和数值范围正确。

   6--22 | interface ValidationIssue
   └─ 定义配置验证问题的数据结构，包含路径、错误码和消息
   27--37 | interface ValidationResult
   └─ 封装配置验证结果，包含有效性和问题列表

   42--409 | class ConfigValidator
   └─ 实现配置验证器类，集中管理所有验证逻辑

   48--70 | method validate
   └─ 执行完整配置验证，协调各个验证模块
   75--174 | method validateEmbedder
   └─ 验证嵌入器配置，根据不同提供商检查必需参数
   179--187 | method validateQdrant
   └─ 验证Qdrant向量存储配置，确保URL必填
   192--247 | method validateReranker
   └─ 验证重排序器配置，根据提供商检查必要参数
   254--320 | method validateSummarizer
   └─ 验证摘要器配置，支持Ollama和OpenAI兼容提供商
   325--408 | method validateBasicConsistency
   └─ 验证基本配置一致性，检查分数范围和批处理大小

---

# src/code-index/index.ts (29 lines)
└─ 导出代码索引核心功能模块，包括管理器、配置、缓存、状态、编排、搜索、服务工厂、接口、嵌入器、处理器、向量存储、常量和共享工具。


---

# src/code-index/manager.ts (508 lines)
└─ 管理代码索引的核心类，实现单例模式，负责配置、状态、服务和搜索的协调与生命周期控制。

   19--27 | interface CodeIndexManagerDependencies
   └─ 定义代码索引管理器依赖接口，包含文件系统、存储、事件总线等核心组件

   29--508 | class CodeIndexManager
   └─ 实现代码索引管理器单例模式，管理索引生命周期和状态

   44--58 | method getInstance
   └─ 获取指定工作区的管理器实例，支持自动检测工作区路径
   60--65 | method disposeAll
   └─ 清理所有管理器实例，释放系统资源
   71--75 | method constructor
   └─ 初始化管理器实例，设置工作区路径和依赖组件
   87--91 | method assertInitialized
   └─ 验证核心服务实例是否已初始化，未初始化则抛出异常
   93--99 | method state
   └─ 获取当前索引状态，若功能未启用则返回待机状态
   109--116 | method isInitialized
   └─ 通过尝试断言初始化状态来检查管理器是否已初始化
   126--182 | method initialize
   └─ 初始化配置管理器、缓存管理器，根据选项启动或重建服务
   187--191 | method loadConfiguration
   └─ 重新加载配置管理器中的配置设置，确保配置最新
   201--218 | method startIndexing
   └─ 检查错误状态并恢复，然后启动索引进程
   223--230 | method stopWatcher
   └─ 停止文件监视器，停止后台索引任务
   246--270 | method recoverFromError
   └─ 清除错误状态并重置所有服务实例
   275--280 | method dispose
   └─ 释放资源，停止监视器并清理状态管理器
   286--293 | method clearIndexData
   └─ 清除索引数据和缓存文件，重置索引状态
   297--303 | method getCurrentStatus
   └─ 获取当前系统状态并添加工作区路径
   305--339 | method reconcileIndex
   └─ 同步索引与文件系统，删除过时文件条目
   341--347 | method searchIndex
   └─ 执行向量搜索，返回匹配结果
   353--439 | method _recreateServices
   └─ 重新创建所有服务实例，确保配置更新
   446--462 | method _initializeForSearchOnly
   └─ 初始化搜索模式，检查现有索引数据
   470--507 | method handleSettingsChange
   └─ 处理设置变更，根据配置重启服务或禁用功能，确保系统状态与配置同步。

---

# src/code-index/orchestrator.ts (435 lines)
└─ 管理代码索引工作流，协调不同服务和管理器，处理文件监控、状态管理和错误恢复。

   42--434 | class CodeIndexOrchestrator
   └─ 协调代码索引工作流，管理文件监控和状态更新

   46--55 | method constructor
   └─ 初始化核心组件，注入配置、状态和存储管理器
   86--136 | method _startWatcher
   └─ 启动文件监控器，订阅批量处理和进度更新事件
   142--372 | method startIndexing
   └─ 执行增量或全量索引，处理错误和状态转换
   377--385 | method stopWatcher
   └─ 停止文件监控器，清理订阅并重置处理状态
   394--426 | method clearIndexData
   └─ 停止文件监视器，删除向量存储集合，清除缓存文件，实现索引数据的完全重置。

---

# src/code-index/search-service.ts (108 lines)
└─ 实现代码索引搜索服务，处理查询嵌入、向量检索和重排序，支持配置验证和错误状态管理。

   14--107 | class CodeIndexSearchService
   └─ 代码索引搜索服务类，管理配置和状态

   15--21 | method constructor
   └─ 初始化搜索服务，注入配置、状态和嵌入组件
   30--106 | method searchIndex
   └─ 执行向量搜索，支持重排序和结果过滤

---

# src/code-index/service-factory.ts (380 lines)
└─ 代码索引服务工厂类，负责创建和配置嵌入器、向量存储、目录扫描器、文件监视器、重排序器和摘要器等核心服务组件，支持多种AI模型提供商，提供配置验证和错误处理机制。

   58--379 | class CodeIndexServiceFactory
   └─ 工厂类负责创建和配置代码索引服务依赖项

   59--64 | method constructor
   └─ 初始化配置管理器、工作区路径和缓存管理器
   88--146 | method createEmbedder
   └─ 根据配置创建不同提供商的嵌入器实例
   153--163 | method validateEmbedder
   └─ 验证嵌入器配置是否正确
   168--202 | method createVectorStore
   └─ 创建向量存储并确定向量维度
   207--227 | method createDirectoryScanner
   └─ 创建目录扫描器，注入嵌入器、向量存储等依赖
   232--243 | method createFileWatcher
   └─ 创建文件监视器，监听文件变化并触发索引更新
   249--280 | method createServices
   └─ 创建完整服务链，验证配置并返回所有核心组件
   286--311 | method createReranker
   └─ 根据配置创建重排序器，支持Ollama和OpenAI兼容
   318--328 | method validateReranker
   └─ 验证重排序器配置，捕获异常并返回验证结果
   334--362 | method createSummarizer
   └─ 根据配置创建总结器实例，支持Ollama和OpenAI兼容两种模式，未知时回退到默认Ollama
   369--378 | method validateSummarizer
   └─ 异步验证总结器配置，捕获异常并返回验证结果，确保服务可用性

---

# src/code-index/state-manager.ts (126 lines)
└─ 管理代码索引状态，跟踪进度并触发事件更新，支持多种索引状态和进度报告。

   9--125 | class CodeIndexStateManager
   └─ 管理代码索引状态的核心类，跟踪系统状态和进度信息。

   17--20 | method constructor
   └─ 初始化状态管理器，绑定事件总线并设置进度更新监听器。
   30--39 | method getCurrentStatus
   └─ 获取当前系统状态，包括状态、消息和进度信息。
   43--66 | method setSystemState
   └─ 设置系统状态，更新消息并重置进度计数器。
   68--89 | method reportBlockIndexingProgress
   └─ 报告代码块索引进度，更新处理状态和进度信息。
   91--120 | method reportFileQueueProgress
   └─ 更新文件队列进度，设置状态为索引中，根据处理情况生成不同消息，触发进度更新事件

---

# src/code-index/validate-search-params.ts (43 lines)
└─ 验证搜索参数的limit和minScore，确保数值合法且在配置范围内，提供默认值和边界处理。

   4--22 | function validateLimit
   └─ 验证搜索限制参数，处理非数字、负数和小数，确保返回有效正整数
   25--42 | function validateMinScore
   └─ 验证最小分数参数，处理null/undefined，限制在[0,1]范围内返回有效值

---

# src/examples/create-sample-files.ts (1285 lines)
└─ 创建示例文件函数，生成JavaScript、Python、Markdown、JSON和YOLO模型文件，用于演示代码索引系统。

   2--1283 | function createSampleFiles
   └─ [Code too large to summarize (1282 lines)]

---

# src/examples/demo-sse-mcp-server.ts (64 lines)
└─ 创建MCP服务器实例，注册加法工具，通过Express和SSE实现通信接口，监听3001端口。


---

# src/examples/embedding-test-simple.ts (254 lines)
└─ 测试向量嵌入搜索功能，模拟npm包数据，评估不同模型的检索精度和性能表现。

   68--246 | function runEmbeddingTest
   └─ 初始化embedding测试环境，配置Jina模型参数，创建向量搜索实例并添加模拟包数据

---

# src/examples/memory-vector-search.ts (239 lines)
└─ 实现内存向量搜索类，支持多种嵌入模型，提供文档添加、相似度搜索和批量处理功能

   8--13 | interface VectorDocument
   └─ 定义向量文档结构，包含ID、内容和向量数据

   15--238 | class MemoryVectorSearch
   └─ 实现内存向量搜索类，支持多种嵌入服务配置

   19--51 | method constructor
   └─ 初始化向量搜索器，兼容新旧配置方式
   56--70 | method cosineSimilarity
   └─ 计算两个向量的余弦相似度，用于文档匹配
   75--85 | method addDocument
   └─ 添加单个文档到内存存储，生成向量嵌入
   90--170 | method addDocuments
   └─ 批量添加文档，分批处理避免超时，包含详细错误诊断
   175--209 | method search
   └─ 搜索相似文档，计算余弦相似度并返回最相关结果

---

# src/examples/nodejs-usage.ts (245 lines)
└─ 展示Node.js环境下的代码库使用示例，包含基础和高级配置、文件操作、事件系统、文件监控、代码索引管理器集成、测试工具和CLI命令行工具的实现。

   23--48 | function basicUsageExample
   └─ 演示基本使用，创建依赖并配置OpenAI嵌入服务
   53--128 | function advancedUsageExample
   └─ 实现高级配置，包含文件系统操作和事件监听机制
   133--171 | function codeIndexManagerExample
   └─ 集成代码索引管理器，监听配置变化并重启索引
   176--191 | function createTestDependencies
   └─ 创建测试环境依赖，配置存储和日志路径
   196--239 | function cliExample
   └─ 实现CLI命令行工具，支持初始化、状态查询和文件列表功能

---

# src/examples/run-demo.ts (244 lines)
└─ 演示脚本监控本地文件夹，使用Ollama嵌入和Qdrant向量存储索引代码，展示Node.js环境下的代码库库使用方法。

   21--178 | function main
   └─ 初始化依赖配置，创建demo文件夹并验证配置
   182--206 | function waitForIndexingToComplete
   └─ 轮询检查索引状态，等待完成或超时
   208--236 | function demonstrateSearch
   └─ 执行多轮搜索测试，展示代码检索功能

---

# src/examples/run-example.ts (25 lines)
└─ 根据命令参数运行不同的示例代码，包括基础、高级和CLI三种模式

   6--22 | function main
   └─ 根据命令参数执行不同的示例函数，默认执行basic示例，无效参数显示使用说明

---

# src/examples/simple-demo.ts (104 lines)
└─ 演示脚本创建Node.js依赖，初始化配置，测试文件系统操作，展示基础功能而不需要外部服务

   16--75 | function main
   └─ 初始化演示环境，创建依赖配置和示例文件
   78--97 | function demonstrateFileSystem
   └─ 读取并统计指定目录下文件的基本信息

---

# src/examples/test-embedding.ts (37 lines)
└─ 测试Ollama嵌入功能，创建嵌入器并验证文本嵌入结果

   9--30 | function main
   └─ 测试Ollama嵌入功能，创建嵌入器，处理文本并生成向量，捕获错误并输出结果

---

# src/examples/test-full-parsing.ts (52 lines)
└─ 测试完整解析流程，加载语言解析器，创建代码解析器，逐个解析测试文件并输出结果

   6--50 | function testFullParsing
   └─ 测试完整解析流程，加载语言解析器，创建代码解析器，逐个解析测试文件并输出结果

---

# src/examples/test-model-dimension.ts (29 lines)
└─ 测试模型维度函数，验证不同提供商和模型的嵌入维度输出

   9--22 | function main
   └─ 测试模型维度函数，遍历不同提供商和模型ID，输出各模型的维度值

---

# src/examples/test-parser.ts (31 lines)
└─ 测试解析器加载功能，验证多语言文件解析器初始化与异常处理

   3--29 | function testParserLoading
   └─ 测试解析器加载功能，验证不同语言文件解析器是否正确初始化并输出状态信息。

---

# src/examples/test-scanner.ts (37 lines)
└─ 测试脚本验证p-limit库的导入和并发控制功能，通过限制并发任务数量确保系统稳定性。

   9--30 | function main
   └─ 测试p-limit库的导入和并发控制功能，验证异步任务执行和错误处理机制。

---

# src/ignore/RooIgnoreController.ts (219 lines)
└─ 实现基于.rooignore文件控制LLM文件访问权限，支持.gitignore语法，监听文件变化并动态更新忽略规则。

   12--218 | class RooIgnoreController
   └─ 实现文件访问控制，通过.rooignore文件管理LLM对文件的访问权限。

   21--37 | method constructor
   └─ 初始化控制器，设置依赖项并启动.rooignore文件监听。
   50--69 | method setupFileWatcher
   └─ 配置文件监视器，在.rooignore文件变更时自动重新加载规则。
   74--98 | method loadRooIgnore
   └─ 异步加载.rooignore文件内容，解析忽略规则并更新实例。
   105--121 | method validateAccess
   └─ 验证文件路径是否被忽略，支持绝对和相对路径检查。
   128--177 | method validateCommand
   └─ 解析终端命令，检查文件读取操作是否违反忽略规则，返回被阻止的文件路径。
   184--197 | method filterPaths
   └─ 过滤路径列表，移除被忽略的文件，确保只返回允许访问的路径。
   202--205 | method dispose
   └─ 清理资源，移除所有文件监视器回调函数，防止内存泄漏。
   211--217 | method getInstructions
   └─ 生成.rooignore文件的说明文本，指导大模型遵守文件访问限制。

---

# src/glob/index.ts (2 lines)
└─ 导出文件列表工具模块，提供文件操作相关功能


---

# src/glob/list-files.ts (414 lines)
└─ 实现递归或非递归列出目录文件，使用ripgrep高效搜索，支持.gitignore过滤和特殊目录保护。

   30--33 | interface ListFilesDependencies
   └─ 定义文件列表操作的依赖接口，包含路径工具和可选的ripgrep路径

   44--71 | function listFiles
   └─ 实现文件列表主逻辑，处理特殊目录、调用ripgrep并合并结果
   76--94 | function handleSpecialDirectories
   └─ 检查并阻止对根目录和用户主目录的递归文件列表操作
   100--110 | function listFilesWithRipgrep
   └─ 使用ripgrep工具执行文件列表，构建相应参数并调用执行函数
   115--124 | function buildRipgrepArgs
   └─ 根据递归模式构建ripgrep参数，处理文件过滤和目录排除规则
   129--141 | function buildRecursiveArgs
   └─ 构建递归搜索参数，排除大型目录并尊重.gitignore
   146--169 | function buildNonRecursiveArgs
   └─ 构建非递归搜索参数，限制深度并忽略隐藏目录
   174--203 | function parseGitignoreFile
   └─ 解析.gitignore文件，提取过滤模式用于递归搜索
   208--234 | function listFilteredDirectories
   └─ 列出目录并应用过滤规则，返回格式化路径
   239--256 | function shouldIncludeDirectory
   └─ 判断目录是否应包含，检查隐藏、显式和gitignore规则
   261--278 | function isDirectoryExplicitlyIgnored
   └─ 检查目录名是否在忽略列表中，支持精确匹配和路径模式匹配
   283--310 | function isIgnoredByGitignore
   └─ 判断目录是否被gitignore规则排除，处理目录模式和通配符匹配
   315--334 | function formatAndCombineResults
   └─ 合并文件和目录路径，去重排序并应用数量限制
   339--413 | function execRipgrep
   └─ 执行ripgrep命令，处理输出流并管理超时和错误
   393--411 | function processRipgrepOutput
   └─ 处理ripgrep输出缓冲区，分割行并收集结果直到达到限制

---

# src/lib/codebase.ts (4 lines)
└─ 导出函数返回固定字符串'codebase'，作为代码库标识符


---

# src/mcp/http-server.ts (571 lines)
└─ 实现基于Express的MCP HTTP服务器，提供代码库语义搜索功能，支持会话管理和健康检查

   16--20 | interface HTTPMCPServerOptions
   └─ 定义HTTP MCP服务器配置接口，包含代码索引管理器和网络参数

   22--570 | class CodebaseHTTPMCPServer
   └─ 实现代码库HTTP MCP服务器类，管理MCP服务器和HTTP服务

   31--43 | method constructor
   └─ 初始化服务器实例，设置代码索引管理器和默认端口主机
   45--114 | method setupTools
   └─ 注册搜索工具，配置查询参数和过滤选项
   120--258 | method handleSearchCodebase
   └─ 处理代码库搜索逻辑，验证参数并格式化搜索结果
   260--295 | method handleGetSearchStats
   └─ 获取代码索引状态，返回初始化和功能启用情况
   297--330 | method handleConfigureSearch
   └─ 处理搜索配置请求，支持刷新索引和更新模型
   337--501 | method setupHTTPServer
   └─ 配置HTTP服务器，设置CORS和MCP端点处理器
   503--515 | method start
   └─ 启动HTTP服务器，监听指定端口并输出服务信息
   517--569 | method stop
   └─ 停止服务器，关闭连接和清理资源，确保优雅退出

---

# src/mcp/server.ts (310 lines)
└─ 实现MCP服务器，提供代码库搜索、统计和配置功能，支持语义向量搜索和工具调用处理。

   18--303 | class CodebaseMCPServer
   └─ 实现MCP服务器类，管理代码索引和工具注册

   22--38 | method constructor
   └─ 初始化服务器实例，配置工具功能
   40--138 | method setupTools
   └─ 注册搜索、统计和配置三个核心工具
   140--212 | method handleSearchCodebase
   └─ 执行语义搜索，处理结果格式化和错误处理
   214--250 | method handleGetSearchStats
   └─ 获取索引状态，生成统计信息报告
   252--278 | method handleConfigureSearch
   └─ 配置搜索参数，设置相似度阈值和上下文包含选项
   280--297 | method start
   └─ 启动MCP服务器，建立stdio传输连接并处理错误
   299--302 | method stop
   └─ 停止MCP服务器，关闭连接释放资源

   306--310 | function createMCPServer
   └─ 创建并启动MCP服务器实例，返回可用的服务器对象

---

# src/mcp/stdio-adapter.ts (418 lines)
└─ 实现stdio到HTTP MCP服务器的适配器，处理JSON-RPC消息转发和SSE连接管理

   18--21 | interface StdioAdapterOptions
   └─ 定义适配器配置参数，包含服务器URL和超时时间

   23--417 | class StdioToStreamableHTTPAdapter
   └─ 实现stdio到HTTP的适配器类，管理连接和请求

   32--36 | method constructor
   └─ 初始化适配器，设置服务器URL和请求映射
   41--48 | method start
   └─ 启动适配器，设置stdio处理器准备连接
   53--68 | method stop
   └─ 停止适配器，清理连接和拒绝待处理请求
   74--140 | method connectSSE
   └─ 建立SSE连接，处理服务器推送消息，维护会话状态
   146--169 | method handleServerMessage
   └─ 解析SSE消息，区分请求响应和通知，转发到标准输出
   174--200 | method setupStdioHandlers
   └─ 配置标准输入输出，处理JSON-RPC消息流，管理进程生命周期
   205--236 | method handleStdinMessage
   └─ 解析客户端请求，转发到HTTP服务器，处理初始化和错误响应
   242--340 | method forwardRequestToServer
   └─ 实现请求转发逻辑，处理初始化会话，管理SSE和直接响应模式
   346--404 | method httpRequest
   └─ 发送HTTP请求到MCP服务器，处理JSON和SSE响应格式
   409--416 | method writeStdoutResponse
   └─ 将JSON-RPC响应序列化并输出到标准输出流

---

# src/ripgrep/index.ts (312 lines)
└─ 封装ripgrep搜索功能，提供跨平台文件搜索，支持正则表达式和文件过滤，返回格式化结果。

   55--58 | interface SearchFileResult
   └─ 定义文件搜索结果结构，包含文件路径和搜索结果列表
   64--69 | interface SearchLineResult
   └─ 定义搜索行结果结构，包含行号、文本内容、匹配状态和列位置

   87--130 | function getBinPath
   └─ 查找ripgrep二进制文件路径，优先系统PATH，回退VSCode安装目录
   132--170 | function execRipgrep
   └─ 执行ripgrep命令并处理输出，限制结果数量并处理跨平台换行符

   172--176 | interface RipgrepOptions
   └─ 定义ripgrep搜索选项，包含文件系统、VSCode根目录和忽略过滤器

   186--267 | function regexSearchFiles
   └─ 执行正则搜索，调用ripgrep解析输出并过滤结果
   269--311 | function formatResults
   └─ 格式化搜索结果，按文件分组并生成可读的输出文本

---

# src/search/file-search.ts (177 lines)
└─ 使用ripgrep实现文件搜索功能，支持文件和目录查找，集成fzf进行模糊匹配，提供高效的workspace文件搜索能力。

   17--20 | function getBinPath
   └─ 获取ripgrep可执行文件路径，返回null或路径字符串
   24--99 | function executeRipgrep
   └─ 执行ripgrep命令，解析输出结果，返回文件和目录列表
   101--121 | function executeRipgrepForFiles
   └─ 使用ripgrep扫描工作区文件，排除常见目录，返回文件列表
   123--176 | function searchWorkspaceFiles
   └─ 实现文件搜索功能，使用fzf算法匹配查询，验证路径类型

---

# src/search/index.ts (2 lines)
└─ 导出文件搜索功能模块，提供文件搜索相关接口和实现逻辑


---

# src/shared/api.ts (10 lines)
└─ 定义API处理器选项和基础接口，支持OpenAI和Ollama配置，提供灵活的键值扩展

   2--6 | interface ApiHandlerOptions
   └─ 定义API处理器选项接口，包含OpenAI和Ollama配置，支持动态扩展属性

---

# src/shared/embeddingModels.ts (196 lines)
└─ 定义嵌入模型配置，包含维度、默认模型和相似度阈值，支持多种AI服务提供商。

   7--10 | interface EmbeddingModelProfile
   └─ 定义嵌入模型配置文件，包含维度等属性

   12--16 | type EmbeddingModelProfiles
   └─ 构建多提供商模型配置的映射类型

   73--89 | function getModelDimension
   └─ 根据提供商和模型ID获取嵌入维度
   99--139 | function getDefaultModelId
   └─ 为不同提供商返回默认嵌入模型ID
   148--152 | function getModelQueryPrefix
   └─ 返回模型查询前缀，当前无实现
   161--195 | function getModelScoreThreshold
   └─ 根据模型ID返回语义搜索的相似度阈值，基于不同模型的性能测试结果设置阈值，确保匹配可靠性。

---

# src/shared/index.ts (2 lines)
└─ 导出API和嵌入模型模块，提供共享功能接口


---

# src/tools/file-chunker-cli.ts (271 lines)
└─ 实现文件切块命令行工具，支持多种输出格式和切块策略，提供文件查找和信息查询功能。

   9--23 | interface CLIOptions
   └─ 定义CLI选项接口，包含输出格式、切块参数和文件处理配置

   28--92 | function formatOutput
   └─ 格式化输出结果，支持JSON、CSV和文本三种格式，可选择保存到文件
   97--101 | function findFiles
   └─ 查找匹配模式的文件，当前为简化实现，实际应使用glob等库
   106--261 | function main
   └─ 实现主程序逻辑，定义chunk、find、info和list-ext四个命令及其处理逻辑

---

# src/tools/file-chunker.ts (249 lines)
└─ 实现文件切块工具，支持tree-sitter解析，生成代码块并计算哈希值，提供批量处理功能。

   11--14 | interface ParentContainer
   └─ 定义父级容器标识符和类型信息
   19--44 | interface FileChunk
   └─ 描述文件块的结构化数据模型
   49--64 | interface FileChunkerOptions
   └─ 配置文件切块的参数选项
   69--82 | interface ChunkResult
   └─ 封装文件切块处理的结果数据

   109--227 | class FileChunker
   └─ 实现基于tree-sitter的文件切块逻辑

   110--118 | property defaultOptions
   └─ 定义文件切块器的默认配置参数，包含最小块大小、最大块大小等关键设置

   130--186 | method chunkFile
   └─ 实现单个文件切块逻辑，读取文件内容、计算哈希值并使用CodeParser解析生成代码块
   194--208 | method chunkFiles
   └─ 批量处理多个文件切块，支持错误处理并收集所有处理结果
   215--218 | method isFileSupported
   └─ 检查文件扩展名是否在支持的列表中，判断文件是否可进行切块处理

   235--238 | function chunkFile
   └─ 提供便捷函数封装，快速创建切块器实例并执行单个文件切块操作
   246--249 | function chunkFiles
   └─ 创建文件切块器实例，批量处理多个文件并返回切块结果列表

---

# src/tools/test-tree-sitter.ts (201 lines)
└─ 测试Tree-sitter解析器的工具脚本，支持解析代码定义和输出JSON格式的捕获详情。

   27--44 | function parseFile
   └─ 解析指定文件的代码定义，输出解析结果或错误信息
   49--122 | function outputCapturesAsJson
   └─ 读取文件内容并生成详细的JSON格式捕获数据，包含节点位置和文本信息
   127--142 | function getFilePath
   └─ 从命令行参数或环境变量获取文件路径，支持默认值回退
   147--163 | function showUsage
   └─ 显示程序使用说明，包括命令行参数和环境变量的使用方法
   166--194 | function main
   └─ 主函数协调整个流程，包括文件验证、解析和可选的JSON输出

---

# src/types/vitest.d.ts (140 lines)
└─ 定义Vitest测试框架的全局类型声明，提供describe、it、expect等测试函数的类型，以及beforeEach、afterEach等钩子函数，并添加Jest兼容性支持。

   116--136 | interface Mock
   └─ 为Vitest的Mock接口添加Jest兼容方法，支持设置解析值、拒绝值及一次性延迟操作

---

# src/tree-sitter/index.ts (453 lines)
└─ 定义文件扩展名列表，支持多种编程语言和标记语言。提供获取和设置最小组件行数的方法。解析源代码定义，处理Markdown文件和其他文件类型，提取代码结构信息。

   9--13 | interface TreeSitterDependencies
   └─ 定义树状解析器依赖接口，包含文件系统、工作区和路径工具

   104--157 | function parseSourceCodeDefinitionsForFile
   └─ 解析单个文件源代码定义，支持Markdown和多种编程语言
   160--242 | function parseSourceCodeForDefinitionsTopLevel
   └─ 解析目录顶层源代码定义，批量处理文件并返回格式化结果
   244--248 | function separateFiles
   └─ 分离可解析文件，限制最大文件数量并分类处理
   283--404 | function processCaptures
   └─ 处理树状解析器捕获结果，格式化输出代码定义和文档字符串
   414--452 | function parseFile
   └─ 解析单个文件内容，检查权限，读取文件，使用tree-sitter解析AST，提取代码定义并返回格式化结果。

---

# src/tree-sitter/languageParser.ts (372 lines)
└─ 实现多语言解析器加载系统，支持通过文件扩展名动态加载对应的Tree-sitter WASM模块和查询规则，优化性能并兼容不同运行环境。

   35--40 | interface LanguageParser
   └─ 定义语言解析器接口，存储解析器和查询对象

   46--95 | function findWasmFile
   └─ 查找指定语言的WASM文件，支持多种环境路径解析
   97--156 | function findCoreTreeSitterWasm
   └─ 查找核心tree-sitter WASM文件，支持多种部署路径
   158--166 | function loadLanguage
   └─ 异步加载指定语言的解析器，处理加载错误
   171--201 | function initializeParser
   └─ 初始化tree-sitter解析器，确保单例模式并设置WASM路径

   189--194 | method locateFile
   └─ 重定向tree-sitter.wasm文件路径到指定位置

   225--371 | function loadRequiredLanguageParsers
   └─ 根据文件扩展名动态加载对应的语言解析器和查询

---

# src/tree-sitter/markdownParser.ts (217 lines)
└─ 实现Markdown解析器，提取标题和章节行范围，兼容tree-sitter捕获结构，支持ATX和Setext标题格式。

   10--19 | interface MockNode
   └─ 定义模拟树节点结构，包含位置信息和文本内容
   24--27 | interface MockCapture
   └─ 定义模拟捕获结构，关联节点和名称标识

   35--173 | function parseMarkdown
   └─ 解析Markdown文件，提取标题并计算章节行范围
   183--216 | function formatMarkdownCaptures
   └─ 格式化Markdown捕获结果，输出标题和行范围信息

---

# src/utils/config-provider.ts (154 lines)
└─ 配置提供者实现，支持从环境变量和配置文件读取配置，管理API密钥等敏感信息，提供全局单例实例。

   33--37 | interface IConfigProvider
   └─ 定义配置提供者接口，规范全局状态、密钥获取和刷新方法

   43--112 | class SimpleConfigProvider
   └─ 实现配置提供者类，支持文件和环境变量双重配置源

   51--65 | method loadConfig
   └─ 异步加载配置文件，处理文件不存在或解析错误情况
   71--75 | method ensureLoaded
   └─ 确保配置已加载，延迟初始化优化性能
   82--86 | method getGlobalState
   └─ 同步获取全局状态值，返回当前已加载的配置数据
   94--104 | method getSecret
   └─ 优先从环境变量获取密钥，其次从配置文件读取，确保密钥安全获取

   126--130 | function createInitializedConfigProvider
   └─ 创建并初始化配置提供者实例，加载配置文件后返回
   140--145 | function getGlobalConfigProvider
   └─ 实现全局单例模式，确保配置提供者实例唯一且延迟初始化

---

# src/utils/events.ts (95 lines)
└─ 实现基于Node.js EventEmitter的事件总线系统，提供订阅、发布、一次性订阅等功能，支持全局单例实例。

   9--75 | class EventBus
   └─ 实现基于 EventEmitter 的泛型事件总线，支持订阅、发布和监听管理

   12--15 | method constructor
   └─ 初始化事件发射器并设置最大监听器数量，默认为100
   21--27 | method on
   └─ 订阅事件并返回取消订阅函数，实现事件监听管理
   47--53 | method once
   └─ 订阅一次性事件，触发后自动取消订阅，返回取消函数

   89--94 | function getGlobalEventBus
   └─ 实现全局单例事件总线，首次调用时创建实例，后续返回同一实例

---

# src/utils/filesystem.ts (118 lines)
└─ 封装fs/promises API，提供文件读写、目录操作、文件检查等工具函数，支持二进制和文本内容处理，自动创建父目录，递归删除和移动文件。

   11--14 | function readFile
   └─ 读取文件内容并转换为Uint8Array，实现二进制文件读取功能
   26--35 | function writeFile
   └─ 写入文件内容，自动创建父目录，支持字符串和二进制数据
   40--47 | function exists
   └─ 检查文件或目录是否存在，通过异常处理实现存在性验证
   52--65 | function stat
   └─ 获取文件或目录的元数据信息，包括类型、大小和修改时间
   70--73 | function readdir
   └─ 读取目录内容并返回完整路径列表，实现目录遍历功能
   92--99 | function remove
   └─ 删除文件或目录，根据类型选择删除方式
   104--108 | function copyFile
   └─ 复制文件，自动创建目标目录
   113--117 | function rename
   └─ 重命名或移动文件，确保目标目录存在

---

# src/utils/fs.ts (68 lines)
└─ 创建文件所需目录，递归构建缺失路径并返回新目录列表。检查路径是否存在，安全写入JSON文件并自动创建目录。

   11--32 | function createDirectoriesForFile
   └─ 创建文件路径中缺失的所有父目录，从最顶层开始逐级向下创建
   40--47 | function fileExistsAtPath
   └─ 检查指定路径是否存在，通过捕获异常返回布尔值
   56--67 | function safeWriteJson
   └─ 安全写入JSON数据，自动创建所需目录并格式化输出

---

# src/utils/git-global-ignore.ts (221 lines)
└─ 实现Git全局忽略文件管理，确保指定模式被添加到全局排除文件中，支持原子写入和回滚机制。

   9--14 | interface GitCommandResult
   └─ 定义Git命令执行结果接口，包含执行状态、退出码和输出信息
   18--24 | interface EnsureGitGlobalIgnoreDependencies
   └─ 定义依赖项接口，封装Git操作、文件系统、环境变量和日志功能
   26--31 | interface EnsureGitGlobalIgnoreResult
   └─ 定义全局忽略文件更新结果接口，包含文件路径、更新状态和添加的模式

   33--41 | function defaultRunGit
   └─ 实现默认Git命令执行逻辑，使用spawnSync同步执行并返回结果
   43--46 | function getConfigHome
   └─ 获取配置目录路径，优先使用XDG_CONFIG_HOME环境变量，否则使用默认配置目录
   48--63 | function atomicWriteFile
   └─ 实现原子写入文件，通过临时文件和重命名确保写入完整性，失败时回退到复制删除
   73--80 | function fileExists
   └─ 检查文件是否存在，通过捕获stat异常判断文件状态
   82--87 | function getExcludesFilePath
   └─ 获取Git全局排除文件路径，使用--path选项获取规范化路径
   89--94 | function getExcludesFilePathRaw
   └─ 获取Git全局排除文件原始路径，使用--get选项获取原始配置值
   117--220 | function ensureGitGlobalIgnorePatterns
   └─ 确保Git全局忽略模式存在，处理路径设置、模式添加和错误回滚逻辑

---

# src/utils/index.ts (56 lines)
└─ 导出文件系统、存储、事件、日志和配置提供程序等工具模块，统一管理各类功能接口。


---

# src/utils/jsonc-helpers.ts (170 lines)
└─ 实现JSONC文件保存功能，保留注释并合并配置，提供验证和合并工具函数

   16--115 | function saveJsoncPreservingComments
   └─ 保存配置对象到JSONC格式，保留原有注释，支持递归更新和错误回退
   45--51 | function isPlainObject
   └─ 检查值是否为普通对象，排除数组、日期、正则等特殊对象类型
   56--100 | function applyUpdates
   └─ 递归应用配置更新，处理对象合并和直接赋值，保留注释结构
   128--132 | function isValidJsonc
   └─ 验证JSONC内容有效性，通过解析错误检测语法问题
   139--158 | function mergeConfig
   └─ 深度合并配置对象，新配置优先，仅合并普通对象类型
   163--169 | function isPlainObject
   └─ 检查值是否为纯对象，排除null、数组、日期和正则表达式实例

---

# src/utils/logger.ts (184 lines)
└─ 实现带级别和格式化的控制台日志记录器，支持时间戳、颜色和子日志器

   8--17 | interface LoggerOptions
   └─ 定义日志配置接口，包含名称、级别、时间戳和颜色选项

   34--145 | class Logger
   └─ 实现日志记录器类，提供分级日志输出和格式化功能

   40--45 | method constructor
   └─ 初始化日志实例，设置默认配置并检测终端支持颜色
   78--117 | method log
   └─ 执行日志记录逻辑，过滤级别并格式化输出消息
   136--144 | method child
   └─ 创建子日志记录器，继承父级配置并添加名称前缀

   166--171 | function getGlobalLogger
   └─ 实现全局日志获取逻辑，确保单例模式，初始化默认名称为App
   177--183 | function setGlobalLogLevel
   └─ 实现全局日志级别设置逻辑，支持更新现有实例或创建新实例

---

# src/utils/path.ts (112 lines)
└─ 实现跨平台路径处理，统一使用正斜杠展示，提供安全路径比较和可读路径转换功能。

   29--38 | function toPosixPath
   └─ 将Windows路径转换为POSIX格式，保留扩展长度路径不变
   53--68 | function arePathsEqual
   └─ 安全比较路径是否相等，处理大小写和平台差异
   70--79 | function normalizePath
   └─ 规范化路径，解析相对段并移除尾部斜杠
   81--101 | function getReadablePath
   └─ 生成用户友好的路径显示，根据上下文选择相对或绝对路径

---

# src/utils/storage.ts (154 lines)
└─ 实现基于JSON文件的键值存储类，提供异步读写、数据持久化和类型安全操作

   8--11 | interface StorageOptions
   └─ 定义存储配置接口，指定JSON文件存储路径

   13--146 | class Storage
   └─ 实现JSON文件存储类，提供键值对持久化操作

   25--41 | method load
   └─ 加载存储文件数据，处理文件不存在或格式错误情况
   46--52 | method save
   └─ 将内存数据保存到JSON文件，自动创建目录
   57--60 | method get
   └─ 获取指定键的值，支持异步加载存储数据
   65--68 | method getOrDefault
   └─ 加载存储数据后获取键值，若不存在则返回默认值
   73--77 | method set
   └─ 加载存储数据后设置键值，并自动保存到文件
   82--89 | method delete
   └─ 加载存储数据后删除指定键，存在则保存并返回true
   94--97 | method has
   └─ 加载存储数据后检查键是否存在，返回布尔值
   102--105 | method keys
   └─ 加载存储数据后返回所有键的数组列表
   110--113 | method values
   └─ 加载存储数据后返回所有值的数组
   118--121 | method entries
   └─ 加载存储数据后返回键值对数组
   126--129 | method clear
   └─ 清空数据并保存到存储文件
   134--137 | method size
   └─ 加载存储数据后返回存储项数量
   142--145 | method reload
   └─ 重置加载状态并重新加载数据

---

# src/adapters/nodejs/config.ts (354 lines)
└─ Node.js配置提供者适配器，实现IConfigProvider接口，支持JSON配置文件加载、保存和验证，支持全局和项目级配置合并，提供配置变更监听功能。

   15--19 | interface NodeConfigOptions
   └─ 定义配置提供器选项接口，支持自定义路径和默认配置

   22--353 | class NodeConfigProvider
   └─ 实现配置提供器类，管理全局和项目配置加载与保存

   29--42 | method constructor
   └─ 初始化配置提供器，设置文件路径和默认配置值
   44--78 | method getEmbedderConfig
   └─ 获取嵌入器配置，支持OpenAI、Ollama和兼容提供商
   80--86 | method getVectorStoreConfig
   └─ 获取向量存储配置，返回Qdrant连接信息
   92--98 | method getSearchConfig
   └─ 返回搜索配置，包含最小分数和最大结果数
   104--114 | method onConfigChange
   └─ 注册配置变更回调，提供取消订阅功能
   119--124 | method ensureConfigLoaded
   └─ 确保配置已加载，实现缓存机制
   129--132 | method reloadConfig
   └─ 强制重新加载配置，清除缓存
   137--181 | method loadConfig
   └─ 加载全局和项目配置，合并默认值
   187--230 | method saveConfig
   └─ 保存配置到文件，保留JSONC注释并通知监听者
   235--240 | method updateConfig
   └─ 更新单个配置值，调用saveConfig实现
   259--289 | method isConfigured
   └─ 检查配置完整性，验证嵌入器和向量存储设置
   294--352 | method validateConfig
   └─ 验证配置有效性，返回错误列表和状态

---

# src/adapters/nodejs/event-bus.ts (56 lines)
└─ 实现Node.js事件总线适配器，使用EventEmitter提供事件发布订阅功能，支持监听器管理

   8--56 | class NodeEventBus
   └─ 实现IEventBus接口，使用Node.js EventEmitter提供事件总线功能

   11--15 | method constructor
   └─ 初始化EventEmitter实例，设置最大监听器数量避免警告
   21--28 | method on
   └─ 订阅事件并返回取消订阅函数，支持事件数据类型泛型
   34--41 | method once
   └─ 订阅一次性事件，返回取消订阅函数，确保事件只触发一次

---

# src/adapters/nodejs/file-system.ts (84 lines)
└─ 实现Node.js文件系统适配器，提供文件读写、目录操作和状态查询功能，使用fs/promises API封装底层操作

   9--83 | class NodeFileSystem
   └─ 实现文件系统接口，提供Node.js文件操作功能

   10--17 | method readFile
   └─ 读取文件内容并转换为Uint8Array，处理异常
   19--29 | method writeFile
   └─ 写入文件内容，自动创建目录，转换数据类型
   31--38 | method exists
   └─ 检查文件是否存在，使用fs.access方法
   40--52 | method stat
   └─ 获取文件状态信息，包括类型、大小和修改时间
   54--61 | method readdir
   └─ 读取目录内容并返回完整路径列表，处理异常并抛出错误
   63--69 | method mkdir
   └─ 递归创建目录，支持多级目录结构，确保目录存在
   71--82 | method delete
   └─ 根据文件类型删除文件或目录，支持递归删除目录内容

---

# src/adapters/nodejs/file-watcher.ts (88 lines)
└─ 使用Node.js fs.watch API实现文件和目录监听，支持事件回调和资源清理

   8--88 | class NodeFileWatcher
   └─ 实现文件系统监控接口，管理多个文件和目录观察器

   11--32 | method watchFile
   └─ 监控单个文件变化，返回清理函数，处理事件回调
   34--57 | method watchDirectory
   └─ 递归监控目录变化，构建完整文件路径，触发事件通知
   62--67 | method dispose
   └─ 清理所有活跃观察器，释放系统资源，防止内存泄漏
   76--87 | method mapEventType
   └─ 将Node.js事件类型映射为统一枚举，简化事件处理逻辑

---

# src/adapters/nodejs/index.ts (94 lines)
└─ 导出Node.js适配器模块，提供文件系统、存储、事件总线、日志、文件监视、工作区和配置功能。创建工厂函数生成平台依赖项，确保全局配置目录存在，初始化各种服务组件。提供简化工厂函数用于基本使用场景。

   29--76 | function createNodeDependencies
   └─ 创建Node.js依赖项，初始化文件系统、存储、事件总线等组件
   81--93 | function createSimpleNodeDependencies
   └─ 简化版工厂函数，创建基础Node.js依赖项并设置默认日志配置

---

# src/adapters/nodejs/logger.ts (105 lines)
└─ 实现Node.js日志适配器，支持多级别日志输出、时间戳、颜色格式化，提供灵活的日志配置选项。

   7--12 | interface NodeLoggerOptions
   └─ 定义日志配置接口，包含名称、级别、时间戳和颜色选项

   14--105 | class NodeLogger
   └─ 实现日志记录器类，支持多级别日志输出和格式化

   20--25 | property levels
   └─ 定义日志级别数值映射，用于控制日志输出过滤
   27--33 | property colorCodes
   └─ 定义ANSI颜色代码，为不同级别日志添加颜色标识

   35--40 | method constructor
   └─ 初始化日志实例，设置默认配置并检测终端颜色支持
   58--90 | method log
   └─ 根据日志级别过滤消息，格式化输出带时间戳、级别标识和颜色的日志信息，使用对应的控制台方法输出。

---

# src/adapters/nodejs/storage.ts (57 lines)
└─ 实现基于文件系统的Node.js存储适配器，提供全局存储和缓存路径管理功能，包含路径哈希生成逻辑。

   12--15 | interface NodeStorageOptions
   └─ 定义存储配置选项，包含全局存储路径和缓存基础路径的可选参数

   17--57 | class NodeStorage
   └─ 实现文件系统存储适配器，管理全局存储和缓存路径的初始化

   21--24 | method constructor
   └─ 初始化存储路径，优先使用配置路径，默认使用用户目录下的固定路径
   30--34 | method createCachePath
   └─ 根据工作区路径生成安全的缓存目录路径，使用哈希值确保唯一性
   40--46 | method hashWorkspacePath
   └─ 将工作区路径转换为安全的目录名，通过字符替换和简单哈希算法实现
   48--56 | method simpleHash
   └─ 实现字符串哈希算法，将输入字符串转换为32位十六进制哈希值，用于生成唯一目录名

---

# src/adapters/nodejs/workspace.ts (220 lines)
└─ 实现Node.js工作区适配器，提供文件系统操作、忽略规则处理和路径管理功能，支持gitignore语义和文件查找。

   11--14 | interface NodeWorkspaceOptions
   └─ 定义Node.js工作区适配器的配置选项，包含根路径和忽略文件列表

   16--186 | class NodeWorkspace
   └─ 实现IWorkspace接口，提供文件系统操作和忽略规则处理功能

   24--37 | property DEFAULT_IGNORES
   └─ 定义默认忽略模式列表，包含常见项目排除目录和文件

   39--43 | method constructor
   └─ 初始化工作区适配器，设置根路径、忽略文件和忽略实例
   49--52 | method getRelativePath
   └─ 计算相对于工作区根路径的相对路径，用于文件匹配和忽略规则判断
   62--80 | method getGlobIgnorePatterns
   └─ 将忽略规则转换为fast-glob格式，处理目录模式和通配符
   82--94 | method shouldIgnore
   └─ 检查文件路径是否被忽略，使用gitignore语义处理
   100--106 | method getWorkspaceFolders
   └─ 返回工作区文件夹信息，包含名称和路径
   108--124 | method findFiles
   └─ 根据模式查找文件，排除指定模式并应用忽略规则
   126--152 | method loadIgnoreRules
   └─ 加载忽略文件规则，解析内容并过滤注释行
   158--166 | method matchPattern
   └─ 将通配符模式转换为正则表达式，匹配文件路径或文件名
   168--185 | method walkDirectory
   └─ 递归遍历目录结构，处理文件和子目录回调

   188--220 | class NodePathUtils
   └─ 实现路径工具接口，提供文件路径操作方法

---

# src/code-index/constants/index.ts (101 lines)
└─ 定义代码索引默认配置，包括搜索参数、嵌入模型设置、文件处理限制和批处理策略，支持多种嵌入器类型和动态批大小调整。

   81--90 | function getBatchSizeForEmbedder
   └─ 根据嵌入器类型或实例动态返回最优批处理大小，优先使用实例自定义值，否则根据类型映射或默认阈值返回。

---

# src/code-index/constants/search-config.ts (25 lines)
└─ 定义搜索配置常量，包含分页限制和最小分数阈值，确保搜索参数在合理范围内。

   14--18 | type SearchLimits
   └─ 定义搜索结果数量限制的常量类型，包含默认、最大和最小值
   20--24 | type SearchMinScore
   └─ 定义搜索最小分数的常量类型，包含默认、最小和最大值

---

# src/code-index/embedders/gemini.ts (89 lines)
└─ 封装Gemini嵌入API，继承OpenAI兼容接口，支持模型配置和批量嵌入生成

   13--89 | class GeminiEmbedder
   └─ 实现Gemini嵌入器，封装OpenAI兼容接口，支持文本嵌入和配置验证

   24--39 | method constructor
   └─ 初始化Gemini嵌入器，验证API密钥，设置默认模型并创建兼容实例
   47--56 | method createEmbeddings
   └─ 创建文本嵌入，委托给OpenAI兼容实例，支持模型参数覆盖
   62--71 | method validateConfiguration
   └─ 验证配置，委托给OpenAI兼容实例，返回验证结果和错误信息
   76--80 | method embedderInfo
   └─ 返回嵌入器信息，提供名称标识符和推荐批处理大小
   85--88 | method optimalBatchSize
   └─ 返回Gemini嵌入器的推荐批处理大小，固定为40，用于优化API调用效率

---

# src/code-index/embedders/jina-embedder.ts (223 lines)
└─ 实现Jina AI嵌入器，支持批量处理、重试机制和配置验证，用于生成文本向量表示。

   9--21 | interface JinaEmbeddingResponse
   └─ 定义Jina AI嵌入响应的数据结构，包含模型、使用情况和嵌入数据

   26--222 | class JinaEmbedder
   └─ 实现Jina AI嵌入器接口，提供批量处理和速率限制功能

   32--42 | method constructor
   └─ 初始化Jina嵌入器，设置API密钥、模型ID和最优批量大小
   47--98 | method createEmbeddings
   └─ 创建文本嵌入，支持批量处理和令牌限制，优化API调用效率
   103--162 | method _embedBatchWithRetries
   └─ 处理批量嵌入请求，实现重试机制和指数退避策略，处理速率限制错误
   167--205 | method validateConfiguration
   └─ 验证Jina API连接性，测试配置有效性
   210--214 | method embedderInfo
   └─ 返回Jina嵌入器的基本信息标识

---

# src/code-index/embedders/mistral.ts (88 lines)
└─ 实现Mistral嵌入器，封装OpenAI兼容接口，支持codestral-embed-2505模型，提供文本嵌入和配置验证功能。

   12--88 | class MistralEmbedder
   └─ 实现Mistral嵌入器，封装OpenAI兼容接口，支持codestral-embed-2505模型

   23--38 | method constructor
   └─ 初始化Mistral嵌入器，验证API密钥，设置默认模型，创建兼容嵌入器实例
   46--55 | method createEmbeddings
   └─ 生成文本嵌入，支持动态模型选择，委托给OpenAI兼容嵌入器处理
   61--70 | method validateConfiguration
   └─ 验证配置有效性，委托给底层OpenAI兼容嵌入器执行检查
   75--79 | method embedderInfo
   └─ 返回嵌入器信息，标识为mistral名称，提供元数据
   84--87 | method optimalBatchSize
   └─ 返回Mistral嵌入器的推荐批处理大小为30，优化API调用效率

---

# src/code-index/embedders/ollama.ts (385 lines)
└─ 实现基于本地Ollama实例的代码嵌入器，支持批量文本嵌入、重试机制、代理配置和模型验证。

   17--384 | class CodeIndexOllamaEmbedder
   └─ 实现Ollama嵌入器类，提供文本向量化功能

   22--33 | method constructor
   └─ 初始化Ollama连接配置，设置默认模型和批处理大小
   41--66 | method createEmbeddings
   └─ 创建文本嵌入向量，支持重试机制和错误处理
   71--170 | method _createEmbeddingsWithTimeout
   └─ 执行嵌入请求，处理代理配置和超时控制
   175--199 | method _isRetryableError
   └─ 判断错误类型，决定是否可重试网络连接问题
   204--220 | method _formatEmbeddingError
   └─ 格式化Ollama嵌入错误，提供清晰的错误信息
   226--370 | method validateConfiguration
   └─ 验证Ollama配置，检查服务可用性和模型存在性
   372--376 | method embedderInfo
   └─ 返回Ollama嵌入器的基本信息标识

---

# src/code-index/embedders/openai-compatible.ts (522 lines)
└─ 实现OpenAI兼容的嵌入服务，支持批量处理、速率限制和代理配置，提供文本向量化功能

   15--18 | interface EmbeddingItem
   └─ 定义嵌入项接口，包含嵌入数据和其他任意属性
   20--26 | interface OpenAIEmbeddingResponse
   └─ 定义OpenAI兼容的响应接口，包含嵌入数据和可选的使用统计

   32--521 | class OpenAICompatibleEmbedder
   └─ 实现OpenAI兼容的嵌入器，支持批量处理和速率限制

   42--49 | property globalRateLimitState
   └─ 定义全局速率限制状态，包含互斥锁确保线程安全

   58--119 | method constructor
   └─ 构造函数初始化嵌入器，配置代理和客户端设置
   127--195 | method createEmbeddings
   └─ 处理文本嵌入请求，应用模型前缀并分批处理
   203--217 | method isFullEndpointUrl
   └─ 判断URL是否为完整端点URL，支持多种提供商模式
   227--280 | method makeDirectEmbeddingRequest
   └─ 直接发送HTTP请求到嵌入端点，处理认证和响应
   288--379 | method _embedBatchWithRetries
   └─ 执行嵌入请求，支持重试和全局速率限制
   385--420 | method validateConfiguration
   └─ 验证配置连通性，测试API密钥和端点可用性
   425--429 | method embedderInfo
   └─ 返回嵌入器名称标识
   441--468 | method waitForGlobalRateLimit
   └─ 等待全局速率限制解除
   473--502 | method updateGlobalRateLimitState
   └─ 更新全局速率限制状态
   507--520 | method getGlobalRateLimitDelay
   └─ 获取当前速率限制延迟时间

---

# src/code-index/embedders/openai.ts (261 lines)
└─ 实现OpenAI嵌入器，支持批量处理、重试机制和代理配置，处理文本嵌入生成和错误管理。

   18--260 | class OpenAiEmbedder
   └─ 实现OpenAI嵌入器接口，支持批量处理和代理配置

   27--75 | method constructor
   └─ 初始化OpenAI客户端，处理代理设置和API密钥配置
   83--151 | method createEmbeddings
   └─ 创建文本嵌入，应用前缀并分批处理以避免超限
   159--216 | method _embedBatchWithRetries
   └─ 重试机制处理批量嵌入，使用base64编码避免维度截断
   222--246 | method validateConfiguration
   └─ 验证配置有效性，测试最小嵌入请求是否成功
   248--252 | method embedderInfo
   └─ 返回嵌入器信息，标识为OpenAI实现

---

# src/code-index/embedders/openrouter.ts (380 lines)
└─ 实现OpenRouter嵌入器，支持批量处理、速率限制和重试机制，处理base64编码的嵌入向量转换。

   14--17 | interface EmbeddingItem
   └─ 定义嵌入项接口，包含嵌入数据和任意额外字段
   19--25 | interface OpenRouterEmbeddingResponse
   └─ 定义OpenRouter响应接口，包含嵌入数据和可选使用统计

   32--380 | class OpenRouterEmbedder
   └─ 实现OpenRouter嵌入器，支持批量处理和速率限制

   41--48 | property globalRateLimitState
   └─ 定义全局速率限制状态，包含错误计数和互斥锁

   56--82 | method constructor
   └─ 初始化OpenRouter嵌入器，配置API客户端和默认参数
   90--158 | method createEmbeddings
   └─ 处理文本前缀和分批，生成嵌入向量并统计使用量
   166--246 | method _embedBatchWithRetries
   └─ 实现重试机制和速率限制，处理base64编码的嵌入向量
   252--279 | method validateConfiguration
   └─ 验证配置有效性，测试API连接和响应
   284--288 | method embedderInfo
   └─ 返回嵌入器信息标识
   300--327 | method waitForGlobalRateLimit
   └─ 等待全局速率限制，管理并发访问状态
   332--361 | method updateGlobalRateLimitState
   └─ 更新全局速率限制状态，计算指数退避延迟
   366--379 | method getGlobalRateLimitDelay
   └─ 获取当前全局速率限制剩余延迟时间

---

# src/code-index/embedders/vercel-ai-gateway.ts (97 lines)
└─ 实现了Vercel AI Gateway嵌入器，封装OpenAI兼容接口，支持多种模型配置，提供文本嵌入和配置验证功能。

   21--97 | class VercelAiGatewayEmbedder
   └─ 实现IEmbedder接口，封装OpenAI兼容嵌入器，支持多种模型配置

   32--47 | method constructor
   └─ 初始化Vercel AI Gateway嵌入器，验证API密钥并设置默认模型
   55--64 | method createEmbeddings
   └─ 创建文本嵌入，委托给底层OpenAI兼容嵌入器处理
   70--79 | method validateConfiguration
   └─ 验证配置，委托给底层OpenAI兼容嵌入器执行
   84--88 | method embedderInfo
   └─ 返回嵌入器信息，标识为Vercel AI Gateway类型
   93--96 | method optimalBatchSize
   └─ 获取最优批处理大小，委托给底层OpenAI兼容嵌入器实现

---

# src/code-index/interfaces/cache.ts (38 lines)
└─ 定义缓存管理器接口，提供初始化、清空、获取、更新和删除文件哈希的功能，用于管理文件内容的缓存状态。

   1--37 | interface ICacheManager
   └─ 定义缓存管理器接口，提供初始化、清空、获取、更新和删除文件哈希的功能，用于管理文件变更缓存。

---

# src/code-index/interfaces/config.ts (293 lines)
└─ 定义代码索引配置接口，支持多种嵌入模型和向量存储，包含重排序器和摘要器配置，用于AI辅助代码搜索和理解。

   3--11 | type EmbedderProvider
   └─ 定义支持的嵌入模型提供商类型列表，包括OpenAI、Ollama等主流服务

   16--21 | interface OllamaEmbedderConfig
   └─ 配置Ollama嵌入模型参数，指定基础URL、模型名称和向量维度
   26--31 | interface OpenAIEmbedderConfig
   └─ 配置OpenAI嵌入模型参数，包含API密钥、模型名称和向量维度
   36--42 | interface OpenAICompatibleEmbedderConfig
   └─ 配置兼容OpenAI的嵌入模型参数，支持自定义基础URL和API密钥
   47--52 | interface JinaEmbedderConfig
   └─ 配置Jina嵌入模型参数，使用API密钥、模型名称和向量维度
   57--62 | interface GeminiEmbedderConfig
   └─ 定义 Gemini 嵌入器配置，包含 API 密钥、模型和维度参数
   67--72 | interface MistralEmbedderConfig
   └─ 定义 Mistral 嵌入器配置，包含 API 密钥、模型和维度参数
   77--82 | interface VercelAiGatewayEmbedderConfig
   └─ 定义 Vercel AI 嵌入器配置，包含 API 密钥、模型和维度参数
   87--92 | interface OpenRouterEmbedderConfig
   └─ 定义 OpenRouter 嵌入器配置，包含 API 密钥、模型和维度参数

   97--105 | type EmbedderConfig
   └─ 定义所有嵌入器配置的联合类型，支持多种嵌入器提供商

   110--177 | interface CodeIndexConfig
   └─ 定义代码索引功能的核心配置，包含嵌入器、向量存储、搜索和重排序器参数

   182--226 | type PreviousConfigSnapshot
   └─ 存储先前配置快照，用于检测配置变更并决定是否需要重启服务

   231--234 | interface VectorStoreConfig
   └─ 配置向量存储连接参数，支持Qdrant向量数据库
   239--242 | interface SearchConfig
   └─ 配置向量搜索参数，定义最小匹配分数和最大返回结果数
   248--292 | interface ConfigSnapshot
   └─ 实现配置快照接口，用于向后兼容的配置变更检测

---

# src/code-index/interfaces/embedder.ts (49 lines)
└─ 定义代码索引嵌入器接口，提供创建嵌入、验证配置和获取嵌入器信息的功能，支持多种嵌入服务提供商。

   5--26 | interface IEmbedder
   └─ 定义文本嵌入器接口，提供创建嵌入、验证配置和获取信息的方法
   28--34 | interface EmbeddingResponse
   └─ 封装嵌入响应数据，包含向量数组和可选的令牌使用统计

   36--44 | type AvailableEmbedders
   └─ 枚举支持的嵌入器类型，包括OpenAI、Ollama等AI服务提供商

---

# src/code-index/interfaces/file-processor.ts (145 lines)
└─ 定义代码文件解析、目录扫描和文件监听的核心接口，提供文件处理、批量操作和进度跟踪功能，支持代码块提取和向量存储集成。

   6--22 | interface ICodeParser
   └─ 定义代码文件解析器接口，将文件解析为代码块

   13--21 | method parseFile
   └─ 解析单个文件为代码块，支持自定义块大小和内容

   27--54 | interface IDirectoryScanner
   └─ 定义目录扫描器接口，扫描目录生成代码块

   34--46 | method scanDirectory
   └─ 扫描目录生成代码块，提供进度回调和统计信息

   59--105 | interface ICodeFileWatcher
   └─ 定义文件监视器接口，处理文件变更和批量处理
   107--112 | interface BatchProcessingSummary
   └─ 记录批量处理结果，包含文件处理状态和可能的批量错误
   114--121 | interface FileProcessingResult
   └─ 表示单个文件处理结果，包含路径、状态、错误信息和向量点数据
   127--130 | interface ParentContainer
   └─ 定义代码块的父容器结构，标识符和类型用于层级关系
   132--144 | interface CodeBlock
   └─ 表示代码块单元，包含文件位置、内容、哈希值和层级信息

---

# src/code-index/interfaces/index.ts (7 lines)
└─ 导出模块接口，包含嵌入器、向量存储、文件处理器、管理器、重排序器和摘要器的全部功能


---

# src/code-index/interfaces/manager.ts (92 lines)
└─ 定义代码索引管理器接口，提供索引状态管理、配置加载、索引启动、搜索和资源清理功能，支持多种嵌入模型提供商。

   10--74 | interface ICodeIndexManager
   └─ 定义代码索引管理器接口，提供索引状态管理、配置加载、索引启动、搜索和资源释放功能

   76--84 | type EmbedderProvider
   └─ 定义支持的嵌入模型提供商类型，包括OpenAI、Ollama、Gemini等AI服务

   86--91 | interface IndexProgressUpdate
   └─ 定义索引进度更新接口，包含系统状态、消息和已处理/总块数信息

---

# src/code-index/interfaces/reranker.ts (53 lines)
└─ 定义代码重排序器接口，包含候选结果、重排序结果、配置信息和核心重排序方法，支持多种模型提供商。

   5--10 | interface RerankerCandidate
   └─ 定义重排序候选对象，包含ID、内容和原始分数
   12--17 | interface RerankerResult
   └─ 定义重排序结果，包含ID、LLM评分和原始分数
   19--22 | interface RerankerInfo
   └─ 定义重排序器信息，包含名称和模型标识
   24--34 | interface RerankerConfig
   └─ 定义重排序器配置，支持多种提供商和参数设置
   36--52 | interface IReranker
   └─ 定义重排序器接口，实现重排序和配置验证逻辑

---

# src/code-index/interfaces/summarizer.ts (232 lines)
└─ 定义代码摘要生成器的接口和配置，支持单次和批量处理，包含请求、结果和配置结构体。

   4--35 | interface SummarizerRequest
   └─ 定义代码摘要请求参数，包含内容、文档上下文、语言和代码类型等字段
   40--50 | interface SummarizerResult
   └─ 封装摘要生成结果，包含摘要文本和实际使用的语言信息
   55--65 | interface SummarizerInfo
   └─ 提供摘要器提供商信息，包括名称和模型标识符
   70--135 | interface SummarizerConfig
   └─ 配置摘要器参数，支持多种提供商和性能调优选项
   140--177 | interface SummarizerBatchRequest
   └─ 批量处理多个代码块摘要请求，共享文档上下文提高效率
   182--197 | interface SummarizerBatchResult
   └─ 定义批量摘要结果结构，包含按顺序排列的摘要数组及对应语言信息
   203--231 | interface ISummarizer
   └─ 定义摘要器核心接口，实现单次和批量摘要生成、配置验证及信息获取功能

---

# src/code-index/interfaces/vector-store.ts (103 lines)
└─ 定义向量数据库客户端接口，提供初始化、向量搜索、数据管理等功能，支持代码索引和检索操作。

   4--8 | type PointStruct
   └─ 定义向量存储点的结构，包含唯一标识、数值向量和任意载荷数据

   10--82 | interface IVectorStore
   └─ 定义向量存储的核心接口，提供初始化、增删改查和状态管理功能

   29--32 | method search
   └─ 执行向量相似性搜索，支持过滤和结果限制

   84--88 | interface SearchFilter
   └─ 定义搜索过滤器，可按路径、分数和数量限制结果
   90--94 | interface VectorStoreSearchResult
   └─ 定义向量搜索结果结构，包含标识、分数和可选载荷
   96--102 | interface Payload
   └─ 定义代码块元数据，包含文件路径、代码内容、行号范围及扩展字段

---

# src/code-index/processors/batch-processor.ts (215 lines)
└─ 批量处理器类，实现文件删除、嵌入生成、向量存储和缓存更新，支持重试机制和进度回调。

   10--15 | interface BatchProcessingResult
   └─ 定义批量处理结果接口，记录处理成功和失败的文件数量及错误信息
   17--36 | interface BatchProcessorOptions
   └─ 配置批量处理器选项，包含嵌入器、向量存储和缓存管理器等核心组件

   46--214 | class BatchProcessor
   └─ 实现通用批量处理器，处理文件删除、嵌入生成和向量存储操作

   48--81 | method processBatch
   └─ 执行批量处理主流程，协调删除和处理两个阶段的操作
   83--117 | method handleDeletions
   └─ 处理文件删除逻辑，从向量存储和缓存中移除指定文件
   119--134 | method processItemsInBatches
   └─ 分批处理项目，动态调整批次大小避免内存问题
   136--213 | method processSingleBatch
   └─ 实现单批次处理逻辑，包含重试机制和错误处理

---

# src/code-index/processors/file-watcher.ts (581 lines)
└─ 实现文件监视器，监听工作区文件变化，批量处理创建、修改和删除事件，支持代码块解析、嵌入和向量存储。

   34--580 | class FileWatcher
   └─ 实现文件监控接口，监听文件变化并批量处理

   58--62 | property onBatchProgressUpdate
   └─ 报告批量处理进度，显示已处理文件数量和当前文件
   67--70 | property onBatchProgressBlocksUpdate
   └─ 报告批量处理进度，显示已处理代码块数量和总数

   86--123 | method constructor
   └─ 初始化文件监控器，设置依赖项和事件处理器
   128--157 | method initialize
   └─ 启动文件监控，监听文件创建、修改和删除事件
   162--169 | method dispose
   └─ 关闭文件监视器并清理定时器和事件队列
   175--178 | method handleFileCreated
   └─ 将创建事件加入处理队列并触发批量处理
   184--187 | method handleFileChanged
   └─ 将修改事件加入处理队列并触发批量处理
   193--196 | method handleFileDeleted
   └─ 将删除事件加入处理队列并触发批量处理
   201--206 | method scheduleBatchProcessing
   └─ 使用防抖机制调度批量处理以优化性能
   211--223 | method triggerBatchProcessing
   └─ 触发批量处理，清空事件队列并开始处理
   229--484 | method processBatch
   └─ 处理批量事件，读取文件内容并分类处理
   491--579 | method processFile
   └─ 处理单个文件，验证并解析代码块

---

# src/code-index/processors/index.ts (4 lines)
└─ 导出解析器、扫描器和文件监视器的模块，统一管理索引相关功能


---

# src/code-index/processors/parser.ts (1059 lines)
└─ 实现了代码解析器，支持多种编程语言和Markdown文件，通过Tree-sitter语法树分析代码结构，提取函数、类等定义块，并进行智能分块处理。

   46--50 | interface MarkdownHeader
   └─ 定义Markdown头部信息结构，包含层级、文本和行号

   55--1055 | class CodeParser
   └─ [Code too large to summarize (1001 lines)]

   67--101 | method parseFile
   └─ 解析文件入口，处理文件路径、内容获取和哈希计算
   128--319 | method parseContent
   └─ 核心解析逻辑，处理不同语言类型和分块策略
   324--500 | method _chunkTextByLines
   └─ 按行分块文本，处理超大行和重新平衡逻辑
   502--510 | method _performFallbackChunking
   └─ 执行后备分块，将内容按行分割为代码块
   512--548 | method _chunkLeafNodeByLines
   └─ 将语法节点按行分割，构建父链和层级显示
   555--594 | method _chunkDefinitionNodeByLines
   └─ 提取定义节点元数据，按行分块保持层级一致
   599--615 | method deduplicateBlocks
   └─ 按优先级去重，移除被包含的代码块
   623--632 | method buildParentChain
   └─ 根据上下文类型路由到父链构建方法
   637--689 | method buildTreeSitterParentChain
   └─ 遍历父节点构建容器类型层级链
   695--726 | method buildMarkdownParentChain
   └─ 构建Markdown标题的父子层级链，递归查找父级标题并构建层级关系
   739--780 | method extractNodeIdentifier
   └─ 从语法节点中提取标识符，支持字段名、子节点和JSON键等多种提取方式
   785--805 | method normalizeNodeType
   └─ 规范化语法节点类型，将声明和定义类型映射为统一的简洁类型名称
   810--825 | method buildHierarchyDisplay
   └─ 构建代码节点的层级显示字符串，包含父级链和当前节点的层级信息
   830--845 | method buildMarkdownHierarchyDisplay
   └─ 构建Markdown标题的层级显示字符串，使用精简的header_X格式展示层级关系
   850--860 | method updateHeaderStack
   └─ 维护markdown标题层级栈，移除同级或更低级标题，添加新标题
   865--870 | method isBlockContained
   └─ 检查代码块是否被其他块包含，用于去重逻辑
   875--944 | method processMarkdownSection
   └─ 处理markdown章节内容，根据大小决定分块或创建单个代码块
   946--1054 | method parseMarkdownContent
   └─ 解析markdown文件，提取标题和章节，构建层级关系并生成代码块

---

# src/code-index/processors/scanner.ts (470 lines)
└─ 实现目录扫描器，递归查找代码文件，过滤支持扩展名，并发处理文件解析和批量索引，管理缓存和错误处理。

   30--40 | interface DirectoryScannerDependencies
   └─ 定义扫描器依赖接口，包含嵌入器、向量存储、代码解析器等核心组件

   42--470 | class DirectoryScanner
   └─ 实现目录扫描器类，支持并发文件处理和批量索引操作

   46--57 | method constructor
   └─ 初始化扫描器，设置批处理阈值和依赖注入
   74--347 | method scanDirectory
   └─ 递归扫描目录，过滤文件并生成代码块，支持进度回调
   349--434 | method processBatch
   └─ 处理批量代码块，生成向量嵌入并存储到向量数据库
   436--469 | method getAllFilePaths
   └─ 递归获取目录下所有文件路径，过滤目录、忽略规则和扩展名限制，返回支持的文件列表

---

# src/code-index/rerankers/index.ts (3 lines)
└─ 导出ollama和openai兼容模块的索引文件，统一暴露外部接口


---

# src/code-index/rerankers/ollama.ts (440 lines)
└─ 实现基于Ollama LLM的代码重排序器，支持批量处理和代理配置，提供评分验证和降级策略。

   12--439 | class OllamaLLMReranker
   └─ 实现基于Ollama LLM的代码重排序器，支持批量处理和降级策略

   17--23 | method constructor
   └─ 初始化Ollama重排序器，配置基础URL、模型ID和批量大小参数
   31--67 | method rerank
   └─ 批量处理候选代码，按配置大小分块处理，支持错误降级和结果排序
   75--106 | method rerankSingleBatch
   └─ 单批次重排序逻辑，构建提示词调用Ollama API生成评分并排序结果
   111--140 | method buildScoringPrompt
   └─ 构建代码相关性评分提示词，定义评分标准并格式化输出JSON响应
   145--170 | method buildContextInfo
   └─ 构建候选代码的上下文信息，包含层次结构和文件路径
   175--261 | method generateScores
   └─ 调用Ollama API生成评分，处理代理设置和响应解析
   266--281 | method extractScoresFromText
   └─ 从文本中提取数字评分，确保数值在0-10范围内
   287--431 | method validateConfiguration
   └─ 验证Ollama服务可用性和模型能力，检查连接和模型存在
   433--438 | method rerankerInfo
   └─ 返回重排序器信息，包含名称和模型标识符

---

# src/code-index/rerankers/openai-compatible.ts (515 lines)
└─ 实现OpenAI兼容API的代码重排序器，支持批量处理和降级策略，通过LLM评分对候选结果进行重新排序。

   12--515 | class OpenAICompatibleReranker
   └─ 实现OpenAI兼容的LLM重排序器，支持批量处理和代理配置

   18--25 | method constructor
   └─ 初始化重排序器，配置基础URL、模型ID和批量大小参数
   33--69 | method rerank
   └─ 批量处理候选结果，支持错误回退和结果合并排序
   77--108 | method rerankSingleBatch
   └─ 单批次重排序逻辑，调用LLM评分并处理异常情况
   113--142 | method buildScoringPrompt
   └─ 构建评分提示词，定义评分标准和响应格式要求
   147--172 | method buildContextInfo
   └─ 构建候选代码的上下文信息，包含层次结构和文件路径
   177--285 | method generateScores
   └─ 调用OpenAI兼容API生成代码相关性分数，处理代理和超时
   290--305 | method extractScoresFromText
   └─ 从文本中提取并验证分数，确保数值在0-10范围内
   311--507 | method validateConfiguration
   └─ 验证OpenAI兼容服务配置，检查模型可用性和连接状态
   509--514 | method rerankerInfo
   └─ 返回重排序器信息，包含名称和模型标识符

---

# src/code-index/search/query-prefill.ts (37 lines)
└─ 为Qwen3嵌入模型提供查询预填充模板，指导模型生成更好的代码搜索嵌入。

   18--37 | function applyQueryPrefill
   └─ 检查提供者和模型ID，匹配qwen3-embedding模型时添加查询前缀模板，避免重复添加

---

# src/code-index/shared/get-relative-path.ts (32 lines)
└─ 生成标准化绝对路径，解析并规范化文件路径。生成相对文件路径，确保跨平台路径一致性。

   11--16 | function generateNormalizedAbsolutePath
   └─ 将文件路径解析为绝对路径并规范化，确保路径一致性
   26--31 | function generateRelativeFilePath
   └─ 生成从工作区根目录到文件的相对路径并规范化路径分隔符

---

# src/code-index/shared/openai-error-handler.ts (20 lines)
└─ 处理OpenAI API错误，特别是ByteString转换错误，返回格式化错误信息

   5--20 | function handleOpenAIError
   └─ 处理OpenAI API错误，检查API密钥格式和ByteString错误，返回格式化错误信息

---

# src/code-index/shared/supported-extensions.ts (35 lines)
└─ 定义文件扩展名扫描器和回退分块逻辑，支持多种编程语言的解析策略配置


---

# src/code-index/shared/validation-helpers.ts (212 lines)
└─ 提供错误消息清理、HTTP错误处理、状态码映射、验证错误处理等功能，用于统一处理和标准化嵌入服务验证过程中的错误信息。

   6--41 | function sanitizeErrorMessage
   └─ 清理错误消息中的敏感信息，包括URL、邮箱、IP地址和文件路径

   46--51 | interface HttpError
   └─ 定义HTTP错误接口，扩展Error并添加状态码和响应属性
   56--61 | interface ValidationError
   └─ 定义验证错误接口，包含状态码、消息、名称和错误代码

   66--83 | function getErrorMessageForStatus
   └─ 根据HTTP状态码返回对应的错误消息，支持不同嵌入器类型
   88--104 | function extractStatusCode
   └─ 从错误对象中提取状态码，支持直接属性、响应属性和消息解析
   109--127 | function extractErrorMessage
   └─ 提取错误消息，优先返回message属性，支持字符串和对象转换
   133--181 | function handleValidationError
   └─ 处理验证错误，支持自定义处理，按状态码和连接错误分类处理
   186--196 | function withValidationErrorHandling
   └─ 包装异步验证函数，捕获异常并调用标准错误处理
   201--212 | function formatEmbeddingError
   └─ 格式化嵌入错误，根据状态码生成认证或重试失败消息

---

# src/code-index/summarizers/index.ts (3 lines)
└─ 导出Ollama和OpenAI兼容的摘要器模块，提供统一的接口访问


---

# src/code-index/summarizers/ollama.ts (424 lines)
└─ 实现了基于本地Ollama大语言模型的代码摘要生成器，支持批量处理和代理配置。

   11--423 | class OllamaSummarizer
   └─ 实现基于Ollama的代码摘要生成器，支持批量处理和代理配置

   17--29 | method constructor
   └─ 初始化Ollama服务连接参数，包括基础URL、模型ID和语言设置
   35--50 | method summarize
   └─ 将单个代码请求转换为批量格式，统一处理并返回第一个结果
   56--104 | method buildPrompt
   └─ 构建结构化提示模板，支持多语言输出和JSON格式化要求
   111--155 | method extractCompleteJsonObject
   └─ 使用栈匹配算法从文本中提取完整的JSON对象，处理嵌套结构
   161--289 | method summarizeBatch
   └─ 批量处理代码摘要请求，构建提示并发送至Ollama API，解析响应并验证格式
   294--415 | method validateConfiguration
   └─ 验证Ollama服务配置，检查模型存在性及生成能力，支持代理连接和超时控制
   417--422 | method summarizerInfo
   └─ 返回摘要器信息，包含名称和模型标识符，用于系统识别和配置管理

---

# src/code-index/summarizers/openai-compatible.ts (402 lines)
└─ 实现了基于OpenAI兼容API的代码摘要生成器，支持批量处理和代理配置，包含JSON提取和超时控制。

   13--57 | function extractCompleteJsonObject
   └─ 解析文本中的完整JSON对象，处理嵌套结构和转义字符

   63--402 | class OpenAICompatibleSummarizer
   └─ 实现OpenAI兼容接口的代码摘要生成器，支持批量处理和代理配置

   70--84 | method constructor
   └─ 初始化摘要器配置，设置API端点、模型和语言参数
   90--105 | method summarize
   └─ 将单个请求转换为批量处理，统一调用批量摘要方法
   111--159 | method buildPrompt
   └─ 构建结构化提示模板，整合代码片段和输出格式要求
   165--306 | method summarizeBatch
   └─ 批量处理代码摘要请求，构建提示并发送至OpenAI兼容API，解析响应并验证格式
   311--394 | method validateConfiguration
   └─ 验证OpenAI兼容API配置，测试连接可用性并返回验证结果或错误信息
   396--401 | method summarizerInfo
   └─ 返回摘要器信息，包含名称和模型标识符

---

# src/code-index/vector-store/qdrant-client.ts (817 lines)
└─ 实现Qdrant向量存储接口，提供向量索引、搜索、删除等功能，支持路径过滤和元数据管理。

   18--120 | class PatternCompiler
   └─ 编译路径过滤器为Qdrant查询结构，支持包含和排除模式

   24--68 | method compile
   └─ 处理包含和排除路径模式，构建should和must_not子句
   75--88 | method expandPattern
   └─ 扩展花括号模式如{a,b}为多个独立模式
   95--119 | method extractSubstrings
   └─ 从模式中提取有效子字符串，过滤通配符和字符类

   125--816 | class QdrantVectorStore
   └─ 实现Qdrant向量存储，支持索引、搜索和删除操作

   141--187 | method constructor
   └─ 构造函数处理向后兼容性，初始化Qdrant客户端并生成集合名称
   189--202 | method getCollectionInfo
   └─ 获取集合信息，处理异常情况并返回null
   208--226 | method isCollectionNotFoundError
   └─ 检测错误是否为集合不存在，通过状态码和消息判断
   232--294 | method initialize
   └─ 初始化向量存储，检查集合存在性和向量维度，创建索引
   301--370 | method _recreateCollectionWithNewDimension
   └─ 重新创建集合处理维度不匹配，包含删除、验证和重建步骤
   375--425 | method _createPayloadIndexes
   └─ 创建关键字段索引，支持元数据过滤和路径匹配
   431--481 | method upsertPoints
   └─ 处理代码块数据，生成路径段和哈希ID用于唯一标识
   488--495 | method isPayloadValid
   └─ 验证载荷完整性，确保必要字段存在
   503--550 | method search
   └─ 构建搜索过滤器，合并路径和元数据条件
   560--622 | method deletePointsByMultipleFilePaths
   └─ 删除指定文件路径的数据点，使用相对路径匹配
   627--637 | method deleteCollection
   └─ 删除整个向量存储集合，存在时执行删除操作
   642--660 | method clearCollection
   └─ 清空集合中的所有向量点，使用空过滤器删除全部数据
   666--669 | method collectionExists
   └─ 检查向量存储集合是否存在，返回布尔值结果
   671--701 | method getAllFilePaths
   └─ 获取集合中所有文件路径，通过分页查询收集唯一路径
   707--741 | method hasIndexedData
   └─ 检查集合是否有已索引数据，验证索引完成状态和点数量
   747--778 | method markIndexingComplete
   └─ 创建元数据点标记索引完成，使用UUIDv5生成唯一ID
   784--815 | method markIndexingIncomplete
   └─ 创建元数据点标记索引进行中，使用UUIDv5生成唯一ID

---

# src/tree-sitter/queries/c-sharp.ts (66 lines)
└─ 定义C#语言Tree-Sitter查询模式，包括命名空间、类、接口、方法等元素的语义规则，支持代码结构分析和定义查找。


---

# src/tree-sitter/queries/c.ts (91 lines)
└─ 定义C语言语法查询规则，涵盖函数、结构体、联合体、枚举、类型别名、变量和宏的语义标记，支持代码分析和导航。


---

# src/tree-sitter/queries/cpp.ts (97 lines)
└─ 定义C++语言结构查询规则，识别类、函数、变量等声明，支持代码分析和导航功能。


---

# src/tree-sitter/queries/css.ts (72 lines)
└─ 定义CSS Tree-Sitter查询模式，匹配规则集、媒体查询、关键帧、变量等元素，支持语义化命名和条件过滤。


---

# src/tree-sitter/queries/elisp.ts (41 lines)
└─ 定义Emacs Lisp查询模式，捕获函数、宏、自定义变量、面、组和建议的定义名称，排除注释行。


---

# src/tree-sitter/queries/elixir.ts (71 lines)
└─ 定义Elixir语言的Tree-sitter查询规则，识别模块、函数、宏、结构体、守卫、行为回调、字面量、模块属性、测试、管道操作符和for推导式等语法结构，用于代码分析和语义标注。


---

# src/tree-sitter/queries/embedded_template.ts (20 lines)
└─ 定义树查询语法，匹配代码块、输出块和注释指令，实现模板结构解析


---

# src/tree-sitter/queries/go.ts (24 lines)
└─ 定义Go语言Tree-Sitter查询模式，捕获包、导入、类型、函数等顶层声明节点。


---

# src/tree-sitter/queries/html.ts (52 lines)
└─ 定义HTML文档结构查询规则，识别元素、脚本、样式、属性、注释等节点类型，支持嵌套元素和自闭合标签。


---

# src/tree-sitter/queries/index.ts (29 lines)
└─ 导出多种编程语言的Tree-sitter查询模块，包括Solidity、PHP、Vue、TypeScript等，为代码分析提供语言特定的查询逻辑。


---

# src/tree-sitter/queries/java.ts (77 lines)
└─ 定义Java语言结构的查询模式，包括模块、包、类、接口、枚举、记录、注解、构造函数、方法、内部类、静态嵌套类、lambda表达式、字段、导入和类型参数的语义规则。


---

# src/tree-sitter/queries/javascript.ts (131 lines)
└─ 定义JavaScript语言的Tree-sitter查询规则，捕获类、方法、函数、装饰器及JSON结构，支持文档注释关联和类型标记。


---

# src/tree-sitter/queries/kotlin.ts (111 lines)
└─ 定义Kotlin语言的各种语法结构查询规则，包括类、接口、函数、对象、属性等声明类型的语义节点和定义标记。


---

# src/tree-sitter/queries/lua.ts (38 lines)
└─ 定义Lua函数、表构造器、变量声明的Tree-sitter查询规则，实现语法结构识别与语义标记。


---

# src/tree-sitter/queries/ocaml.ts (32 lines)
└─ 定义模块、类型、函数、类、方法和值绑定的查询规则，实现OCaml语言的语义分析


---

# src/tree-sitter/queries/php.ts (173 lines)
└─ 定义PHP语言结构查询规则，捕获类、接口、方法、属性等构造，支持代码导航和分析


---

# src/tree-sitter/queries/python.ts (89 lines)
└─ 定义Python语法树查询模式，捕获类、函数、lambda、生成器、推导式、with语句、try语句、导入语句、全局/非局部语句、match case语句、类型注解和文档字符串的语义节点。


---

# src/tree-sitter/queries/ruby.ts (205 lines)
└─ 定义Ruby语言语法查询规则，捕获方法、类、模块、变量等元素，支持元编程和特殊语法模式。


---

# src/tree-sitter/queries/rust.ts (81 lines)
└─ 定义Rust语言结构查询规则，捕获函数、结构体、枚举、特征等所有核心构造的语义节点，用于tree-sitter解析和测试。


---

# src/tree-sitter/queries/scala.ts (45 lines)
└─ 定义Scala语言语法查询规则，识别类、对象、特征、方法、变量、类型和命名空间的定义节点，用于代码分析和索引。


---

# src/tree-sitter/queries/solidity.ts (45 lines)
└─ 定义Solidity语言的Tree-sitter查询规则，捕获合约、函数、变量等元素的语义节点，支持语言分析工具的代码理解与导航。


---

# src/tree-sitter/queries/swift.ts (79 lines)
└─ 定义Swift语言树查询模式，捕获类、结构体、协议、扩展、方法、属性、初始化器、下标、类型别名等构造的语义节点，用于代码解析和定义识别。


---

# src/tree-sitter/queries/systemrdl.ts (34 lines)
└─ 定义SystemRDL语法查询规则，识别组件、字段、属性、参数和枚举声明，实现语法树节点标记


---

# src/tree-sitter/queries/tlaplus.ts (33 lines)
└─ 定义TLA+语言的语法查询规则，支持模块、操作符、函数、变量和常量的语义标记与定义识别。


---

# src/tree-sitter/queries/toml.ts (25 lines)
└─ 定义TOML语法元素的查询模式，捕获表、键值对、数组和基本值等节点作为定义点。


---

# src/tree-sitter/queries/tsx.ts (88 lines)
└─ 定义TSX文件中React组件的Tree-sitter查询，包括函数组件、类组件、接口、类型别名、JSX元素和泛型组件的语义规则。


---

# src/tree-sitter/queries/typescript.ts (124 lines)
└─ 定义TypeScript语法查询规则，捕获函数、类、接口、枚举等结构，支持测试用例和装饰器识别，实现代码语义分析


---

# src/tree-sitter/queries/vue.ts (30 lines)
└─ 定义Vue组件、模板、脚本和样式的语法查询规则，实现Tree-sitter对Vue文件的结构化解析


---

# src/tree-sitter/queries/zig.ts (22 lines)
└─ 定义Zig语言的Tree-sitter查询规则，识别函数、结构体、枚举和变量声明，实现语法高亮和代码分析功能。


---
