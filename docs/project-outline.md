# src/cli.ts (41 lines)
└─ 定义CLI入口程序，使用commander.js创建子命令模式，整合搜索、索引、大纲等工具功能，提供命令行接口。

   16--34 | function main
   └─ 初始化CLI程序，配置名称、描述和版本，添加搜索、索引、大纲、stdio、配置和调用子命令，解析命令行参数

---

# src/index.ts (14 lines)
└─ 导出库中所有核心模块，包括代码索引、抽象层、Node.js适配器、全局处理、搜索功能、Tree-sitter集成、代码库实现和依赖管理。


---

# src/abstractions/config.ts (52 lines)
└─ 配置类型从接口文件重新导出，定义配置提供者抽象接口，获取配置并监听变更，支持多种嵌入器配置

   22--32 | interface IConfigProvider
   └─ 配置提供者抽象接口，定义获取和监听配置的核心方法，支持异步加载与变更回调

---

# src/abstractions/core.ts (117 lines)
└─ 定义跨平台文件系统操作的核心接口，提供读写、检查、统计、目录管理等基础功能。定义存储操作、事件系统、日志记录、文件监控等核心抽象接口。整合所有平台依赖项，提供统一的基础设施接口。

   4--64 | interface IFileSystem
   └─ 提供跨平台文件系统操作接口，支持读写、统计、目录管理等核心功能。
   69--73 | interface IStorage
   └─ 管理全局存储路径和缓存路径，为数据持久化提供统一存储方案。
   78--83 | interface IEventBus
   └─ 实现事件发布订阅机制，支持多组件间异步通信和数据传递。
   88--93 | interface ILogger
   └─ 提供分级日志记录功能，支持调试、信息、警告和错误级别输出。
   98--101 | interface IFileWatcher
   └─ 监听文件和目录变化事件，实现实时文件系统状态更新机制。
   103--106 | interface FileWatchEvent
   └─ 定义文件事件通知接口，描述文件创建、修改、删除事件类型
   111--117 | interface IPlatformDependencies
   └─ 实现平台依赖注入容器，组合文件系统、存储、事件总线等核心组件

---

# src/abstractions/index.ts (35 lines)
└─ 导出平台无关核心抽象，包括文件系统、存储、事件总线、日志、文件监听等接口，提供跨平台基础功能抽象


---

# src/abstractions/workspace.ts (105 lines)
└─ 定义平台无关的 workspace 抽象接口，提供根路径管理、忽略规则处理、文件查找等核心功能，支持多根工作区和路径工具操作。

   6--54 | interface IWorkspace
   └─ 定义工作空间核心接口，提供路径管理、忽略规则处理和多根工作空间支持
   56--60 | interface WorkspaceFolder
   └─ 表示工作空间文件夹，包含名称、URI和索引标识
   65--105 | interface IPathUtils
   └─ 实现路径工具方法，提供路径拼接、解析和格式化等操作

---

# src/cli-tools/data-flow-analyzer.ts (698 lines)
└─ 定义数据流节点和边的数据结构，用于存储函数、类等组件及其调用关系。实现数据流分析器的核心逻辑，递归追踪组件调用链，生成可视化文本树和JSON结果。识别CLI和MCP入口点，分析核心组件创建和调用关系。

   6--13 | interface DataFlowNode
   └─ 定义数据流节点结构，包含ID、文件位置、类型和层级信息
   18--23 | interface DataFlowEdge
   └─ 定义数据流边结构，表示节点间的调用关系和异步特性
   28--33 | interface AnalysisResult
   └─ 定义分析结果结构，包含节点、边和文本/JSON输出

   43--681 | class DataFlowAnalyzer
   └─ 实现数据流分析器核心类，管理节点映射和调用链追踪

   50--55 | method constructor
   └─ 初始化TypeScript项目，配置tsconfig文件路径和加载选项
   60--78 | method analyze
   └─ 启动数据流分析，识别入口点并生成结果
   83--111 | method analyzeCliMain
   └─ 分析CLI主入口，定位main函数并追踪调用链
   116--158 | method analyzeMcpServer
   └─ 解析MCP服务器入口点，识别HTTP和Stdio适配器启动函数
   163--190 | method analyzePublicApi
   └─ 分析公开API，识别CodeIndexManager的关键方法
   195--249 | method analyzeCallChain
   └─ 递归分析调用链，提取目标信息并构建数据流图
   254--264 | method isBuiltinCall
   └─ 过滤内置函数调用，排除标准库和工具函数
   269--313 | method isImportantCall
   └─ 识别重要调用模式，聚焦核心组件和关键操作
   318--370 | method extractTarget
   └─ 解析调用目标信息，生成节点ID和关系类型
   375--562 | method findTargetNode
   └─ 查找目标节点并添加到图中，处理多种导出情况
   567--575 | method identifyLayer
   └─ 根据文件路径识别组件层级，划分架构层次
   580--589 | method isAsyncCall
   └─ 检测调用表达式是否被await关键字包裹，判断是否为异步调用
   594--599 | method addNode
   └─ 将数据流节点添加到内部映射中，确保节点唯一性并返回节点ID
   604--680 | method generateTextTree
   └─ 构建邻接表并递归生成树状文本输出，展示调用层次和异步标记

   686--689 | function generateDataFlowDiagram
   └─ 创建数据流分析器实例并执行分析，返回包含节点和边的分析结果

---

# src/cli-tools/outline-targets.ts (119 lines)
└─ 解析代码大纲目标，支持文件路径和glob模式，处理忽略规则和目录展开。

   5--9 | type LoggerLike
   └─ 定义日志记录器类型，支持调试、信息和警告方法

   11--19 | interface ResolveOutlineTargetsOptions
   └─ 配置解析轮廓目标的选项，包含输入路径和工作区信息
   21--35 | interface ResolveOutlineTargetsResult
   └─ 描述轮廓目标结果，包含文件路径和模式信息

   45--118 | function resolveOutlineTargets
   └─ 实现轮廓目标解析逻辑，处理文件路径和通配符模式

---

# src/cli-tools/outline.ts (952 lines)
└─ CLI工具：代码大纲提取器，使用tree-sitter解析源文件结构，支持文本和JSON格式输出及AI摘要功能。

   31--61 | interface OutlineOptions
   └─ 定义代码大纲提取的配置参数，包含文件路径、输出格式、摘要选项等核心设置
   66--74 | interface OutlineDefinition
   └─ 表示代码结构定义，包含名称、类型、行号范围、完整代码内容和可选摘要
   79--86 | interface OutlineData
   └─ 封装文件级大纲数据，包含文件路径、语言、完整内容和所有结构化定义

   94--135 | function extractOutline
   └─ 执行大纲提取的主入口，处理路径解析、文件验证和格式分发逻辑
   137--151 | function createFallbackWorkspace
   └─ 创建基本工作区适配器，提供路径解析和忽略规则处理，支持单文件模式。
   164--221 | function getOutlineAsText
   └─ 生成文本格式代码大纲，支持AI摘要和缓存管理
   233--284 | function getOutlineAsJson
   └─ 生成JSON格式代码大纲，复用文本处理逻辑并输出结构化数据
   290--340 | function buildOutlineDefinitions
   └─ 解析文件内容并提取代码定义，支持Markdown和tree-sitter解析
   345--464 | function extractDefinitionsFromCaptures
   └─ 从tree-sitter捕获中提取结构化定义，过滤docstring并映射标识符
   469--511 | function renderDefinitionsAsText
   └─ 渲染文本大纲，支持文件摘要和函数详情的紧凑显示
   516--539 | function renderDefinitionsAsJson
   └─ 将代码结构数据转换为JSON格式，支持摘要截断和标题模式
   544--564 | function createStorageForOutline
   └─ 为代码大纲工具创建存储抽象层，加载配置并返回存储实例
   569--613 | function createSummarizerForOutline
   └─ 创建AI摘要器实例，处理配置路径并初始化相关服务
   618--645 | function loadSummarizerConfig
   └─ 加载摘要器配置，通过配置管理器访问摘要相关设置
   656--809 | function generateSummariesWithRetry
   └─ 批量生成代码摘要，支持并发控制、重试机制和降级处理
   811--951 | function applySummaryCache
   └─ 管理AI摘要缓存，支持缓存命中检查、批量生成和错误处理，优化代码摘要性能

---

# src/cli-tools/summary-cache.ts (670 lines)
└─ 实现AI代码摘要缓存管理器，使用两级哈希机制避免冗余LLM调用，支持文件级和代码块级缓存检测，提供缓存加载、更新、清理等功能。

   25--31 | interface CacheFingerprint
   └─ 定义缓存配置指纹，包含AI模型参数和语言设置，用于检测配置变更
   36--45 | interface BlockSummary
   └─ 表示代码块摘要缓存条目，包含内容哈希、摘要和元数据信息
   50--57 | interface SummaryCache
   └─ 存储文件级摘要缓存，包含版本、配置指纹、文件哈希和块级摘要
   62--67 | interface CacheStats
   └─ 统计缓存命中情况，记录总块数、缓存块数和命中率
   72--76 | interface FilterResult
   └─ 返回需要摘要处理的代码块，包含过滤结果和缓存统计信息
   81--88 | interface CodeBlock
   └─ 定义代码块结构，包含名称、类型、行号范围和完整文本

   111--669 | class SummaryCacheManager
   └─ 管理AI代码摘要缓存，实现两级哈希机制避免冗余调用

   115--119 | property logger
   └─ 提供日志记录功能，支持信息、错误和警告输出

   121--135 | method constructor
   └─ 初始化缓存管理器，设置工作路径、存储和文件系统接口
   144--148 | method hashBlock
   └─ 计算代码块SHA256哈希值，用于缓存键和内容验证
   153--157 | method hashFile
   └─ 计算文件内容的SHA256哈希值，用于文件级缓存验证
   169--179 | method createFingerprint
   └─ 根据配置生成缓存指纹，包含模型、语言等影响输出的参数
   192--221 | method getCachePathForSourceFile
   └─ 构建缓存文件路径，包含项目哈希和相对路径，防止路径遍历攻击
   230--254 | method loadCache
   └─ 加载并验证缓存文件，检查版本匹配，处理异常情况
   265--366 | method filterBlocksNeedingSummarization
   └─ 过滤需要重新生成的代码块，实现两级缓存命中检测逻辑
   371--462 | method updateCache
   └─ 实现缓存更新逻辑，构建块级缓存并应用大小限制，使用原子操作确保文件写入安全
   471--535 | method cleanOrphanedCaches
   └─ 扫描缓存目录，删除与源文件不匹配的孤立缓存文件，保持缓存与项目文件同步
   540--606 | method cleanOldCaches
   └─ 清理超过指定天数的旧缓存文件，基于最后访问时间进行LRU淘汰策略
   616--668 | method clearAllCaches
   └─ 删除整个项目的缓存目录，强制重新生成所有AI摘要，提供缓存重置功能

---

# src/commands/call.ts (533 lines)
└─ 实现代码依赖分析命令，支持总结显示、数据导出、图形可视化和依赖查询功能。

   39--67 | function openGraphViewer
   └─ 检测运行环境，解析图形查看器路径，验证文件存在性并在浏览器中打开
   72--168 | function displaySummary
   └─ 分析依赖结果，统计组件类型和模块依赖，分类展示解析与未解析的依赖关系
   173--204 | function exportData
   └─ 生成可视化数据，导出JSON文件，可选择在浏览器中打开图形查看器
   209--243 | function querySingleFunction
   └─ 查找匹配节点，遍历查询每个节点，格式化输出单函数依赖分析结果
   248--261 | function queryMultipleFunctions
   └─ 分析多函数之间的连接关系，输出依赖关系分析结果
   266--289 | function queryMode
   └─ 解析查询模式，根据模式数量和通配符选择单函数查询或多函数连接分析
   300--487 | function callHandler
   └─ 处理依赖分析命令，初始化环境、路径解析、缓存管理及多模式分发逻辑
   498--532 | function createCallCommand
   └─ 创建CLI命令，定义依赖分析的各种参数选项和帮助文档

---

# src/commands/index.ts (412 lines)
└─ 实现代码库索引命令，支持多种模式：正常索引、预览分析、清理缓存、启动MCP服务器和监控文件变化。

   13--35 | function initializeManagerForDryRun
   └─ 初始化代码索引管理器，配置依赖项并加载配置
   40--227 | function performIndexDryRun
   └─ 执行代码索引预运行分析，统计文件状态并生成详细报告
   232--385 | function indexHandler
   └─ 处理索引命令参数，管理不同模式下的代码索引流程
   390--411 | function createIndexCommand
   └─ 创建命令行接口，定义索引命令的参数和选项配置

---

# src/commands/outline.ts (195 lines)
└─ 实现outline命令，处理文件路径或通配符模式，提取代码大纲，支持AI摘要和缓存管理

   11--106 | function handleOutline
   └─ 处理代码大纲提取，解析文件模式，支持批量处理和缓存清理
   111--169 | function outlineHandler
   └─ 配置命令参数，初始化日志，处理缓存清理和演示文件准备
   174--194 | function createOutlineCommand
   └─ 创建命令行工具，定义大纲提取的参数选项和处理器

---

# src/commands/search.ts (303 lines)
└─ 实现代码搜索命令，支持语义搜索、结果格式化、路径过滤和JSON输出

   10--19 | interface SearchResult
   └─ 定义搜索结果接口，包含文件路径、代码片段、行号范围和相似度分数。

   24--105 | function formatSearchResults
   └─ 格式化搜索结果，按文件分组、去重排序，输出可读性强的代码片段展示。
   110--175 | function formatSearchResultsAsJson
   └─ 将搜索结果格式化为JSON输出，包含去重信息和详细元数据。
   180--278 | function searchHandler
   └─ 执行搜索命令处理逻辑，初始化搜索参数、调用搜索引擎并输出格式化结果。
   283--302 | function createSearchCommand
   └─ 创建搜索命令行接口，定义命令参数选项和对应的用户交互逻辑。

---

# src/commands/shared.ts (187 lines)
└─ 定义CLI命令的共享工具和类型，包括日志管理、路径解析、依赖创建、演示文件处理和代码索引管理器初始化等功能。

   12--40 | interface CommandOptions
   └─ 定义CLI命令的配置选项接口，包含路径、服务器、日志等配置参数

   45--53 | function initGlobalLogger
   └─ 根据日志级别初始化全局日志记录器，设置名称、级别和时间戳
   65--72 | function resolveWorkspacePath
   └─ 解析输入路径为绝对路径，demo模式下添加demo子目录路径
   77--96 | function createDependencies
   └─ 基于配置选项创建Node.js依赖项，设置工作空间和存储选项
   104--113 | function ensureDemoFiles
   └─ 检查工作空间是否存在，不存在时创建目录并生成示例文件用于演示
   118--155 | function initializeManager
   └─ 初始化代码索引管理器，创建依赖、加载配置并启动索引
   160--186 | function waitForIndexingCompletion
   └─ 等待索引完成，轮询状态并处理不同结果

---

# src/commands/stdio.ts (59 lines)
└─ stdio命令实现，创建stdio适配器桥接stdio与HTTP MCP服务器，处理信号关闭，支持超时配置和日志级别设置

   11--40 | function stdioHandler
   └─ 初始化日志系统，配置目标URL和超时时间，创建适配器，处理信号，启动适配器保持运行。
   45--58 | function createStdioCommand
   └─ 配置stdio命令行工具，定义选项参数如服务器URL、端口、超时和日志级别，关联处理函数。

---

# src/code-index/cache-manager.ts (138 lines)
└─ 实现代码索引缓存管理，支持文件哈希存储、异步保存、缓存清理和批量操作，使用防抖优化性能。

   14--137 | class CacheManager
   └─ 实现缓存管理接口，管理文件哈希映射和持久化存储

   23--30 | method constructor
   └─ 初始化缓存管理器，创建唯一缓存路径并设置防抖保存函数
   51--58 | method initialize
   └─ 加载缓存文件到内存，解析JSON数据构建文件哈希映射
   63--71 | method _performSave
   └─ 将内存中的哈希映射序列化为JSON并写入缓存文件
   77--89 | method clearCacheFile
   └─ 删除缓存文件并重置内存中的哈希映射状态
   105--108 | method updateHash
   └─ 更新文件哈希值并触发防抖保存缓存
   114--117 | method deleteHash
   └─ 删除指定文件哈希值并触发防抖保存缓存
   123--128 | method deleteHashes
   └─ 批量删除多个文件哈希值并触发防抖保存缓存

---

# src/code-index/config-manager.ts (530 lines)
└─ 管理代码索引配置，处理加载、验证和重启检测，支持多种嵌入器和重排序器配置。

   69--81 | function getConfigValue
   └─ 安全获取配置值，处理嵌套对象和原始值

   87--509 | class CodeIndexConfigManager
   └─ 管理代码索引配置，处理加载、验证和重启检测

   90--94 | method constructor
   └─ 异步初始化配置管理器，避免重启触发
   120--138 | method loadConfiguration
   └─ 加载配置并检测是否需要重启服务
   143--172 | method isConfigured
   └─ 验证不同AI提供商的配置完整性
   177--230 | method _createConfigSnapshot
   └─ 创建配置快照，保存关键配置项用于重启检测
   235--328 | method doesConfigChangeRequireRestart
   └─ 判断配置变更是否需要重启，处理启用/禁用状态变化
   333--356 | method _hasVectorDimensionChanged
   └─ 检测模型维度变化，确保向量兼容性
   361--366 | method getConfig
   └─ 获取当前配置，提供默认值避免空指针
   400--413 | method currentModelDimension
   └─ 计算当前模型维度，优先使用内置维度值
   420--432 | method currentSearchMinScore
   └─ 实现搜索最小分数获取逻辑，优先使用用户配置，其次模型阈值，最后默认值
   439--442 | method currentSearchMaxResults
   └─ 获取搜索最大结果数，使用验证函数确保数值在有效范围内
   454--479 | method rerankerConfig
   └─ 返回重排序器配置，仅在启用且提供提供者时返回完整配置对象
   486--503 | method summarizerConfig
   └─ 返回总结器配置，始终返回配置对象，缺失值使用默认值填充

---

# src/code-index/config-validator.ts (434 lines)
└─ 配置验证器类，验证嵌入器、Qdrant、重排序器和摘要器配置，确保参数完整性和数值范围正确。

   6--22 | interface ValidationIssue
   └─ 定义配置验证问题的数据结构，包含路径、错误码和消息
   27--37 | interface ValidationResult
   └─ 定义配置验证结果的数据结构，包含有效性和问题列表

   42--433 | class ConfigValidator
   └─ 实现配置验证器类，集中管理所有验证逻辑

   48--70 | method validate
   └─ 验证完整配置，依次检查嵌入器、Qdrant、重排序器和摘要器
   75--174 | method validateEmbedder
   └─ 验证嵌入器配置，根据不同提供商检查必需的API密钥和URL
   179--187 | method validateQdrant
   └─ 验证Qdrant向量存储配置，确保URL必填
   192--247 | method validateReranker
   └─ 验证重排序器配置，根据提供商检查必填字段
   254--320 | method validateSummarizer
   └─ 验证摘要器配置，支持Ollama和OpenAI兼容提供商
   325--432 | method validateBasicConsistency
   └─ 验证配置一致性，检查分数范围和批处理大小

---

# src/code-index/i18n.ts (28 lines)
└─ 定义国际化翻译字典，支持多语言错误消息模板，提供参数化字符串替换功能。

   19--27 | function t
   └─ 实现国际化翻译函数，根据键查找消息并替换参数，支持动态文本替换

---

# src/code-index/index.ts (29 lines)
└─ 导出代码索引核心功能模块，包括管理器、配置、缓存、状态、编排、搜索、服务工厂、接口、嵌入器、处理器、向量存储、常量和工具函数。


---

# src/code-index/manager.ts (535 lines)
└─ 实现代码索引管理器的核心类，负责初始化配置、管理状态、协调搜索和索引服务，提供错误恢复和资源清理功能。

   17--25 | interface CodeIndexManagerDependencies
   └─ 定义代码索引管理器依赖接口，包含文件系统、存储、事件总线等核心组件

   27--535 | class CodeIndexManager
   └─ 实现代码索引管理器的单例模式，管理配置、状态、服务和索引流程。

   42--56 | method getInstance
   └─ 获取指定工作区的管理器实例，确保每个工作区独立管理
   58--63 | method disposeAll
   └─ 清理所有工作区的管理器实例，释放系统资源
   69--73 | method constructor
   └─ 初始化管理器核心组件，设置工作区路径和依赖注入
   85--89 | method assertInitialized
   └─ 验证核心服务组件是否已初始化，未初始化则抛出错误
   91--97 | method state
   └─ 获取当前索引状态，若功能未启用则返回待机状态
   107--114 | method isInitialized
   └─ 检查管理器是否已初始化，通过断言初始化状态实现
   124--180 | method initialize
   └─ 初始化代码索引管理器，配置组件并启动索引服务
   185--189 | method loadConfiguration
   └─ 重新加载配置信息，确保配置管理器状态最新
   199--216 | method startIndexing
   └─ 检查功能状态，处理错误恢复，启动索引流程
   221--228 | method stopWatcher
   └─ 停止文件监听器，释放资源
   244--268 | method recoverFromError
   └─ 清除错误状态，重置服务实例，防止并发恢复
   273--278 | method dispose
   └─ 释放资源，停止监听器，清理状态管理器
   284--291 | method clearIndexData
   └─ 清除索引数据，重置向量存储和缓存文件
   295--301 | method getCurrentStatus
   └─ 获取当前系统状态并添加工作区路径信息
   308--331 | method getDryRunComponents
   └─ 提供预览模式所需的组件访问接口
   333--367 | method reconcileIndex
   └─ 同步索引与文件系统，删除过期文件条目
   369--375 | method searchIndex
   └─ 执行向量搜索并返回过滤后的结果
   381--466 | method _recreateServices
   └─ 重新创建服务实例，停止现有服务并初始化新服务，验证嵌入器和重排序器配置。
   473--489 | method _initializeForSearchOnly
   └─ 初始化向量存储连接，检查现有索引数据，设置系统状态为已索引或待机
   497--534 | method handleSettingsChange
   └─ 处理设置变更，重新加载配置，根据需要重启服务或禁用功能

---

# src/code-index/orchestrator.ts (438 lines)
└─ 管理代码索引工作流，协调文件监控、状态管理和向量存储服务，处理增量扫描和全量索引逻辑。

   42--437 | class CodeIndexOrchestrator
   └─ 协调代码索引工作流，管理文件监控、状态跟踪和错误处理

   46--55 | method constructor
   └─ 初始化编排器，注入配置管理、状态管理、缓存等核心依赖
   86--136 | method _startWatcher
   └─ 启动文件监控器，订阅文件变更事件并更新索引进度
   142--375 | method startIndexing
   └─ 执行代码索引流程，支持全量扫描和增量更新，处理错误恢复
   380--388 | method stopWatcher
   └─ 停止文件监控器，清理订阅资源并重置处理状态
   397--429 | method clearIndexData
   └─ 停止文件监视器，删除向量存储集合，清除缓存文件，实现索引数据的完全重置。

---

# src/code-index/search-service.ts (108 lines)
└─ 实现代码索引搜索服务，处理查询嵌入、向量搜索和重排序，支持配置验证和错误状态管理。

   14--107 | class CodeIndexSearchService
   └─ 实现代码索引搜索服务，提供向量化和重排序功能

   15--21 | method constructor
   └─ 初始化搜索服务，注入配置、状态、嵌入和向量存储组件
   30--106 | method searchIndex
   └─ 执行搜索流程，包括查询预处理、向量生成、结果排序和重排序

---

# src/code-index/service-factory.ts (353 lines)
└─ 代码索引服务工厂类，负责创建和配置嵌入器、向量存储、目录扫描器等组件，支持多种AI服务提供商

   29--352 | class CodeIndexServiceFactory
   └─ 管理代码索引服务的依赖创建与配置，支持多种嵌入和存储策略

   30--35 | method constructor
   └─ 初始化工厂实例，接收配置管理器、工作路径等核心依赖
   59--117 | method createEmbedder
   └─ 根据配置创建不同提供商的嵌入器，支持OpenAI、Ollama等多种AI服务
   124--134 | method validateEmbedder
   └─ 验证嵌入器配置有效性，返回验证结果和错误信息
   139--173 | method createVectorStore
   └─ 创建向量存储实例，确定向量维度并连接Qdrant数据库
   178--196 | method createDirectoryScanner
   └─ 创建目录扫描器，整合嵌入器、向量存储和代码解析功能
   201--211 | method createFileWatcher
   └─ 创建文件监视器，响应文件变化并实时更新索引
   217--247 | method createServices
   └─ 批量创建完整代码索引服务链，确保配置正确性
   253--284 | method createReranker
   └─ 根据配置创建重排序器，支持Ollama和OpenAI兼容
   291--301 | method validateReranker
   └─ 验证重排序器配置，返回验证结果和错误信息
   307--335 | method createSummarizer
   └─ 根据配置创建总结器实例，支持Ollama和OpenAI兼容两种类型，未知时回退到默认Ollama
   342--351 | method validateSummarizer
   └─ 异步验证总结器配置，捕获异常并返回验证结果，包含错误信息

---

# src/code-index/state-manager.ts (126 lines)
└─ 管理代码索引状态，支持四种状态转换，通过事件总线更新进度信息，处理块和文件级别的索引进度报告。

   9--125 | class CodeIndexStateManager
   └─ 管理代码索引状态，跟踪进度并通知事件总线

   17--20 | method constructor
   └─ 初始化状态管理器，绑定事件总线监听器
   30--39 | method getCurrentStatus
   └─ 返回当前系统状态、进度和消息的完整信息
   43--66 | method setSystemState
   └─ 设置系统状态，重置进度计数器并触发更新
   68--89 | method reportBlockIndexingProgress
   └─ 报告代码块索引进度，更新状态和消息
   91--120 | method reportFileQueueProgress
   └─ 更新文件队列进度状态，设置处理中状态，生成进度消息，触发事件通知

---

# src/code-index/validate-search-params.ts (43 lines)
└─ 验证搜索参数的limit和minScore，确保数值合法且在配置范围内，提供默认值和边界处理。

   4--22 | function validateLimit
   └─ 验证并规范化搜索限制参数，确保返回有效正整数，处理非法值并限制最大值
   25--42 | function validateMinScore
   └─ 验证并规范化最小分数参数，处理null/undefined，限制在[0,1]范围内返回有效值

---

# src/glob/index.ts (2 lines)
└─ 导出文件列表工具模块，提供文件操作相关功能


---

# src/glob/list-files.ts (123 lines)
└─ 实现文件列表功能，使用fast-glob高效遍历目录，结合统一忽略服务过滤文件，限制返回数量，处理特殊目录。

   23--28 | interface ListFilesDependencies
   └─ 定义文件列表依赖接口，包含路径工具、文件系统、工作区及可选适配器
   31--39 | interface IFileSystem
   └─ 定义文件系统操作接口，提供读写、检查、统计、目录等基础方法

   53--99 | function listFiles
   └─ 递归列目录文件，使用 fast-glob 过滤大目录，通过忽略服务精准过滤
   104--122 | function handleSpecialDirectories
   └─ 处理根目录和用户主目录等特殊目录，限制访问权限

---

# src/dependency/cache-manager.ts (420 lines)
└─ 实现依赖分析缓存管理器，持久化存储文件分析结果，通过SHA-256哈希验证文件变化，配置指纹确保版本一致性，使用防抖机制优化磁盘写入。

   40--419 | class DependencyCacheManager
   └─ 实现依赖分析缓存管理器，提供文件级缓存、内容校验和配置指纹功能

   51--74 | method constructor
   └─ 初始化缓存管理器，生成项目哈希路径并创建空缓存结构
   79--101 | method initialize
   └─ 加载现有缓存文件，验证版本并处理异常情况
   107--134 | method getCacheEntry
   └─ 获取缓存条目，验证文件哈希并反序列化依赖节点
   139--177 | method setCacheEntry
   └─ 设置缓存条目，序列化节点并写入缓存，执行节流保存
   182--187 | method deleteCacheEntry
   └─ 删除指定文件的缓存条目，更新缓存状态并触发保存
   192--195 | method clearCache
   └─ 清空所有缓存条目，重新创建空缓存结构并持久化
   200--221 | method getStats
   └─ 计算缓存统计信息，包括命中率、文件数量等性能指标
   244--250 | method serializeNode
   └─ 将依赖节点序列化，转换Set类型为可存储的数组格式
   255--260 | method deserializeNode
   └─ 将序列化节点反序列化，恢复Set类型的数据结构
   265--274 | method createEmptyCache
   └─ 创建空缓存结构，初始化版本号、指纹和文件映射
   279--288 | method createFingerprint
   └─ 生成配置指纹，包含缓存版本和解析器版本信息
   293--299 | method isFingerprintValid
   └─ 验证当前缓存指纹是否与配置指纹匹配
   318--344 | method _performSave
   └─ 执行原子性缓存保存，包含清理、大小检查和文件写入
   349--360 | method cleanOldEntries
   └─ 移除超过最大缓存时间的历史缓存条目
   366--388 | method cleanOrphanedEntries
   └─ 清理缓存中不再存在的文件条目，返回删除数量
   394--418 | method cleanOldCacheEntries
   └─ 清理超过指定天数的缓存条目，返回删除数量

---

# src/dependency/cache-types.ts (117 lines)
└─ 定义依赖分析缓存的数据结构，包括配置指纹、序列化节点、文件缓存条目、完整缓存结构、缓存统计和缓存限制配置，用于存储和管理代码依赖分析结果。

   11--17 | interface CacheFingerprint
   └─ 定义缓存格式版本和解析器版本，用于检测分析配置变化
   23--26 | interface SerializedDependencyNode
   └─ 继承依赖节点，将Set转为数组便于JSON序列化存储
   31--55 | interface FileCacheEntry
   └─ 记录文件哈希、路径、分析结果及元数据，实现单文件缓存管理
   60--75 | interface AnalysisCache
   └─ 包含版本指纹、文件映射和时间戳，组织完整分析缓存结构
   80--99 | interface CacheStats
   └─ 统计缓存命中率和无效文件原因，评估缓存系统性能

---

# src/dependency/graph.ts (394 lines)
└─ 实现依赖图构建与分析，包括ID解析、模块距离计算、智能边解析、环检测和拓扑排序等核心功能。

   20--23 | function extractSimpleName
   └─ 提取节点ID中的简单名称，处理点分隔符获取函数或方法名
   35--56 | function extractModulePath
   └─ 解析模块路径，处理路径分隔符和类名方法名，返回模块根路径
   76--91 | function moduleDistance
   └─ 计算两个模块间的距离，基于公共前缀长度和路径差异
   111--183 | function resolveEdges
   └─ 智能解析依赖边，按优先级匹配完整ID，支持同模块和最近模块策略
   188--206 | function buildAdjacency
   └─ 构建邻接表表示依赖关系，初始化节点并添加已解析的依赖边
   220--265 | function detectCycles
   └─ 实现Tarjan算法检测强连通分量，识别图中的循环依赖关系
   228--256 | function strongconnect
   └─ 递归处理节点，计算lowlink值并构建强连通分量
   278--316 | function topologicalSort
   └─ 使用Kahn算法进行拓扑排序，确定节点依赖顺序
   323--332 | function getLeafNodes
   └─ 识别不被其他节点依赖的叶子节点，定位入口点和底层实现
   349--393 | function buildGraph
   └─ 统一构建流程：解析边、去重、构建邻接表、环检测、拓扑排序

---

# src/dependency/index.ts (518 lines)
└─ 导出依赖分析核心接口和工具函数，包含语言映射、缓存管理、图构建和可视化数据生成功能

   66--70 | interface DependencyAnalyzerDeps
   └─ 定义依赖分析器所需依赖项接口，包含文件系统、路径工具和工作区支持

   85--98 | function findGitRoot
   └─ 向上遍历目录查找.git文件夹，定位Git仓库根目录
   120--325 | function analyze
   └─ 实现核心依赖分析逻辑，支持文件/目录模式，集缓存管理和解析器
   332--337 | function analyzeFile
   └─ 提供便捷文件分析方法，直接调用通用analyze函数

   346--360 | interface VisualizationData
   └─ 定义Cytoscape.js可视化数据接口，包含图元素和统计摘要结构

   383--472 | function generateVisualizationData
   └─ 生成可视化数据，将依赖分析结果转换为Cytoscape.js兼容格式，包含节点、边和统计信息

   483--518 | class DependencyAnalysisService
   └─ 封装依赖分析服务类，提供本地仓库分析的面向对象API

   489--517 | method analyzeLocalRepository
   └─ 分析本地仓库，启用缓存并转换节点格式，兼容旧API，返回依赖分析结果

---

# src/dependency/models.ts (207 lines)
└─ 定义依赖分析的核心数据结构，包括节点、边、结果统计等接口，用于表示代码元素及其依赖关系

   18--68 | interface DependencyNode
   └─ 定义代码元素节点，包含ID、类型、路径、依赖关系及LLM上下文字段
   75--90 | interface DependencyEdge
   └─ 表示依赖关系边，记录调用者、被调用者、调用位置和解析置信度
   95--113 | interface DependencyResult
   └─ 封装依赖分析结果，包含节点映射、关系列表、统计信息和拓扑排序
   118--130 | interface DependencySummary
   └─ 提供依赖分析统计摘要，包括文件数、节点数、关系数和语言列表
   136--139 | interface ParseOutput
   └─ 表示解析输出，包含节点数组和边数组，用于语言分析器结果
   145--163 | interface FileParseResult
   └─ 存储文件解析结果，包含路径、内容、语言、AST和错误信息
   168--173 | interface LanguageConfig
   └─ 配置语言支持，定义文件扩展名和TreeSitter解析器
   178--182 | interface ParserCacheEntry
   └─ 缓存解析器实例，记录使用时间以提高性能
   187--191 | interface FileFilter
   └─ 过滤文件，支持包含/排除规则和文件大小限制
   196--206 | interface AnalysisOptions
   └─ 定义依赖分析配置选项，控制包含测试、模块、符号链接处理、文件过滤、缓存启用和自定义缓存目录

---

# src/dependency/parse.ts (399 lines)
└─ 解析器管理模块，提供文件解析、语言配置和缓存功能，支持多种编程语言的语法树分析

   75--123 | class ParserCache
   └─ 实现Tree-sitter解析器缓存管理，支持LRU淘汰和过期清理

   80--83 | method constructor
   └─ 初始化缓存实例，设置最大容量和过期时间参数
   85--97 | method get
   └─ 获取缓存条目，检查过期时间并更新最后使用时间
   99--118 | method set
   └─ 设置缓存条目，超出容量时移除最久未使用的条目

   133--147 | function ensureParserInitialized
   └─ 确保 tree-sitter 解析器初始化，避免重复初始化
   152--192 | function initializeParser
   └─ 初始化指定语言的 tree-sitter 解析器，支持 WASM 缓存
   197--213 | function loadLanguageParser
   └─ 根据文件扩展名加载对应的语言解析器
   225--288 | function walkFiles
   └─ 递归遍历目录收集支持文件，应用统一过滤逻辑
   238--284 | function walk
   └─ 递归处理目录条目，过滤收集支持的代码文件
   293--336 | function parseFile
   └─ 读取文件内容并使用对应语言解析器生成AST
   341--364 | function parseDirectory
   └─ 批量解析目录中的所有支持文件，提供进度回调
   369--377 | function getLanguageConfig
   └─ 根据文件扩展名查找对应的语言配置，返回匹配的配置对象或null

---

# src/dependency/query.ts (586 lines)
└─ 实现依赖查询核心功能：模式匹配、双向树构建、连接分析、格式化输出，支持通配符搜索和深度限制

   19--22 | interface QueryOptions
   └─ 定义查询配置，指定最大遍历深度
   27--34 | interface NodeQueryResult
   └─ 封装单节点查询结果，包含节点本身、被调用者和调用者
   39--54 | interface TreeNode
   └─ 表示树形节点结构，包含ID、路径、行号和子节点
   59--70 | interface ConnectionAnalysisResult
   └─ 记录多函数连接分析结果，包含查询名称、匹配节点和连接链
   75--82 | interface DirectConnection
   └─ 定义直接连接关系，指定源节点和目标节点
   87--92 | interface Chain
   └─ 表示连接路径的有序节点ID列表和链长度

   102--108 | function globToRegex
   └─ 将通配符模式转换为正则表达式实现模糊匹配
   124--134 | function matchesPattern
   └─ 判断节点是否匹配模式支持通配符和精确匹配
   143--179 | function findMatchingNodes
   └─ 查找匹配模式的节点提供智能提示和批量查询
   188--220 | function buildCalleeTree
   └─ 构建被调用函数树实现递归依赖关系遍历
   225--257 | function buildCallerTree
   └─ 递归构建调用者树，遍历所有依赖目标节点的函数
   267--285 | function queryNode
   └─ 查询节点的双向依赖关系，分别构建被调用和调用树
   294--302 | function buildAdjacency
   └─ 构建节点邻接表，将依赖关系转换为图结构
   307--327 | function findDirectConnections
   └─ 查找匹配节点间的直接连接关系，过滤非目标依赖
   332--366 | function findShortestPath
   └─ 使用BFS算法查找两节点间的最短路径，限制最大长度
   371--393 | function findChains
   └─ 遍历所有节点对，寻找最短路径并构建连接链，按长度排序结果
   402--451 | function analyzeConnections
   └─ 执行完整连接分析流程：匹配节点、查找直接连接和路径链、收集相关节点
   460--473 | function formatTreeNode
   └─ 递归格式化树节点，生成带缩进和连接符的文本表示
   478--513 | function formatNodeQueryResult
   └─ 格式化单个节点的依赖结果，显示调用者和被调用者树形结构
   518--585 | function formatConnectionAnalysisResult
   └─ 格式化连接分析结果，展示匹配节点、直接连接和路径链信息

---

# src/examples/create-sample-files.ts (1330 lines)
└─ 创建示例文件函数，生成包含JavaScript、Python、Markdown、JSON和多个代码文件的完整项目结构，用于演示Autodev代码库索引系统的功能。

   2--1328 | function createSampleFiles
   └─ [Code too large to summarize (1327 lines)]

---

# src/examples/demo-sse-mcp-server.ts (64 lines)
└─ 创建MCP服务器实例，注册加法工具，通过Express和SSE实现通信接口


---

# src/examples/embedding-test-simple.ts (254 lines)
└─ 测试向量嵌入模型性能，模拟npm包数据，计算precision指标并分析查询效果

   68--246 | function runEmbeddingTest
   └─ 初始化embedding测试，配置Jina模型参数，创建向量搜索实例并添加模拟包数据，准备执行测试查询。

---

# src/examples/memory-vector-search.ts (239 lines)
└─ 实现内存向量搜索类，支持多种嵌入模型，提供文档添加、相似度搜索和批量处理功能

   8--13 | interface VectorDocument
   └─ 定义向量文档结构，包含ID、内容、向量和可选元数据

   15--238 | class MemoryVectorSearch
   └─ 实现内存向量搜索类，支持多种嵌入服务提供商

   19--51 | method constructor
   └─ 初始化向量搜索实例，兼容新旧配置方式
   56--70 | method cosineSimilarity
   └─ 计算两个向量的余弦相似度，用于文档匹配
   75--85 | method addDocument
   └─ 添加单个文档到内存存储，生成向量并存储
   90--170 | method addDocuments
   └─ 实现批量添加文档，分批处理避免超时，包含详细错误诊断
   175--209 | method search
   └─ 执行向量相似度搜索，计算余弦相似度并返回最相似文档

---

# src/examples/nodejs-usage.ts (245 lines)
└─ Node.js环境下的代码库使用示例，包含基础配置、高级设置、文件操作、事件系统、文件监控、代码索引管理器集成、测试工具和CLI命令行工具的实现。

   23--48 | function basicUsageExample
   └─ 演示基本使用，创建依赖并配置OpenAI嵌入服务
   53--128 | function advancedUsageExample
   └─ 高级配置示例，自定义存储、日志和文件系统操作
   133--171 | function codeIndexManagerExample
   └─ 集成代码索引管理器，监听配置变化并初始化索引
   176--191 | function createTestDependencies
   └─ 创建测试环境依赖，配置临时存储和日志
   196--239 | function cliExample
   └─ 实现CLI命令行工具，支持初始化、状态查询和文件列表

---

# src/examples/run-demo.ts (244 lines)
└─ 演示脚本监控本地demo文件夹，使用Ollama嵌入和Qdrant向量存储索引代码，展示Node.js环境下的代码库库使用方法。

   21--178 | function main
   └─ 初始化演示环境，配置依赖项并启动代码索引管理器
   182--206 | function waitForIndexingToComplete
   └─ 轮询检查索引状态直到完成或超时，最多等待60秒
   208--236 | function demonstrateSearch
   └─ 执行多个搜索查询测试索引功能，展示搜索结果和评分

---

# src/examples/run-dependency-analyzer.ts (237 lines)
└─ 初始化文件系统适配器与路径工具，配置依赖分析器依赖项，准备执行依赖分析流程

   26--233 | function main
   └─ 执行依赖分析主函数，解析路径参数，调用分析器并输出详细结果，包括节点关系统计、循环依赖检测和可视化数据导出

---

# src/examples/run-example.ts (25 lines)
└─ 根据命令行参数选择并执行不同的示例代码，包括基础、高级和CLI三种模式

   6--22 | function main
   └─ 解析命令行参数，根据参数值执行不同的示例函数，默认执行basic示例

---

# src/examples/simple-demo.ts (104 lines)
└─ 演示脚本创建Node.js依赖，初始化配置，测试文件系统操作，展示基础功能无需外部服务

   16--75 | function main
   └─ 初始化演示环境，创建依赖配置，检查并创建演示文件夹，加载配置，测试文件系统操作
   78--97 | function demonstrateFileSystem
   └─ 读取指定文件列表，检查文件存在性，统计文件行数和字节数，输出文件信息

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
   └─ 测试模型维度函数，遍历不同提供商和模型ID，输出各模型的维度信息。

---

# src/examples/test-parser.ts (31 lines)
└─ 测试解析器加载功能，验证多语言文件解析器初始化与异常处理

   3--29 | function testParserLoading
   └─ 测试解析器加载功能，验证多语言文件解析器是否正确初始化并输出状态信息

---

# src/examples/test-scanner.ts (37 lines)
└─ 测试脚本验证p-limit库的导入和并发控制功能，通过限制并发任务数量确保系统稳定性

   9--30 | function main
   └─ 测试p-limit库的导入和并发控制功能，验证异步任务限制器正常工作

---

# src/ignore/IgnoreService.ts (191 lines)
└─ 实现统一忽略服务，提供gitignore语义文件过滤，支持目录跳过和文件忽略功能

   11--15 | interface IgnoreServiceOptions
   └─ 定义忽略服务的配置选项，包含根路径、忽略文件和额外规则

   21--190 | class IgnoreService
   └─ 提供统一忽略服务，实现gitignore语义的文件过滤功能

   26--33 | method constructor
   └─ 初始化忽略服务，接收文件系统、路径工具和配置选项
   39--60 | method initialize
   └─ 异步加载忽略规则，包括默认目录、忽略文件和额外规则
   62--73 | method loadIgnoreFile
   └─ 读取并解析忽略文件，提取有效规则到忽略库中
   87--109 | method shouldSkipDirectory
   └─ 检查目录是否应跳过，通过快速路径和完整规则判断
   118--130 | method shouldIgnore
   └─ 判断文件是否被忽略，处理路径并返回忽略状态
   150--173 | method toRelative
   └─ 将路径转换为相对路径，处理绝对路径和路径规范化
   178--182 | method getRules
   └─ 返回已知规则，排除忽略库的内部规则

---

# src/ignore/default-dirs.ts (31 lines)
└─ 定义全局忽略目录列表，统一版本控制、依赖、构建及缓存目录的过滤规则，支持 ripgrep 隐藏目录通配符


---

# src/lib/codebase.ts (4 lines)
└─ 导出函数返回固定字符串'codebase'，作为代码库标识符


---

# src/mcp/http-server.ts (752 lines)
└─ 实现基于Express的MCP HTTP服务器，提供代码搜索和结构提取工具，支持会话管理和优雅关闭。

   20--24 | interface HTTPMCPServerOptions
   └─ 定义HTTP MCP服务器配置接口，包含代码索引管理器和网络参数

   26--751 | class CodebaseHTTPMCPServer
   └─ 实现代码库HTTP MCP服务器类，初始化MCP服务器和HTTP服务

   35--47 | method constructor
   └─ 构造函数初始化服务器配置，创建MCP服务器并设置工具
   49--159 | method setupTools
   └─ 注册搜索和代码大纲工具，配置参数和处理器
   165--303 | method handleSearchCodebase
   └─ 处理代码搜索请求，验证参数、去重结果并格式化输出
   305--340 | method handleGetSearchStats
   └─ 获取代码索引状态，返回初始化和功能启用情况
   342--375 | method handleConfigureSearch
   └─ 处理搜索配置请求，支持刷新索引和更新模型
   380--509 | method handleOutlineCodebase
   └─ 提取代码结构大纲，支持单文件和模式匹配
   518--682 | method setupHTTPServer
   └─ 设置HTTP服务器，处理MCP请求和CORS配置
   684--696 | method start
   └─ 启动MCP服务器，监听指定端口并输出服务信息
   698--750 | method stop
   └─ 实现优雅的服务器关闭逻辑，包括关闭MCP连接、传输层和HTTP服务器，支持超时强制退出机制

---

# src/mcp/stdio-adapter.ts (418 lines)
└─ 实现stdio到HTTP MCP服务器的适配器，处理JSON-RPC消息转发和SSE连接管理

   18--21 | interface StdioAdapterOptions
   └─ 定义适配器配置接口，包含服务器URL和超时时间参数

   23--417 | class StdioToStreamableHTTPAdapter
   └─ 实现stdio到HTTP的适配器类，处理MCP协议转换和连接管理

   32--36 | method constructor
   └─ 初始化适配器，设置服务器URL、超时时间和请求映射
   41--48 | method start
   └─ 启动适配器，设置stdio处理器并准备接收连接
   53--68 | method stop
   └─ 停止适配器，清理SSE连接和待处理请求
   74--140 | method connectSSE
   └─ 建立SSE连接，处理服务器推送消息，维护会话状态
   146--169 | method handleServerMessage
   └─ 解析SSE消息，区分请求响应和通知，转发到标准输出
   174--200 | method setupStdioHandlers
   └─ 配置标准输入输出，处理JSON-RPC消息，管理进程生命周期
   205--236 | method handleStdinMessage
   └─ 解析客户端请求，转发到HTTP服务器，处理响应和错误
   242--340 | method forwardRequestToServer
   └─ 处理初始化请求，管理会话ID，支持多种响应格式
   346--404 | method httpRequest
   └─ 发送HTTP请求到服务器，处理JSON和SSE响应格式
   409--416 | method writeStdoutResponse
   └─ 将JSON-RPC响应序列化并写入标准输出流

---

# src/ripgrep/index.ts (312 lines)
└─ 封装ripgrep搜索功能，提供跨平台文件正则搜索，支持上下文显示和结果格式化。

   55--58 | interface SearchFileResult
   └─ 定义文件搜索结果结构，包含文件路径和搜索结果列表
   64--69 | interface SearchLineResult
   └─ 定义搜索行结果结构，包含行号、文本、匹配状态和列位置

   87--130 | function getBinPath
   └─ 查找ripgrep二进制文件路径，优先系统PATH，回退VSCode安装路径
   132--170 | function execRipgrep
   └─ 执行ripgrep命令并处理输出，限制结果数量并处理错误

   172--176 | interface RipgrepOptions
   └─ 定义ripgrep搜索选项，包含文件系统、VSCode根目录和忽略过滤器

   186--267 | function regexSearchFiles
   └─ 执行正则搜索，调用ripgrep解析JSON输出，处理匹配结果并应用过滤
   269--311 | function formatResults
   └─ 格式化搜索结果，按文件分组显示行号和匹配内容，限制最大结果数量

---

# src/search/file-search.ts (177 lines)
└─ 使用ripgrep实现文件搜索功能，支持文件和目录查找，集成fzf进行模糊匹配，提供高效的文件系统搜索能力。

   17--20 | function getBinPath
   └─ 获取ripgrep可执行文件路径，返回null或路径字符串
   24--99 | function executeRipgrep
   └─ 执行ripgrep命令解析输出，收集文件和目录结果，支持限制数量
   101--121 | function executeRipgrepForFiles
   └─ 配置ripgrep参数扫描工作区文件，排除常见目录
   123--176 | function searchWorkspaceFiles
   └─ 使用fzf搜索工作区文件，验证路径类型并返回结果

---

# src/search/index.ts (2 lines)
└─ 导出文件搜索功能模块，提供文件搜索相关接口


---

# src/shared/api.ts (10 lines)
└─ 定义API处理器选项和基础接口，支持OpenAI和Ollama配置，提供灵活的键值扩展

   2--6 | interface ApiHandlerOptions
   └─ 定义API处理器选项接口，包含OpenAI和Ollama配置，支持动态扩展属性

---

# src/shared/embeddingModels.ts (196 lines)
└─ 定义嵌入模型配置文件，包含不同提供商和模型的维度信息，提供获取模型维度、默认模型ID、查询前缀和相似度阈值的函数。

   7--10 | interface EmbeddingModelProfile
   └─ 定义嵌入模型配置文件，包含维度等属性

   12--16 | type EmbeddingModelProfiles
   └─ 定义嵌入模型配置文件集合，按提供商和模型ID组织

   73--89 | function getModelDimension
   └─ 根据提供商和模型ID获取嵌入维度，未找到则返回undefined
   99--139 | function getDefaultModelId
   └─ 根据提供商返回默认模型ID，支持多种提供商的默认配置
   148--152 | function getModelQueryPrefix
   └─ 获取模型查询前缀，当前无实现，保留未来扩展性
   161--195 | function getModelScoreThreshold
   └─ 根据模型ID返回语义搜索的相似度阈值，基于经验测试为不同模型设置最小匹配分数。

---

# src/shared/index.ts (2 lines)
└─ 导出共享模块的API和嵌入模型，提供统一入口点


---

# src/tools/file-chunker-cli.ts (271 lines)
└─ 实现文件切块命令行工具，支持多种输出格式和切块策略，提供文件查找和信息查询功能。

   9--23 | interface CLIOptions
   └─ 定义CLI选项接口，包含输出格式、切块参数和文件处理配置

   28--92 | function formatOutput
   └─ 格式化输出结果，支持JSON、CSV和文本三种格式，可选择保存到文件
   97--101 | function findFiles
   └─ 实现文件查找功能，当前为简化实现，实际可使用glob库
   106--261 | function main
   └─ 构建命令行程序，提供chunk、find、info和list-ext四个子命令

---

# src/tools/file-chunker.ts (249 lines)
└─ 实现文件切块工具类，支持tree-sitter解析、批量处理文件，生成带哈希的代码块结构。

   11--14 | interface ParentContainer
   └─ 定义父级容器信息结构，包含标识符和类型
   19--44 | interface FileChunk
   └─ 定义文件块结构，包含路径、内容、哈希等完整信息
   49--64 | interface FileChunkerOptions
   └─ 定义切块配置选项，控制块大小和类型等参数
   69--82 | interface ChunkResult
   └─ 定义切块结果结构，包含文件信息和生成的块列表

   109--227 | class FileChunker
   └─ 实现文件切块工具类，支持单文件和批量处理

   110--118 | property defaultOptions
   └─ 定义文件切块的默认配置参数，包含最小块大小、最大块大小等关键设置

   130--186 | method chunkFile
   └─ 实现单个文件切块逻辑，读取文件内容、计算哈希值、使用CodeParser解析并转换为FileChunk格式
   194--208 | method chunkFiles
   └─ 批量处理多个文件切块，遍历文件列表并调用chunkFile方法，错误处理确保继续执行
   215--218 | method isFileSupported
   └─ 检查文件扩展名是否在支持列表中，判断文件是否可进行切块处理

   235--238 | function chunkFile
   └─ 提供便捷的单文件切块函数，创建FileChunker实例并调用chunkFile方法
   246--249 | function chunkFiles
   └─ 创建文件切块器实例，批量处理多个文件并返回切块结果列表

---

# src/tools/test-tree-sitter.ts (201 lines)
└─ 测试Tree-sitter解析器的工具脚本，支持解析代码定义和输出JSON格式的捕获详情，提供命令行接口和错误处理。

   27--44 | function parseFile
   └─ 解析指定文件的代码定义，输出解析结果或错误信息
   49--122 | function outputCapturesAsJson
   └─ 读取文件内容并生成JSON格式的语法树捕获数据
   127--142 | function getFilePath
   └─ 从命令行参数或环境变量获取文件路径，支持默认值
   147--163 | function showUsage
   └─ 显示程序使用说明和命令行参数示例
   166--194 | function main
   └─ 主函数协调整个流程，包括文件验证、解析和JSON输出

---

# src/tree-sitter/index.ts (453 lines)
└─ 使用tree-sitter解析代码文件，提取函数、类等定义，支持多种编程语言和Markdown文件，提供代码结构化视图。

   9--13 | interface TreeSitterDependencies
   └─ 定义树状解析器依赖接口，提供文件系统、工作区和路径工具

   104--157 | function parseSourceCodeDefinitionsForFile
   └─ 解析单个文件定义，检查存在性、扩展名，支持Markdown和Tree-sitter解析
   160--242 | function parseSourceCodeForDefinitionsTopLevel
   └─ 解析目录顶层定义，分离文件类型，批量处理Markdown和其他代码文件
   244--248 | function separateFiles
   └─ 分离可解析文件，限制最大数量，返回解析文件和剩余文件
   283--404 | function processCaptures
   └─ 处理解析捕获，排序去重，格式化输出代码定义和文档字符串
   414--452 | function parseFile
   └─ 解析单个文件内容，使用tree-sitter构建AST并应用查询提取代码定义，处理文件权限和错误情况。

---

# src/tree-sitter/languageParser.ts (247 lines)
└─ 定义语言解析器接口，加载Tree-sitter WASM模块，初始化解析器，根据文件扩展名加载对应语言的语法解析器和查询规则，支持多种编程语言的语法树解析

   34--39 | interface LanguageParser
   └─ 定义语言解析器接口，存储解析器和查询对象

   41--49 | function loadLanguage
   └─ 加载指定语言的tree-sitter WASM模块，返回语言解析器实例
   54--75 | function initializeParser
   └─ 初始化tree-sitter解析器，确保单例模式和线程安全
   99--246 | function loadRequiredLanguageParsers
   └─ 根据文件扩展名动态加载对应的语言解析器和查询规则

---

# src/tree-sitter/markdownParser.ts (217 lines)
└─ 解析Markdown文件，提取标题和章节行范围，生成与tree-sitter兼容的模拟捕获数据。

   10--19 | interface MockNode
   └─ 定义模拟树节点结构，包含位置信息和文本内容
   24--27 | interface MockCapture
   └─ 定义模拟捕获结构，关联节点和名称标识

   35--173 | function parseMarkdown
   └─ 解析Markdown文件，提取标题和章节范围，生成模拟捕获
   183--216 | function formatMarkdownCaptures
   └─ 格式化Markdown捕获，输出标题行范围和文本内容

---

# src/tree-sitter/wasm-loader.ts (116 lines)
└─ 提供统一的 WASM 文件路径解析功能，支持开发与生产环境切换，并创建用于 web-tree-sitter 的 locateFile 函数。

   16--24 | function getBasePath
   └─ 获取当前模块基础路径，优先使用 import.meta.url，降级报错
   30--34 | function isDevelopment
   └─ 通过检查路径是否包含 '/src/' 判断是否为开发环境
   55--90 | function resolveWasmPath
   └─ 解析 WASM 文件路径，支持环境检测和自定义目录，验证文件存在性
   104--115 | function createLocateFileFunction
   └─ 创建拦截 tree-sitter.wasm 加载请求的 locateFile 函数，返回预解析路径

---

# src/types/vitest.d.ts (140 lines)
└─ 定义Vitest测试框架的全局类型声明，提供describe、it、expect等测试函数的类型支持，并添加Jest兼容性方法。

   116--136 | interface Mock
   └─ 为Vitest的Mock接口添加Jest兼容方法，支持设置解析值、拒绝值及一次性延迟操作

---

# src/utils/config-provider.ts (154 lines)
└─ 配置提供者实现类，支持从环境变量和配置文件读取配置，提供全局状态和密钥管理功能，包含单例模式实现。

   33--37 | interface IConfigProvider
   └─ 定义配置提供者接口，规范全局状态、密钥获取和刷新方法

   43--112 | class SimpleConfigProvider
   └─ 实现配置提供者类，支持从文件和环境变量读取配置

   51--65 | method loadConfig
   └─ 异步加载配置文件，处理文件不存在或解析错误情况
   71--75 | method ensureLoaded
   └─ 确保配置已加载，未加载时自动调用加载方法
   82--86 | method getGlobalState
   └─ 同步获取全局状态值，直接返回已加载的配置数据
   94--104 | method getSecret
   └─ 优先从环境变量获取密钥，其次从配置文件读取，确保密钥安全获取

   126--130 | function createInitializedConfigProvider
   └─ 创建并初始化配置提供者实例，加载配置文件后返回
   140--145 | function getGlobalConfigProvider
   └─ 实现全局单例模式，确保配置提供者实例唯一且懒加载

---

# src/utils/events.ts (95 lines)
└─ 实现基于Node.js EventEmitter的事件总线，支持订阅、发布、一次性订阅和全局单例实例管理

   9--75 | class EventBus
   └─ 实现基于 EventEmitter 的泛型事件总线，支持订阅、发布和事件管理

   12--15 | method constructor
   └─ 初始化事件发射器并设置最大监听器数量，默认为100
   21--27 | method on
   └─ 订阅事件并返回取消订阅函数，实现事件监听管理
   47--53 | method once
   └─ 订阅一次性事件，触发后自动取消订阅，返回取消函数

   89--94 | function getGlobalEventBus
   └─ 获取全局单例事件总线，首次调用时创建实例

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
   └─ 获取文件或目录的元数据，包括类型、大小和修改时间
   70--73 | function readdir
   └─ 读取目录内容并返回完整路径列表，实现目录遍历功能
   92--99 | function remove
   └─ 删除文件或目录，根据类型选择删除方式
   104--108 | function copyFile
   └─ 复制文件并自动创建目标目录
   113--117 | function rename
   └─ 重命名或移动文件，确保目标目录存在

---

# src/utils/fs.ts (68 lines)
└─ 创建文件所需目录，递归构建缺失路径并返回新目录列表。检查路径是否存在，使用异常处理判断文件状态。安全写入JSON数据，自动创建目录并格式化输出。

   11--32 | function createDirectoriesForFile
   └─ 创建文件路径中缺失的目录，从最顶层开始逐级向下创建，返回新创建的目录列表。
   40--47 | function fileExistsAtPath
   └─ 检查指定路径是否存在，通过尝试访问路径并捕获异常来判断文件或目录是否存在。
   56--67 | function safeWriteJson
   └─ 安全地将JSON数据写入文件，自动创建所需目录，格式化输出并处理可能的错误。

---

# src/utils/git-global-ignore.ts (221 lines)
└─ 实现Git全局忽略文件管理，确保指定模式被添加到全局排除文件中，支持自动配置和回滚机制。

   9--14 | interface GitCommandResult
   └─ 定义Git命令执行结果的结构，包含状态码、输出和错误信息。
   18--24 | interface EnsureGitGlobalIgnoreDependencies
   └─ 封装依赖项接口，提供文件系统、Git命令执行和环境配置能力。
   26--31 | interface EnsureGitGlobalIgnoreResult
   └─ 描述全局忽略文件更新结果，包含文件路径、更新状态和添加的模式。

   33--41 | function defaultRunGit
   └─ 实现默认Git命令执行逻辑，同步调用并返回结构化结果。
   43--46 | function getConfigHome
   └─ 根据环境变量或用户目录确定配置文件路径，优先使用XDG标准。
   48--63 | function atomicWriteFile
   └─ 实现原子性文件写入，通过临时文件和重命名确保写入完整性
   73--80 | function fileExists
   └─ 检查文件是否存在，通过捕获stat异常返回布尔值
   82--87 | function getExcludesFilePath
   └─ 获取Git全局排除文件路径，使用--path选项返回绝对路径
   89--94 | function getExcludesFilePathRaw
   └─ 获取Git全局排除文件原始路径，使用--get选项返回配置值
   117--220 | function ensureGitGlobalIgnorePatterns
   └─ 确保Git全局忽略模式存在，处理文件创建、模式添加和回滚逻辑

---

# src/utils/index.ts (56 lines)
└─ 导出文件系统、存储、事件、日志和配置提供程序等工具模块，统一管理各类功能接口。


---

# src/utils/jsonc-helpers.ts (170 lines)
└─ 提供JSONC格式保存功能，保留注释并合并配置，支持错误回退到标准JSON

   16--115 | function saveJsoncPreservingComments
   └─ 保存配置对象时保留JSONC注释，支持递归合并和错误回退
   45--51 | function isPlainObject
   └─ 检查值是否为普通对象，排除数组、日期等特殊类型
   56--100 | function applyUpdates
   └─ 递归应用配置更新，智能合并对象或直接替换值
   128--132 | function isValidJsonc
   └─ 验证JSONC内容语法有效性，检测解析错误
   139--158 | function mergeConfig
   └─ 深度合并配置对象，新配置优先级覆盖基础配置
   163--169 | function isPlainObject
   └─ 判断值是否为普通对象，排除null、数组、日期和正则表达式等特殊对象类型

---

# src/utils/logger.ts (184 lines)
└─ 实现带级别和格式化的控制台日志包装器，支持时间戳、颜色和子日志器

   8--17 | interface LoggerOptions
   └─ 定义日志配置接口，包含名称、级别、时间戳和颜色选项

   34--145 | class Logger
   └─ 实现日志记录器类，提供多级别日志输出和格式化功能

   40--45 | method constructor
   └─ 初始化日志实例，设置默认配置并检测终端支持颜色
   78--117 | method log
   └─ 处理日志消息，根据级别过滤并格式化输出到控制台
   136--144 | method child
   └─ 创建子日志记录器，继承父级配置并添加名称前缀

   166--171 | function getGlobalLogger
   └─ 实现全局日志获取逻辑，确保单例模式，初始化默认名称为App的日志实例
   177--183 | function setGlobalLogLevel
   └─ 实现全局日志级别设置逻辑，支持更新现有实例或创建新实例，默认名称为App

---

# src/utils/path-filters.ts (57 lines)
└─ 解析逗号分隔的路径过滤器，支持大括号扩展，检查全局模式字符

   10--48 | function parsePathFilters
   └─ 解析逗号分隔的路径过滤器，支持花括号扩展，确保分割时不破坏嵌套结构。

---

# src/utils/path.ts (112 lines)
└─ 实现跨平台路径处理，统一使用正斜杠展示，提供安全路径比较和可读路径转换功能。

   29--38 | function toPosixPath
   └─ 将Windows路径转换为POSIX格式，保留扩展长度路径不变。
   53--68 | function arePathsEqual
   └─ 安全比较路径，处理不同平台大小写和分隔符差异。
   70--79 | function normalizePath
   └─ 规范化路径，解析相对段并移除尾部斜杠。
   81--101 | function getReadablePath
   └─ 生成用户友好的路径显示，根据上下文选择绝对或相对路径。

---

# src/utils/storage.ts (154 lines)
└─ 实现基于JSON文件的键值存储类，提供异步读写、数据持久化和类型安全操作。

   8--11 | interface StorageOptions
   └─ 定义存储配置接口，指定存储文件路径

   13--146 | class Storage
   └─ 实现JSON文件存储类，提供键值对持久化操作

   25--41 | method load
   └─ 从文件加载数据，处理异常并初始化内存映射
   46--52 | method save
   └─ 将内存数据写入文件，自动创建目录并格式化JSON
   57--60 | method get
   └─ 获取指定键的值，确保数据已加载后返回结果
   65--68 | method getOrDefault
   └─ 获取指定键的值，若不存在则返回默认值
   73--77 | method set
   └─ 设置键值对并持久化到存储文件
   82--89 | method delete
   └─ 删除指定键，存在则保存并返回true
   94--97 | method has
   └─ 检查指定键是否存在于存储中
   102--105 | method keys
   └─ 返回所有存储键的数组列表
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
└─ Node.js配置提供器适配器，实现JSON配置文件管理，支持全局和项目级配置加载、保存、验证及变更通知。

   15--19 | interface NodeConfigOptions
   └─ 定义Node.js配置提供器的选项接口，包含配置路径和默认配置

   22--353 | class NodeConfigProvider
   └─ 实现配置提供器接口，管理全局和项目配置的加载与保存

   29--42 | method constructor
   └─ 初始化配置提供器，设置默认配置和文件路径
   44--78 | method getEmbedderConfig
   └─ 获取嵌入器配置，支持OpenAI、Ollama和兼容提供商
   80--86 | method getVectorStoreConfig
   └─ 获取向量存储配置，返回Qdrant连接信息
   92--98 | method getSearchConfig
   └─ 获取搜索配置，返回最小分数和最大结果数
   104--114 | method onConfigChange
   └─ 注册配置变更回调，提供取消订阅功能
   119--124 | method ensureConfigLoaded
   └─ 确保配置已加载，未加载时触发加载逻辑
   129--132 | method reloadConfig
   └─ 强制重新加载配置，清除缓存后重新加载
   137--181 | method loadConfig
   └─ 加载全局和项目配置，合并默认值并处理异常
   187--230 | method saveConfig
   └─ 保存配置到文件，合并默认、当前和传入配置，保留JSONC注释并通知监听器
   235--240 | method updateConfig
   └─ 更新单个配置键值，通过saveConfig方法实现原子性更新
   259--289 | method isConfigured
   └─ 检查配置完整性，验证嵌入器和向量存储必需参数是否已设置
   294--352 | method validateConfig
   └─ 验证配置有效性，检查各提供商必需参数并返回错误列表

---

# src/adapters/nodejs/event-bus.ts (56 lines)
└─ 实现Node.js事件总线适配器，使用EventEmitter提供事件发布订阅功能，支持监听器管理

   8--56 | class NodeEventBus
   └─ 实现IEventBus接口，使用Node.js EventEmitter提供事件总线功能

   11--15 | method constructor
   └─ 初始化EventEmitter实例并设置最大监听器数量避免警告
   21--28 | method on
   └─ 订阅事件并返回取消订阅函数，支持事件数据的类型化处理
   34--41 | method once
   └─ 订阅一次性事件并返回取消订阅函数，确保事件只触发一次

---

# src/adapters/nodejs/file-system.ts (84 lines)
└─ 实现Node.js文件系统适配器，提供异步文件读写、目录操作和状态查询功能，支持递归创建目录和递归删除操作。

   9--83 | class NodeFileSystem
   └─ 实现IFileSystem接口，提供Node.js文件系统操作功能

   10--17 | method readFile
   └─ 读取文件内容并转换为Uint8Array，处理异常并抛出错误
   19--29 | method writeFile
   └─ 写入文件内容前创建目录，确保路径存在并转换数据类型
   31--38 | method exists
   └─ 检查文件是否存在，通过访问权限判断返回布尔值
   40--52 | method stat
   └─ 获取文件状态信息，包括类型、大小和修改时间
   54--61 | method readdir
   └─ 读取目录内容，返回文件和子目录名称列表
   63--69 | method mkdir
   └─ 递归创建目录，支持多级目录结构
   71--82 | method delete
   └─ 删除文件或目录，目录删除包含所有子项

---

# src/adapters/nodejs/file-watcher.ts (88 lines)
└─ 实现Node.js文件监视器，使用fs.watch API监听文件和目录变化，提供事件回调和清理功能

   8--88 | class NodeFileWatcher
   └─ 实现文件监视器接口，管理多个文件系统监视器实例

   11--32 | method watchFile
   └─ 监视单个文件变化，返回清理函数并处理事件回调
   34--57 | method watchDirectory
   └─ 递归监视目录变化，构建完整文件路径并触发回调
   62--67 | method dispose
   └─ 关闭所有活动监视器并清理内部映射表
   76--87 | method mapEventType
   └─ 将Node.js事件类型映射为统一的事件枚举值

---

# src/adapters/nodejs/index.ts (94 lines)
└─ 导出Node.js适配器模块，提供文件系统、存储、事件总线、日志、文件监视、工作区和配置功能。创建工厂函数生成平台依赖项，确保全局配置目录存在，初始化各种服务组件。提供简化工厂函数用于基本使用场景。

   29--76 | function createNodeDependencies
   └─ 创建Node.js平台依赖项，初始化文件系统、存储、事件总线、日志、文件监视器、工作区、路径工具和配置提供者
   81--93 | function createSimpleNodeDependencies
   └─ 简化版Node.js依赖项工厂，使用默认日志选项创建基本依赖项

---

# src/adapters/nodejs/logger.ts (105 lines)
└─ 实现Node.js日志适配器，支持多级别日志输出、时间戳、颜色格式化，通过控制台输出日志信息

   7--12 | interface NodeLoggerOptions
   └─ 定义日志配置接口，包含名称、级别、时间戳和颜色选项

   14--105 | class NodeLogger
   └─ 实现日志记录器，支持多级别输出、格式化和颜色显示

   20--25 | property levels
   └─ 定义日志级别数值映射，用于过滤和排序日志消息
   27--33 | property colorCodes
   └─ 定义ANSI颜色代码，为不同级别日志添加视觉区分

   35--40 | method constructor
   └─ 初始化日志器，设置默认配置并检测终端颜色支持
   58--90 | method log
   └─ 根据日志级别过滤消息，格式化输出带时间戳、级别标识和名称，支持颜色高亮，调用对应控制台方法输出。

---

# src/adapters/nodejs/storage.ts (57 lines)
└─ Node.js存储适配器实现文件系统缓存管理，提供全局存储路径和缓存路径生成功能，支持工作区路径哈希处理。

   12--15 | interface NodeStorageOptions
   └─ 定义存储配置接口，包含全局存储路径和缓存基础路径的可选参数

   17--57 | class NodeStorage
   └─ 实现文件系统存储适配器，提供缓存路径生成和哈希功能

   21--24 | method constructor
   └─ 初始化存储实例，设置默认的全局存储路径和缓存基础路径
   30--34 | method createCachePath
   └─ 基于工作区路径生成安全的缓存目录路径，使用哈希值确保唯一性
   40--46 | method hashWorkspacePath
   └─ 将工作区路径转换为安全的目录名，结合字符替换和简单哈希算法
   48--56 | method simpleHash
   └─ 实现字符串哈希算法，将输入字符串转换为16进制哈希值，用于生成唯一目录名

---

# src/adapters/nodejs/workspace.ts (193 lines)
└─ Node.js工作区适配器实现，提供文件系统操作和忽略规则处理，支持工作区管理和路径工具功能。

   11--14 | interface NodeWorkspaceOptions
   └─ 定义Node.js工作区适配器的配置接口，包含根路径和忽略文件列表

   16--158 | class NodeWorkspace
   └─ 实现IWorkspace接口，提供Node.js文件系统操作的核心工作区功能

   23--34 | method constructor
   └─ 初始化工作区，配置文件系统接口和忽略规则服务
   40--44 | method getRelativePath
   └─ 计算相对于工作区根目录的文件路径，处理空根路径情况
   54--73 | method getGlobIgnorePatterns
   └─ 转换忽略模式为glob格式，支持目录匹配和通配符处理
   75--78 | method shouldIgnore
   └─ 初始化忽略服务后检查文件是否被忽略，使用异步确认
   88--91 | method getName
   └─ 返回工作区名称，取根目录名或默认值
   93--100 | method getWorkspaceFolders
   └─ 生成工作区文件夹列表，包含名称和URI
   102--123 | method findFiles
   └─ 根据模式匹配查找文件，支持排除规则
   129--137 | method matchPattern
   └─ 将通配符模式转换为正则表达式，匹配文件路径或文件名
   139--157 | method walkDirectory
   └─ 递归遍历目录结构，处理文件和子目录

   160--192 | class NodePathUtils
   └─ 实现路径工具类，提供文件路径操作的各种方法

---

# src/commands/config/file-loader.ts (88 lines)
└─ 加载配置文件的工具模块，支持全局和项目层级配置的读取与合并，提供默认配置作为基础。

   14--19 | interface ConfigLayer
   └─ 定义配置层结构，包含解析后的配置对象和文件路径
   24--33 | interface ConfigLayers
   └─ 定义所有配置层次结构，包括默认、全局、项目及合并后的配置

   42--54 | function loadConfigLayer
   └─ 读取并解析单个配置文件，若文件不存在则返回null，出错则退出进程
   67--87 | function loadConfigLayers
   └─ 加载所有配置层次，按优先级合并配置并返回完整配置结构

---

# src/commands/config/get.ts (123 lines)
└─ 实现配置获取命令，支持查看默认、全局和项目配置层的详细信息或特定配置项的值。

   14--19 | function formatValue
   └─ 将配置值格式化为字符串显示，处理undefined、null、object等特殊类型。
   24--53 | function printAllConfigLayers
   └─ 详细打印所有配置层级信息，展示有效配置、项目配置、全局配置和默认值。
   58--74 | function printConfigItemLayers
   └─ 打印指定配置项在各层级中的值，包括默认值、全局值、项目值和有效值。
   79--122 | function configGetHandler
   └─ 实现配置获取命令的核心逻辑，支持JSON格式或详细格式输出，解析并合并各层级配置。

---

# src/commands/config/index.ts (38 lines)
└─ 配置命令入口，实现配置获取与设置逻辑，支持全局配置和JSON输出，动态加载子命令处理器

   9--37 | function createConfigCommand
   └─ 创建配置命令管理器，实现配置获取和设置功能，支持路径和JSON输出选项

---

# src/commands/config/metadata.ts (147 lines)
└─ 定义配置键元数据类型和验证规则，集中管理所有配置项的常量和约束条件，确保配置一致性和正确性。

   13--24 | interface ConfigKeyMetadata
   └─ 定义配置键的元数据接口，包含值类型、枚举值、数值范围约束和人类可读描述

---

# src/commands/config/parser.ts (146 lines)
└─ 解析配置值并进行类型转换与验证，支持布尔、整数、数字、枚举和字符串类型。解析键值对字符串，验证格式和有效性。

   18--97 | function parseConfigValue
   └─ 解析配置值，根据类型转换并验证输入，支持布尔、整数、数字、枚举等类型，包含错误处理。
   106--135 | function parseConfigPairs
   └─ 解析逗号分隔的键值对字符串，验证格式和键的有效性，返回键值映射对象。

---

# src/commands/config/set.ts (91 lines)
└─ 实现配置设置命令，解析键值对，合并配置，验证并保存到指定路径，同时更新Git全局忽略文件。

   20--49 | function saveConfig
   └─ 保存配置到文件，创建目录、合并配置并更新git全局忽略列表
   54--90 | function configSetHandler
   └─ 解析配置参数，确定配置路径，合并验证后保存配置

---

# src/code-index/constants/index.ts (114 lines)
└─ 定义代码索引默认配置、搜索参数、文件处理限制、批处理策略和嵌入器参数，提供动态批处理大小计算功能，支持截断降级和功能开关控制。

   84--93 | function getBatchSizeForEmbedder
   └─ 根据嵌入器类型或实例动态获取最优批处理大小，优先使用实例自定义值，否则根据类型映射或默认阈值返回。

---

# src/code-index/constants/search-config.ts (25 lines)
└─ 定义搜索配置常量，包含分页限制和最小分数阈值，确保搜索参数在合理范围内。

   14--18 | type SearchLimits
   └─ 定义搜索结果数量限制的常量类型，包含默认、最大和最小值
   20--24 | type SearchMinScore
   └─ 定义搜索最小分数的常量类型，包含默认、最小和最大值

---

# src/code-index/embedders/gemini.ts (89 lines)
└─ 封装Gemini嵌入API，继承OpenAI兼容接口，支持模型配置和批量嵌入生成。

   13--89 | class GeminiEmbedder
   └─ 实现Gemini嵌入器，封装OpenAI兼容接口，支持多种模型配置

   24--39 | method constructor
   └─ 初始化Gemini嵌入器，验证API密钥，设置默认模型并创建兼容实例
   47--56 | method createEmbeddings
   └─ 异步生成文本嵌入，支持模型选择，委托给底层OpenAI兼容实现
   62--71 | method validateConfiguration
   └─ 验证配置有效性，委托给底层OpenAI兼容实现，返回验证结果
   76--80 | method embedderInfo
   └─ 返回嵌入器信息，提供名称标识符
   85--88 | method optimalBatchSize
   └─ 返回Gemini嵌入器的推荐批处理大小为40，优化API调用效率

---

# src/code-index/embedders/jina-embedder.ts (223 lines)
└─ 实现Jina AI嵌入器，支持批量处理、重试机制和配置验证，用于文本向量转换

   9--21 | interface JinaEmbeddingResponse
   └─ 定义Jina AI嵌入响应的数据结构，包含模型信息、使用情况和嵌入向量数组。

   26--222 | class JinaEmbedder
   └─ 实现Jina AI嵌入器，支持批量处理、重试机制和配置验证，遵循IEmbedder接口规范。

   32--42 | method constructor
   └─ 初始化Jina嵌入器，设置API密钥、模型ID和最优批量大小，验证必要参数。
   47--98 | method createEmbeddings
   └─ 创建文本嵌入向量，实现智能分批处理，控制令牌限制并合并结果。
   103--162 | method _embedBatchWithRetries
   └─ 处理批量嵌入请求，实现指数退避重试机制，处理速率限制和HTTP错误。
   167--205 | method validateConfiguration
   └─ 验证Jina API连接性，测试配置有效性
   210--214 | method embedderInfo
   └─ 返回Jina嵌入器的基本信息标识

---

# src/code-index/embedders/mistral.ts (88 lines)
└─ 实现Mistral嵌入器，封装OpenAI兼容接口，支持codestral-embed-2505模型，提供文本嵌入和配置验证功能。

   12--88 | class MistralEmbedder
   └─ 实现Mistral嵌入器，封装OpenAI兼容接口，支持指定模型和API密钥

   23--38 | method constructor
   └─ 初始化Mistral嵌入器，验证API密钥，设置默认模型并创建兼容实例
   46--55 | method createEmbeddings
   └─ 异步生成文本嵌入，支持动态模型选择，委托给OpenAI兼容处理器
   61--70 | method validateConfiguration
   └─ 验证配置有效性，委托给底层OpenAI兼容嵌入器，返回验证结果
   75--79 | method embedderInfo
   └─ 返回嵌入器信息，标识为Mistral类型，提供名称属性
   84--87 | method optimalBatchSize
   └─ 返回Mistral嵌入器的推荐批处理大小为30，优化API调用效率

---

# src/code-index/embedders/ollama.ts (385 lines)
└─ 实现Ollama本地嵌入服务，支持批量文本嵌入、重试机制、代理配置和模型验证

   17--384 | class CodeIndexOllamaEmbedder
   └─ 实现Ollama嵌入器接口，提供文本嵌入生成功能

   22--33 | method constructor
   └─ 初始化Ollama嵌入器配置，设置基础URL和默认模型
   41--66 | method createEmbeddings
   └─ 创建文本嵌入，实现重试逻辑和错误处理
   71--170 | method _createEmbeddingsWithTimeout
   └─ 生成嵌入向量，处理代理配置和超时控制
   175--199 | method _isRetryableError
   └─ 判断错误是否可重试，区分网络错误和验证错误
   204--220 | method _formatEmbeddingError
   └─ 格式化嵌入错误，提供特定错误类型的友好消息
   226--370 | method validateConfiguration
   └─ 验证Ollama配置，检查服务可用性和模型功能
   372--376 | method embedderInfo
   └─ 返回嵌入器信息标识符，指定名称为ollama

---

# src/code-index/embedders/openai-compatible.ts (522 lines)
└─ 实现OpenAI兼容的嵌入服务，支持批量处理、速率限制和代理配置，提供文本向量化功能。

   15--18 | interface EmbeddingItem
   └─ 定义嵌入项接口，包含嵌入数据和其他属性
   20--26 | interface OpenAIEmbeddingResponse
   └─ 定义OpenAI兼容的嵌入响应接口，包含数据和可选的使用统计

   32--521 | class OpenAICompatibleEmbedder
   └─ 实现OpenAI兼容的嵌入器，支持批量处理和速率限制

   42--49 | property globalRateLimitState
   └─ 定义全局速率限制状态，包含错误计数和互斥锁

   58--119 | method constructor
   └─ 构造函数初始化嵌入器，配置代理和客户端
   127--195 | method createEmbeddings
   └─ 处理文本嵌入请求，应用模型前缀，分批处理文本并调用重试机制生成嵌入向量
   203--217 | method isFullEndpointUrl
   └─ 判断URL是否为完整端点，支持Azure OpenAI等不同提供商的URL模式识别
   227--280 | method makeDirectEmbeddingRequest
   └─ 直接向嵌入端点发送HTTP请求，处理认证和响应验证，支持Azure兼容性
   288--379 | method _embedBatchWithRetries
   └─ 执行嵌入请求重试逻辑，处理速率限制和错误，转换base64编码为浮点数组
   385--420 | method validateConfiguration
   └─ 验证配置有效性，测试端点连通性和API密钥，返回验证结果
   425--429 | method embedderInfo
   └─ 返回嵌入器信息，标识为OpenAI兼容类型
   441--468 | method waitForGlobalRateLimit
   └─ 检查全局速率限制状态，必要时等待限制解除
   473--502 | method updateGlobalRateLimitState
   └─ 更新全局速率限制状态，计算指数退避延迟时间
   507--520 | method getGlobalRateLimitDelay
   └─ 获取当前全局速率限制的剩余延迟时间

---

# src/code-index/embedders/openai.ts (261 lines)
└─ 实现OpenAI嵌入器接口，支持批量处理、重试机制和代理配置，处理文本嵌入生成和错误管理。

   18--260 | class OpenAiEmbedder
   └─ 实现OpenAI嵌入器接口，提供文本向量化功能，支持批处理和代理配置

   27--75 | method constructor
   └─ 初始化OpenAI客户端，配置API密钥、代理设置和默认模型参数
   83--151 | method createEmbeddings
   └─ 批量处理文本输入，应用模型前缀，分批生成向量并统计令牌使用情况
   159--216 | method _embedBatchWithRetries
   └─ 执行嵌入请求，处理base64编码，实现重试机制和错误处理逻辑
   222--246 | method validateConfiguration
   └─ 验证配置有效性，通过测试请求确认API连接和响应格式
   248--252 | method embedderInfo
   └─ 返回嵌入器信息，标识为OpenAI实现

---

# src/code-index/embedders/openrouter.ts (380 lines)
└─ 实现OpenRouter嵌入器，支持批量处理、速率限制和重试机制，使用OpenAI兼容API生成文本向量表示。

   14--17 | interface EmbeddingItem
   └─ 定义嵌入项接口，包含嵌入数据和任意额外属性
   19--25 | interface OpenRouterEmbeddingResponse
   └─ 定义OpenRouter响应接口，包含嵌入数据和可选的使用统计

   32--380 | class OpenRouterEmbedder
   └─ 实现OpenRouter嵌入器，支持批量处理和速率限制

   41--48 | property globalRateLimitState
   └─ 管理全局速率限制状态，包括错误计数和重置时间

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
   └─ 更新全局速率限制状态，计算指数退避延迟并设置重置时间
   366--379 | method getGlobalRateLimitDelay
   └─ 获取当前全局速率限制的剩余延迟时间，返回0表示无限制

---

# src/code-index/embedders/vercel-ai-gateway.ts (97 lines)
└─ 实现Vercel AI Gateway嵌入器，封装OpenAI兼容接口，支持多种模型配置和验证

   21--97 | class VercelAiGatewayEmbedder
   └─ 实现Vercel AI Gateway嵌入器，封装OpenAI兼容嵌入器，支持多种模型配置

   32--47 | method constructor
   └─ 初始化Vercel AI Gateway嵌入器，验证API密钥，设置默认模型并创建兼容嵌入器实例
   55--64 | method createEmbeddings
   └─ 创建文本嵌入，支持动态模型选择，委托给底层OpenAI兼容嵌入器处理
   70--79 | method validateConfiguration
   └─ 验证配置有效性，委托给底层OpenAI兼容嵌入器执行验证逻辑
   84--88 | method embedderInfo
   └─ 返回嵌入器信息，提供名称标识符用于系统识别
   93--96 | method optimalBatchSize
   └─ 获取最优批处理大小，委托给底层OpenAI兼容嵌入器实现

---

# src/code-index/interfaces/cache.ts (38 lines)
└─ 定义缓存管理器接口，提供初始化、清空、获取、更新和删除文件哈希的功能，用于文件变更检测和缓存管理。

   1--37 | interface ICacheManager
   └─ 定义缓存管理器接口，提供初始化、清空、获取、更新和删除文件哈希的功能，支持异步操作和批量获取。

---

# src/code-index/interfaces/config.ts (302 lines)
└─ 定义代码索引配置接口，支持多种嵌入模型和向量存储，包含重排序和摘要功能配置。

   3--11 | type EmbedderProvider
   └─ 定义支持的嵌入模型提供商类型枚举

   16--21 | interface OllamaEmbedderConfig
   └─ 配置Ollama嵌入器的基础参数和模型信息
   26--31 | interface OpenAIEmbedderConfig
   └─ 配置OpenAI嵌入器的认证和模型参数
   36--42 | interface OpenAICompatibleEmbedderConfig
   └─ 配置兼容OpenAI的嵌入器的基础URL和认证信息
   47--52 | interface JinaEmbedderConfig
   └─ 配置Jina嵌入器的API密钥和模型参数
   57--62 | interface GeminiEmbedderConfig
   └─ 定义Gemini嵌入器配置，包含API密钥、模型和维度参数
   67--72 | interface MistralEmbedderConfig
   └─ 定义Mistral嵌入器配置，包含API密钥、模型和维度参数
   77--82 | interface VercelAiGatewayEmbedderConfig
   └─ 定义Vercel AI网关嵌入器配置，包含API密钥、模型和维度参数
   87--92 | interface OpenRouterEmbedderConfig
   └─ 定义OpenRouter嵌入器配置，包含API密钥、模型和维度参数

   97--105 | type EmbedderConfig
   └─ 定义所有嵌入器配置的联合类型，支持多种AI服务提供商

   110--180 | interface CodeIndexConfig
   └─ 定义代码索引功能配置，包含嵌入器、向量存储、搜索和重排序器参数

   185--232 | type PreviousConfigSnapshot
   └─ 存储先前配置快照，用于检测配置变更是否需要重启服务

   237--240 | interface VectorStoreConfig
   └─ 配置向量存储连接参数，支持Qdrant向量数据库
   245--248 | interface SearchConfig
   └─ 配置向量搜索参数，控制结果数量和最低相似度分数
   254--301 | interface ConfigSnapshot
   └─ 定义配置快照接口，用于向后兼容的配置变更检测

---

# src/code-index/interfaces/embedder.ts (49 lines)
└─ 定义代码索引嵌入器接口，提供创建嵌入、验证配置和获取嵌入器信息的功能，支持多种嵌入服务实现。

   5--26 | interface IEmbedder
   └─ 定义文本嵌入器接口，实现创建嵌入、验证配置和获取批量大小功能
   28--34 | interface EmbeddingResponse
   └─ 封装嵌入响应数据，包含向量数组和可选的令牌使用统计

   36--44 | type AvailableEmbedders
   └─ 枚举支持的嵌入器类型，包括OpenAI、Ollama等AI服务提供商

---

# src/code-index/interfaces/file-processor.ts (147 lines)
└─ 定义代码文件解析、目录扫描和文件监听的核心接口，提供代码块处理、批量操作和进度跟踪功能，支持多种文件处理策略和错误处理机制。

   6--22 | interface ICodeParser
   └─ 定义代码文件解析器接口，支持解析单个文件为代码块

   13--21 | method parseFile
   └─ 解析指定文件路径的代码内容，返回代码块数组

   27--54 | interface IDirectoryScanner
   └─ 定义目录扫描器接口，支持扫描目录获取代码块

   34--46 | method scanDirectory
   └─ 扫描指定目录，返回代码块和统计信息

   59--105 | interface ICodeFileWatcher
   └─ 定义代码文件监视器接口，支持批量处理和事件通知
   107--112 | interface BatchProcessingSummary
   └─ 记录批量处理结果，包含文件处理状态和可能的批量错误
   114--123 | interface FileProcessingResult
   └─ 描述单个文件处理结果，包含路径、状态、错误信息和向量点
   129--132 | interface ParentContainer
   └─ 表示代码块的父容器，包含标识符和类型信息
   134--146 | interface CodeBlock
   └─ 定义代码块结构，包含文件路径、内容、哈希值和层次关系

---

# src/code-index/interfaces/index.ts (7 lines)
└─ 导出模块接口，包含嵌入器、向量存储、文件处理器、管理器、重排序器和摘要器的全部功能


---

# src/code-index/interfaces/manager.ts (92 lines)
└─ 定义代码索引管理器接口，提供索引配置、启动、搜索和状态管理功能，支持多种嵌入模型提供商。

   10--74 | interface ICodeIndexManager
   └─ 定义代码索引管理器接口，提供索引状态管理、配置加载、索引启动、搜索和资源释放功能

   76--84 | type EmbedderProvider
   └─ 定义嵌入模型提供商类型，支持多种AI服务提供商的嵌入模型选择

   86--91 | interface IndexProgressUpdate
   └─ 定义索引进度更新接口，包含系统状态、消息和进度计数信息

---

# src/code-index/interfaces/reranker.ts (56 lines)
└─ 定义代码索引重排序器接口，包含候选结果、重排序结果、配置信息和核心重排序方法，支持多种AI服务提供商和并发控制

   5--10 | interface RerankerCandidate
   └─ 定义重排序候选对象，包含ID、内容和原始分数
   12--17 | interface RerankerResult
   └─ 定义重排序结果，包含ID、LLM评分和原始分数
   19--22 | interface RerankerInfo
   └─ 定义重排序器信息，包含名称和模型标识
   24--37 | interface RerankerConfig
   └─ 配置重排序器，支持Ollama和OpenAI兼容提供商
   39--55 | interface IReranker
   └─ 实现重排序接口，提供重排序和配置验证方法

---

# src/code-index/interfaces/summarizer.ts (232 lines)
└─ 定义代码摘要生成器的核心接口，包括请求、结果、配置和批量处理结构，支持多种AI服务提供商

   4--35 | interface SummarizerRequest
   └─ 定义代码摘要请求参数，包含内容、上下文、语言和代码类型
   40--50 | interface SummarizerResult
   └─ 封装摘要生成结果，包含摘要文本和实际使用的语言
   55--65 | interface SummarizerInfo
   └─ 提供摘要器信息，包含提供者名称和模型标识
   70--135 | interface SummarizerConfig
   └─ 配置摘要器参数，支持多种提供者和性能调优选项
   140--177 | interface SummarizerBatchRequest
   └─ 批量处理多个代码块摘要请求，共享上下文提高效率
   182--197 | interface SummarizerBatchResult
   └─ 定义批量总结结果接口，包含按顺序排列的摘要数组及对应语言信息
   203--231 | interface ISummarizer
   └─ 定义总结器核心接口，实现单次和批量代码总结功能，支持配置验证和信息获取

---

# src/code-index/interfaces/vector-store.ts (103 lines)
└─ 定义向量数据库客户端接口，提供初始化、向量搜索、数据管理等功能，支持代码片段的索引和检索。

   4--8 | type PointStruct
   └─ 定义向量存储点的结构，包含唯一标识、向量和元数据

   10--82 | interface IVectorStore
   └─ 定义向量存储接口，提供初始化、增删查等核心操作

   29--32 | method search
   └─ 执行向量相似性搜索，支持过滤和结果限制

   84--88 | interface SearchFilter
   └─ 定义搜索过滤器，可按路径、分数和数量筛选结果
   90--94 | interface VectorStoreSearchResult
   └─ 定义搜索结果结构，包含标识、分数和代码块信息
   96--102 | interface Payload
   └─ 定义代码块元数据，包含文件路径、代码内容、行号范围及扩展字段

---

# src/code-index/processors/batch-processor.ts (496 lines)
└─ 批量处理器类，实现文件删除、嵌入生成、向量存储和缓存更新，支持重试和截断回退机制。

   16--21 | interface BatchProcessingResult
   └─ 定义批量处理结果接口，包含处理数量、失败数量、错误列表和文件处理结果
   23--44 | interface BatchProcessorOptions
   └─ 定义批量处理器选项接口，包含嵌入器、向量存储、缓存管理器和策略函数

   54--495 | class BatchProcessor
   └─ 实现通用批量处理器，处理文件删除、嵌入生成、向量存储和缓存更新

   60--70 | method _isRecoverableError
   └─ 判断错误是否可恢复，检查错误消息中是否包含上下文长度相关关键词
   76--104 | method _truncateTextByLines
   └─ 按行截断文本以保持代码完整性，避免添加语言特定截断标记
   111--204 | method _processItemWithTruncation
   └─ 实现文本截断重试逻辑，逐步减少阈值直到成功或达到最小限制
   209--305 | method _processItemsIndividually
   └─ 提供个体处理回退机制，包含超时保护和逐项截断重试
   307--340 | method processBatch
   └─ 协调整个批处理流程，分阶段处理文件删除和批量索引
   342--376 | method handleDeletions
   └─ 处理文件删除操作，同步清理向量存储和缓存记录
   378--393 | method processItemsInBatches
   └─ 动态分批处理项目，根据嵌入器能力调整批次大小
   398--494 | method processSingleBatch
   └─ 处理单个批次，包含重试机制、错误恢复和降级处理，确保批量操作可靠性

---

# src/code-index/processors/file-watcher.ts (574 lines)
└─ 实现了文件监控与批量处理机制，监听文件变化事件，解析代码块并嵌入向量存储

   34--573 | class FileWatcher
   └─ 实现代码文件监控，支持文件创建、修改、删除事件处理和批量处理

   56--60 | property onBatchProgressUpdate
   └─ 报告批量处理进度，显示已处理文件数量和当前文件
   65--68 | property onBatchProgressBlocksUpdate
   └─ 报告批量处理进度，显示已处理代码块数量

   84--115 | method constructor
   └─ 初始化文件观察器，设置事件处理机制，支持可配置批量大小
   120--149 | method initialize
   └─ 创建文件监控实例，监听工作区文件变化事件
   154--161 | method dispose
   └─ 清理文件监视器和定时器资源，释放内存占用
   167--170 | method handleFileCreated
   └─ 将文件创建事件加入待处理队列，触发批量处理
   176--179 | method handleFileChanged
   └─ 将文件变更事件加入待处理队列，触发批量处理
   185--188 | method handleFileDeleted
   └─ 将文件删除事件加入待处理队列，触发批量处理
   193--198 | method scheduleBatchProcessing
   └─ 设置防抖定时器，合并短时间内多个文件事件
   203--215 | method triggerBatchProcessing
   └─ 触发批量处理，清空事件队列并开始处理
   221--427 | method processBatch
   └─ 批量处理文件事件，包括读取内容、解析代码块和向量化存储
   437--481 | method handleFileDeletions
   └─ 处理文件删除操作，从向量存储和缓存中移除相关数据
   488--572 | method processFile
   └─ 单独处理文件，检查文件状态并生成向量嵌入点

---

# src/code-index/processors/index.ts (4 lines)
└─ 导出解析器、扫描器和文件监视器模块，统一索引处理功能入口


---

# src/code-index/processors/parser.ts (1059 lines)
└─ 实现代码解析器，支持多种语言和Markdown文件，使用Tree-sitter进行语法分析，将代码块分割为语义单元并构建父子关系链。

   46--50 | interface MarkdownHeader
   └─ 定义Markdown头部信息结构，包含层级、文本和行号

   55--1055 | class CodeParser
   └─ [Code too large to summarize (1001 lines)]

   67--101 | method parseFile
   └─ 解析文件入口，处理文件路径、内容读取和哈希生成
   128--319 | method parseContent
   └─ 核心解析逻辑，处理不同语言类型和树状结构解析
   324--500 | method _chunkTextByLines
   └─ 按行分块处理，支持大行分割和内容平衡
   502--510 | method _performFallbackChunking
   └─ 回退分块策略，简单按行分割内容
   512--548 | method _chunkLeafNodeByLines
   └─ 将语法树叶子节点按行分割，保留父级上下文信息
   555--594 | method _chunkDefinitionNodeByLines
   └─ 按行分割定义节点，保持标识符和层级结构
   599--615 | method deduplicateBlocks
   └─ 按优先级去重，移除被包含的代码块
   623--632 | method buildParentChain
   └─ 根据上下文选择构建父级链的方法
   637--689 | method buildTreeSitterParentChain
   └─ 遍历父节点构建层级链，跳过非容器节点
   695--726 | method buildMarkdownParentChain
   └─ 构建Markdown标题的父子层级链，通过栈结构递归查找父级标题
   739--780 | method extractNodeIdentifier
   └─ 从语法节点中提取标识符，支持字段名、子节点和JSON键等多种方式
   785--805 | method normalizeNodeType
   └─ 规范化节点类型名称，将声明和定义类型映射为统一简洁的标识
   810--825 | method buildHierarchyDisplay
   └─ 构建代码节点的层级显示字符串，组合父级链和当前节点信息
   830--845 | method buildMarkdownHierarchyDisplay
   └─ 构建Markdown标题的层级显示字符串，使用精简的header_X格式
   850--860 | method updateHeaderStack
   └─ 维护markdown标题栈，移除同级或更低级标题，添加新标题
   865--870 | method isBlockContained
   └─ 检查代码块是否被包含在另一个代码块内，避免重复
   875--944 | method processMarkdownSection
   └─ 处理markdown章节内容，根据大小决定分块或创建单个代码块
   946--1054 | method parseMarkdownContent
   └─ 解析markdown文件，处理标题层级关系和剩余内容

---

# src/code-index/processors/scanner.ts (458 lines)
└─ 代码目录扫描器，过滤支持文件并并行处理代码块，生成嵌入向量存储到向量数据库。

   30--39 | interface DirectoryScannerDependencies
   └─ 定义扫描器所需依赖项接口，包含嵌入器、向量存储等核心组件

   41--458 | class DirectoryScanner
   └─ 实现目录扫描器类，支持文件批量处理和并发控制

   45--56 | method constructor
   └─ 初始化扫描器，设置批处理阈值和依赖注入
   73--109 | method filterSupportedFiles
   └─ 过滤支持文件，移除目录和忽略规则，检查文件扩展类型
   119--363 | method scanDirectory
   └─ 扫描目录并处理代码块，实现增量缓存和批量索引
   365--450 | method processBatch
   └─ 处理代码块批次，生成嵌入向量并存储到向量数据库
   452--457 | method getAllFilePaths
   └─ 获取指定目录下所有支持的文件路径列表

---

# src/code-index/rerankers/index.ts (3 lines)
└─ 导出ollama和openai兼容模块的索引文件，统一暴露外部接口


---

# src/code-index/rerankers/ollama.ts (495 lines)

   12--494 | class OllamaLLMReranker
   └─ 实现基于Ollama LLM的代码重排序器，支持批量处理、并发控制和重试机制，通过LLM评分对候选结果进行智能排序。

   20--36 | method constructor
   └─ 初始化Ollama LLM重排序器，配置基础URL、模型ID、批处理大小、并发数、重试次数和延迟时间，规范化基础URL。
   46--134 | method rerank
   └─ 实现批量重排序逻辑，支持并发处理和重试机制，使用指数退避策略处理失败批次，最终合并排序结果。
   142--162 | method rerankSingleBatch
   └─ 构建评分提示并调用Ollama API生成候选分数，合并结果并按分数降序排序返回。
   167--196 | method buildScoringPrompt
   └─ 构建LLM评分提示，定义评分标准，格式化查询和代码片段，要求返回JSON格式的分数数组
   201--225 | method buildContextInfo
   └─ 构建候选代码的上下文信息，包含层次结构和文件路径，用于提示词生成。
   230--316 | method generateScores
   └─ 调用Ollama API生成评分，处理代理配置、超时控制和响应解析，确保评分在0-10范围内
   321--336 | method extractScoresFromText
   └─ 从文本中提取数字分数，使用正则匹配并限制在0-10范围内
   342--486 | method validateConfiguration
   └─ 验证Ollama服务可用性，检查模型存在性和文本生成能力，处理代理连接和超时错误
   488--493 | method rerankerInfo
   └─ 返回重排序器信息，包含名称和模型标识符

---

# src/code-index/rerankers/openai-compatible.ts (575 lines)
└─ 实现了OpenAI兼容API的代码重排序器，支持批量处理、并发控制和重试机制，通过LLM评分对候选结果进行智能排序

   12--574 | class OpenAICompatibleReranker
   └─ 实现OpenAI兼容的代码重排序器，支持批量处理和重试机制

   21--39 | method constructor
   └─ 初始化重排序器配置，设置基础URL、模型ID和批处理参数
   49--139 | method rerank
   └─ 执行重排序逻辑，分组处理候选结果并应用重试策略
   147--167 | method rerankSingleBatch
   └─ 处理单个批次候选结果，调用LLM生成相关性评分
   172--201 | method buildScoringPrompt
   └─ 构建评分提示模板，定义评分标准和响应格式要求
   206--230 | method buildContextInfo
   └─ 构建候选代码的上下文信息，包含层次结构和文件路径
   235--344 | method generateScores
   └─ 调用OpenAI兼容API生成代码相关性分数，处理代理和超时
   349--364 | method extractScoresFromText
   └─ 从文本中提取并验证分数，确保数值在0-10范围内
   370--566 | method validateConfiguration
   └─ 验证OpenAI兼容服务配置，检查模型可用性和连接状态
   568--573 | method rerankerInfo
   └─ 返回重排序器信息，包含名称和模型标识符

---

# src/code-index/search/query-prefill.ts (37 lines)
└─ 为Qwen3嵌入模型提供查询预填充模板，指导模型生成更好的代码搜索嵌入。仅适用于ollama提供商的qwen3-embedding模型，防止重复预填充并返回处理后的查询。

   18--37 | function applyQueryPrefill
   └─ 检查提供者和模型ID，匹配qwen3-embedding模型时添加查询前缀模板，避免重复应用。

---

# src/code-index/shared/block-text-generator.ts (38 lines)
└─ 生成代码块嵌入文本，添加文件路径、标识符和父级链等上下文信息，增强语义搜索准确性

   13--37 | function generateBlockEmbeddingText
   └─ 生成代码块嵌入文本，添加文件路径、函数/类名和父级容器信息，增强语义搜索准确性

---

# src/code-index/shared/get-relative-path.ts (32 lines)
└─ 生成规范化绝对路径，处理路径解析和标准化，确保跨平台一致性。生成相对文件路径，从绝对路径转换，保证路径分隔符统一。

   11--16 | function generateNormalizedAbsolutePath
   └─ 将文件路径解析为绝对路径并规范化，确保路径一致性
   26--31 | function generateRelativeFilePath
   └─ 生成从工作区根目录到文件的相对路径并规范化

---

# src/code-index/shared/openai-error-handler.ts (20 lines)
└─ 处理OpenAI API错误，特别是ByteString转换错误，返回格式化错误信息

   5--20 | function handleOpenAIError
   └─ 处理OpenAI API错误，检查API密钥格式和ByteString错误，返回格式化错误信息

---

# src/code-index/shared/supported-extensions.ts (35 lines)
└─ 定义文件扩展名处理逻辑，包括扫描器扩展、回退扩展列表及回退分块判断函数，用于确定文件解析策略。


---

# src/code-index/shared/validation-helpers.ts (212 lines)
└─ 提供错误消息清理、HTTP错误处理、状态码映射和验证错误处理的核心功能，确保敏感信息被移除并提供一致的错误响应。

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
   └─ 提取错误消息，支持多种错误格式处理
   133--181 | function handleValidationError
   └─ 处理验证错误，支持自定义处理和标准错误分类
   186--196 | function withValidationErrorHandling
   └─ 包装异步验证函数，提供统一错误处理机制
   201--212 | function formatEmbeddingError
   └─ 格式化嵌入错误，根据状态码生成详细错误信息

---

# src/code-index/summarizers/index.ts (3 lines)
└─ 导出Ollama和OpenAI兼容的摘要器模块，提供统一的接口


---

# src/code-index/summarizers/ollama.ts (424 lines)
└─ 实现了基于本地Ollama实例的代码摘要生成器，支持批量处理和代理配置。

   11--423 | class OllamaSummarizer
   └─ 实现基于Ollama的代码摘要生成器，支持批量处理和代理配置

   17--29 | method constructor
   └─ 初始化摘要器配置，设置基础URL、模型ID、语言和温度参数
   35--50 | method summarize
   └─ 将单个请求转换为批量请求，统一处理代码摘要生成
   56--104 | method buildPrompt
   └─ 构建结构化提示模板，包含文件上下文、代码块和输出格式要求
   111--155 | method extractCompleteJsonObject
   └─ 使用栈匹配算法从文本中提取完整的JSON对象，处理嵌套结构
   161--289 | method summarizeBatch
   └─ 构建批量请求提示，整合共享上下文与代码块，生成结构化提示文本
   294--415 | method validateConfiguration
   └─ 验证Ollama服务配置，检查模型可用性并测试生成功能
   417--422 | method summarizerInfo
   └─ 返回 summarizer 信息，包含名称和模型标识符

---

# src/code-index/summarizers/openai-compatible.ts (403 lines)
└─ 实现了基于OpenAI兼容API的代码摘要生成器，支持批量处理和代理配置，包含JSON提取和超时控制。

   13--57 | function extractCompleteJsonObject
   └─ 解析文本中的完整JSON对象，处理嵌套结构和转义字符

   63--402 | class OpenAICompatibleSummarizer
   └─ 实现OpenAI兼容接口的代码摘要生成器，支持批量处理和代理配置

   70--84 | method constructor
   └─ 初始化摘要器配置，设置API端点、模型和语言参数
   90--105 | method summarize
   └─ 将单个请求转换为批量请求，委托给批量处理方法
   111--159 | method buildPrompt
   └─ 构建统一的提示模板，根据语言和代码块数量生成结构化指令
   165--306 | method summarizeBatch
   └─ 批量处理代码块请求，构建提示并发送至OpenAI兼容API，解析响应并验证格式
   311--394 | method validateConfiguration
   └─ 验证OpenAI兼容服务配置，测试端点可用性并返回验证结果状态
   396--401 | method summarizerInfo
   └─ 返回 summarizer 信息，包含名称和模型标识符

---

# src/code-index/vector-store/qdrant-client.ts (817 lines)
└─ 实现了Qdrant向量存储接口，提供向量索引、搜索、删除等功能，支持路径过滤和元数据管理。

   18--120 | class PatternCompiler
   └─ 编译路径过滤器为Qdrant查询结构，支持包含和排除模式

   24--68 | method compile
   └─ 处理包含和排除路径模式，构建should和must_not子句
   75--88 | method expandPattern
   └─ 扩展花括号模式如{a,b}为多个独立模式
   95--119 | method extractSubstrings
   └─ 从模式中提取子字符串，过滤通配符和字符类

   125--816 | class QdrantVectorStore
   └─ 实现Qdrant向量存储，支持增删查和索引管理

   141--187 | method constructor
   └─ 处理构造函数参数，支持新旧签名兼容性，初始化Qdrant客户端和集合名称
   189--202 | method getCollectionInfo
   └─ 获取集合信息，捕获异常并返回null，用于检查集合是否存在
   208--226 | method isCollectionNotFoundError
   └─ 判断错误是否为集合不存在，通过状态码和错误消息多种方式检测
   232--294 | method initialize
   └─ 初始化向量存储，检查集合存在性，处理向量维度不匹配并创建索引
   301--370 | method _recreateCollectionWithNewDimension
   └─ 重新创建集合以匹配新向量维度，包含删除、验证和重建的完整流程
   375--425 | method _createPayloadIndexes
   └─ 创建关键字段索引，支持元数据过滤和路径匹配
   431--481 | method upsertPoints
   └─ 处理代码块数据，生成路径段和哈希ID用于唯一标识
   488--495 | method isPayloadValid
   └─ 验证载荷数据完整性，确保必要字段存在
   503--550 | method search
   └─ 执行向量搜索，结合路径过滤和元数据排除
   560--622 | method deletePointsByMultipleFilePaths
   └─ 批量删除文件路径对应的向量点，使用相对路径匹配
   627--637 | method deleteCollection
   └─ 删除整个向量存储集合，先检查存在性再执行删除操作
   642--660 | method clearCollection
   └─ 清空集合中的所有数据点，使用空过滤器删除所有内容
   666--669 | method collectionExists
   └─ 检查向量存储集合是否存在，通过获取集合信息判断
   671--701 | method getAllFilePaths
   └─ 获取集合中所有文件路径，使用分页查询遍历所有数据点
   707--741 | method hasIndexedData
   └─ 检查集合是否已索引数据，验证点数量和索引完成标记
   747--778 | method markIndexingComplete
   └─ 创建元数据点标记索引完成，使用UUIDv5生成唯一ID，记录完成时间戳
   784--815 | method markIndexingIncomplete
   └─ 创建元数据点标记索引进行中，使用UUIDv5生成唯一ID，记录开始时间戳

---

# src/dependency/analyzers/base.ts (699 lines)
└─ 定义依赖分析抽象基类，提供节点遍历、导入解析、调用关系提取等核心分析能力，支持多语言扩展

   11--15 | interface CallInfo
   └─ 定义调用信息结构，包含方法名、完整路径和调用类型标识
   20--41 | interface NodeTypes
   └─ 配置语言节点类型，定义函数、类、方法等节点类型集合

   53--698 | class BaseAnalyzer
   └─ 定义抽象基类，提供依赖分析的核心框架和语言特定扩展点

   70--82 | method constructor
   └─ 初始化分析器，设置文件路径、内容和解析器实例
   123--134 | method getComponentType
   └─ 根据节点类型和上下文确定组件类型，支持类、方法和函数分类
   140--165 | method analyze
   └─ 执行源码分析的入口方法，按顺序解析导入、节点和调用关系
   171--206 | method traverseForNodes
   └─ 递归遍历AST，提取函数、类、方法定义并构建依赖节点
   208--247 | method traverseForCalls
   └─ 递归遍历AST，提取调用表达式并根据上下文构建调用边
   253--269 | method addClassNode
   └─ 创建类节点对象，包含类名、路径、源码等信息，存储到节点映射中
   271--288 | method addFunctionNode
   └─ 创建函数节点对象，包含函数名、参数、源码等信息，存储到节点映射中
   290--312 | method addMethodNode
   └─ 创建方法节点对象，设置唯一标识符和依赖关系
   318--346 | method createModuleNode
   └─ 创建模块节点表示文件本身，用于跟踪顶层调用和文件级依赖
   356--393 | method addEdge
   └─ 解析调用依赖，导入匹配与模块路径处理
   403--425 | method resolveModulePath
   └─ 解析相对路径为模块路径，支持目录导航
   435--445 | method findChildByType
   └─ 查找指定类型的子节点，返回第一个匹配项
   447--452 | method findChildrenByType
   └─ 查找所有指定类型的子节点，返回数组
   455--468 | method getModulePath
   └─ 计算模块路径，移除扩展名并标准化路径分隔符
   471--478 | method getRelativePath
   └─ 获取文件相对于仓库根目录的路径
   481--487 | method makeNodeId
   └─ 生成节点唯一标识符，支持模块、类名和方法名的组合
   490--494 | method getSourceSegment
   └─ 提取语法节点对应的源代码片段，按行号范围截取
   497--504 | method findNodeIdByLine
   └─ 根据行号查找对应的节点ID，遍历所有顶级节点进行匹配
   507--532 | method extractParameters
   └─ 从函数节点中提取参数列表，支持多种参数节点类型的解析
   588--637 | method extractMemberPath
   └─ 递归提取成员表达式的完整路径
   644--683 | method extractCallInfo
   └─ 提取调用信息，支持全局与成员调用
   686--697 | method shouldFilterCall
   └─ 过滤内置函数调用，根据调用类型检查全局或成员内置函数

---

# src/dependency/analyzers/c.ts (117 lines)
└─ 定义C语言分析器，支持解析函数、结构体和头文件导入，提取标识符并处理内置函数。

   13--116 | class CAnalyzer
   └─ 定义C语言分析器，继承基础分析器，处理C文件结构和依赖关系

   15--23 | property GLOBAL_BUILTINS
   └─ 存储C标准库函数集合，用于识别全局内置函数

   25--35 | method getNodeTypes
   └─ 配置C语言节点类型映射，定义函数、结构体等识别规则
   37--44 | method extractFunctionName
   └─ 从函数定义节点中提取函数名称，通过查找标识符节点实现
   46--49 | method extractClassName
   └─ 从结构体定义节点中提取结构体名称，通过类型标识符节点实现
   51--66 | method extractCallName
   └─ 解析函数调用名称，处理标识符和函数指针调用
   72--101 | method traverseImports
   └─ 递归遍历AST节点，提取#include路径并映射到importMap
   103--111 | method getComponentType
   └─ 根据节点类型返回组件类型，结构体返回'struct'，其他返回'function'

---

# src/dependency/analyzers/cpp.ts (57 lines)
└─ 扩展C分析器，支持C++特定语法，处理类、命名空间和函数定义，提取组件类型和名称。

   17--56 | class CppAnalyzer
   └─ 扩展C分析器，支持C++特定语法节点和文件扩展名

   19--27 | method getNodeTypes
   └─ 定义C++支持的语法节点类型，包括类、方法和文件扩展
   29--42 | method extractClassName
   └─ 提取类名和命名空间标识符，支持C++语法结构
   44--55 | method getComponentType
   └─ 根据节点类型确定组件类型，类返回'class'，命名空间返回'module'

---

# src/dependency/analyzers/csharp.ts (134 lines)
└─ 定义C#分析器，支持解析类、方法、调用和导入语句，提取组件类型和名称映射。

   13--133 | class CSharpAnalyzer
   └─ 定义C#语言分析器，支持类、接口、方法等语法结构识别

   15--32 | method getNodeTypes
   └─ 配置C#语法节点类型映射，包括类、方法、调用和导入类型
   34--37 | method extractFunctionName
   └─ 提取函数名称，通过查找标识符节点获取函数名
   39--53 | method extractClassName
   └─ 提取类名称，识别类关键字后的标识符作为类名
   55--80 | method extractCallName
   └─ 提取调用名称，处理对象创建和成员访问表达式
   86--120 | method traverseImports
   └─ 递归遍历C#语法树，处理using指令，支持别名和普通导入，构建导入映射表
   122--132 | method getComponentType
   └─ 根据节点类型映射组件类型，覆盖接口、结构体、枚举等特殊类型，默认调用父类方法

---

# src/dependency/analyzers/go.ts (117 lines)
└─ 定义Go语言分析器，支持解析函数、类型、方法和导入声明，处理全局内置函数和组件类型判断。

   10--116 | class GoAnalyzer
   └─ 实现Go语言依赖分析器，继承基础分析器，处理函数、类型、方法等节点类型

   12--15 | property GLOBAL_BUILTINS
   └─ 定义Go内置函数集合，包含append、len等12个全局内置函数

   17--27 | method getNodeTypes
   └─ 返回Go语言支持的节点类型集合，包括函数声明、类型声明、方法声明等
   29--32 | method extractFunctionName
   └─ 从函数声明节点中提取函数名称，通过查找标识符节点获取
   34--42 | method extractClassName
   └─ 从类型声明节点中提取类型名称，处理Go特有的type_spec结构
   44--61 | method extractCallName
   └─ 解析调用表达式名称，处理直接调用和方法调用两种情况
   67--92 | method traverseImports
   └─ 递归遍历导入节点，解析包路径和别名，构建导入映射表
   94--111 | method getComponentType
   └─ 检查类型声明节点，区分结构体和接口类型，返回组件类型

---

# src/dependency/analyzers/index.ts (134 lines)
└─ 注册表映射文件扩展名到分析器类，支持多种编程语言，提供获取分析器、检查支持和获取WASM语言名称的功能。

   97--102 | function getAnalyzer
   └─ 根据文件扩展名从注册表中获取对应的语言分析器类
   107--110 | function isSupported
   └─ 检查文件扩展名是否在支持的语言分析器注册表中
   115--118 | function getWasmLanguage
   └─ 根据文件扩展名获取对应的WASM语言名称

---

# src/dependency/analyzers/java.ts (98 lines)
└─ Java分析器实现，支持类、方法、调用和导入的解析，处理Java语法结构并映射依赖关系。

   10--97 | class JavaAnalyzer
   └─ 定义Java语法分析器，支持类、方法、调用和导入的识别与提取

   11--27 | method getNodeTypes
   └─ 配置Java语法节点类型，明确类、方法、调用等语法结构的识别规则
   29--32 | method extractFunctionName
   └─ 提取函数名称，通过查找标识符节点获取函数名
   34--37 | method extractClassName
   └─ 提取类名称，通过查找标识符节点获取类名
   39--56 | method extractCallName
   └─ 提取调用名称，区分方法调用和对象创建，返回对应的名称
   62--85 | method traverseImports
   └─ 递归遍历Java语法树，处理import声明，将非通配符导入映射到简单名称
   87--96 | method getComponentType
   └─ 根据节点类型确定组件类型，接口和枚举有特定映射，其他类型使用父类逻辑

---

# src/dependency/analyzers/python.ts (150 lines)
└─ 定义Python分析器类，支持解析Python文件，提取函数、类、方法、调用和导入信息，处理全局内置函数和相对导入。

   9--149 | class PythonAnalyzer
   └─ 定义Python代码分析器，继承基础分析器，提供Python特定的语法节点类型和内置函数集合。

   11--23 | property GLOBAL_BUILTINS
   └─ 存储Python全局内置函数集合，包括类型转换、序列化、迭代器等核心函数，用于代码分析。

   25--35 | method getNodeTypes
   └─ 返回Python语法节点类型映射，定义函数、类、方法、调用和导入语句的识别规则。
   37--40 | method extractFunctionName
   └─ 从函数定义节点中提取函数名称，通过查找标识符子节点获取函数名。
   42--45 | method extractClassName
   └─ 从类定义节点中提取类名称，通过查找标识符子节点获取类名。
   47--74 | method extractCallName
   └─ 提取函数调用名称，处理直接调用和属性调用，返回标识符文本
   80--144 | method traverseImports
   └─ 递归遍历Python导入语句，处理普通导入和相对导入，构建导入映射表

---

# src/dependency/analyzers/rust.ts (112 lines)
└─ 定义Rust语言分析器，支持解析函数、结构体、枚举等类型，处理导入语句和函数调用，提取依赖关系。

   10--111 | class RustAnalyzer
   └─ 定义Rust代码分析器，继承基础分析器，处理函数、类、调用和导入

   12--15 | property GLOBAL_BUILTINS
   └─ 存储Rust内置函数集合，过滤宏调用和普通函数形式的内置函数

   17--32 | method getNodeTypes
   └─ 返回Rust语法节点类型映射，包括函数、类、方法、调用和导入类型
   34--37 | method extractFunctionName
   └─ 从函数节点中提取函数名，查找标识符子节点并返回文本内容
   39--42 | method extractClassName
   └─ 从类节点中提取类名，查找类型标识符子节点并返回文本内容
   44--67 | method extractCallName
   └─ 解析函数调用名称，处理直接调用、方法调用和宏调用三种情况
   73--94 | method traverseImports
   └─ 递归遍历AST节点，提取Rust的use声明并构建导入映射表
   96--106 | method getComponentType
   └─ 根据节点类型确定组件类型，覆盖结构体、枚举和trait的特殊处理

---

# src/dependency/analyzers/typescript.ts (265 lines)
└─ 定义 TypeScript/JavaScript 分析器，支持解析函数、类、方法调用和导入语句，识别全局和成员内置函数，处理 TSX 文件扩展名。

   9--245 | class TypeScriptAnalyzer
   └─ TypeScriptAnalyzer类继承BaseAnalyzer，内置全局和成员函数集，支持TS/JS文件分析

   11--37 | property GLOBAL_BUILTINS
   └─ 定义全局内置函数集合，包含定时器、类型转换、编码、构造函数等JavaScript和Node.js标准API。
   39--66 | property MEMBER_BUILTINS
   └─ 定义成员内置函数集合，包含console、JSON、Math、Object、Array等对象的静态方法和实例方法。

   68--86 | method getNodeTypes
   └─ 返回支持的语法节点类型集合，定义函数、类、方法、调用、导入等节点的类型和文件扩展名。
   88--104 | method extractFunctionName
   └─ 提取函数名称，支持常规函数声明和方法定义，通过查找标识符节点获取函数名。
   106--112 | method extractClassName
   └─ 提取类名，优先使用type_identifier，回退到identifier
   114--140 | method extractCallName
   └─ 提取调用名称，处理直接调用、成员调用和new表达式
   146--188 | method traverseImports
   └─ 递归遍历AST处理ES6导入语句，构建导入映射表
   190--223 | method processImportClause
   └─ processImportClause方法解析ES6导入语句，处理命名空间、默认导出和重命名导入
   225--236 | method getComponentType
   └─ 确定组件类型，识别接口、抽象类和普通类声明

   256--264 | class TSXAnalyzer
   └─ 继承TypeScriptAnalyzer，专门处理.tsx文件

   257--263 | method getNodeTypes
   └─ 重写getNodeTypes方法，限制文件扩展名为.tsx

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

