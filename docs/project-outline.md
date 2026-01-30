# src/cli.ts (41 lines)

   16--34 | function main

---

# src/index.ts (14 lines)


---

# src/abstractions/config.ts (52 lines)

   22--32 | interface IConfigProvider

---

# src/abstractions/core.ts (117 lines)

   4--64 | interface IFileSystem
   69--73 | interface IStorage
   78--83 | interface IEventBus
   88--93 | interface ILogger
   98--101 | interface IFileWatcher
   103--106 | interface FileWatchEvent
   111--117 | interface IPlatformDependencies

---

# src/abstractions/index.ts (35 lines)


---

# src/abstractions/workspace.ts (105 lines)

   6--54 | interface IWorkspace
   56--60 | interface WorkspaceFolder
   65--105 | interface IPathUtils

---

# src/cli-tools/data-flow-analyzer.ts (698 lines)

   6--13 | interface DataFlowNode
   18--23 | interface DataFlowEdge
   28--33 | interface AnalysisResult

   43--681 | class DataFlowAnalyzer

   50--55 | method constructor
   60--78 | method analyze
   83--111 | method analyzeCliMain
   116--158 | method analyzeMcpServer
   163--190 | method analyzePublicApi
   195--249 | method analyzeCallChain
   254--264 | method isBuiltinCall
   269--313 | method isImportantCall
   318--370 | method extractTarget
   375--562 | method findTargetNode
   567--575 | method identifyLayer
   580--589 | method isAsyncCall
   594--599 | method addNode
   604--680 | method generateTextTree

   686--689 | function generateDataFlowDiagram

---

# src/cli-tools/outline-targets.ts (119 lines)

   5--9 | type LoggerLike

   11--19 | interface ResolveOutlineTargetsOptions
   21--35 | interface ResolveOutlineTargetsResult

   45--118 | function resolveOutlineTargets

---

# src/cli-tools/outline.ts (952 lines)

   31--61 | interface OutlineOptions
   66--74 | interface OutlineDefinition
   79--86 | interface OutlineData

   94--135 | function extractOutline
   137--151 | function createFallbackWorkspace
   164--221 | function getOutlineAsText
   233--284 | function getOutlineAsJson
   290--340 | function buildOutlineDefinitions
   345--464 | function extractDefinitionsFromCaptures
   469--511 | function renderDefinitionsAsText
   516--539 | function renderDefinitionsAsJson
   544--564 | function createStorageForOutline
   569--613 | function createSummarizerForOutline
   618--645 | function loadSummarizerConfig
   656--809 | function generateSummariesWithRetry
   811--951 | function applySummaryCache

---

# src/cli-tools/summary-cache.ts (670 lines)

   25--31 | interface CacheFingerprint
   36--45 | interface BlockSummary
   50--57 | interface SummaryCache
   62--67 | interface CacheStats
   72--76 | interface FilterResult
   81--88 | interface CodeBlock

   111--669 | class SummaryCacheManager

   115--119 | property logger

   121--135 | method constructor
   144--148 | method hashBlock
   153--157 | method hashFile
   162--164 | method hashContext
   169--179 | method createFingerprint
   192--221 | method getCachePathForSourceFile
   230--254 | method loadCache
   265--366 | method filterBlocksNeedingSummarization
   371--462 | method updateCache
   471--535 | method cleanOrphanedCaches
   540--606 | method cleanOldCaches
   616--668 | method clearAllCaches

---

# src/code-index/cache-manager.ts (138 lines)

   14--137 | class CacheManager

   23--30 | method constructor
   37--39 | method createCachePath
   44--46 | method getCachePath
   51--58 | method initialize
   63--71 | method _performSave
   77--89 | method clearCacheFile
   96--98 | method getHash
   105--108 | method updateHash
   114--117 | method deleteHash
   123--128 | method deleteHashes
   134--136 | method getAllHashes

---

# src/code-index/config-manager.ts (530 lines)

   69--81 | function getConfigValue

   87--509 | class CodeIndexConfigManager

   90--94 | method constructor
   99--101 | method getConfigProvider
   106--108 | method _loadAndSetConfiguration
   113--115 | method initialize
   120--138 | method loadConfiguration
   143--172 | method isConfigured
   177--230 | method _createConfigSnapshot
   235--328 | method doesConfigChangeRequireRestart
   333--356 | method _hasVectorDimensionChanged
   361--366 | method getConfig
   371--373 | method isFeatureEnabled
   378--380 | method isFeatureConfigured
   385--387 | method currentEmbedderProvider
   392--394 | method currentModelId
   400--413 | method currentModelDimension
   420--432 | method currentSearchMinScore
   439--442 | method currentSearchMaxResults
   447--449 | method isRerankerEnabled
   454--479 | method rerankerConfig
   486--503 | method summarizerConfig

---

# src/code-index/config-validator.ts (434 lines)

   6--22 | interface ValidationIssue
   27--37 | interface ValidationResult

   42--433 | class ConfigValidator

   48--70 | method validate
   75--174 | method validateEmbedder
   179--187 | method validateQdrant
   192--247 | method validateReranker
   254--320 | method validateSummarizer
   325--432 | method validateBasicConsistency

---

# src/code-index/i18n.ts (28 lines)

   19--27 | function t

---

# src/code-index/index.ts (29 lines)


---

# src/code-index/manager.ts (535 lines)

   17--25 | interface CodeIndexManagerDependencies

   27--535 | class CodeIndexManager

   42--56 | method getInstance
   58--63 | method disposeAll
   69--73 | method constructor
   77--79 | method workspacePathValue
   81--83 | method onProgressUpdate
   85--89 | method assertInitialized
   91--97 | method state
   99--101 | method isFeatureEnabled
   103--105 | method isFeatureConfigured
   107--114 | method isInitialized
   124--180 | method initialize
   185--189 | method loadConfiguration
   199--216 | method startIndexing
   221--228 | method stopWatcher
   244--268 | method recoverFromError
   273--278 | method dispose
   284--291 | method clearIndexData
   295--301 | method getCurrentStatus
   308--331 | method getDryRunComponents
   333--367 | method reconcileIndex
   369--375 | method searchIndex
   381--466 | method _recreateServices
   473--489 | method _initializeForSearchOnly
   497--534 | method handleSettingsChange

---

# src/code-index/orchestrator.ts (438 lines)

   42--437 | class CodeIndexOrchestrator

   46--55 | method constructor
   60--62 | method getVectorStore
   67--69 | method debug
   71--73 | method info
   75--77 | method warn
   79--81 | method error
   86--136 | method _startWatcher
   142--375 | method startIndexing
   380--388 | method stopWatcher
   397--429 | method clearIndexData
   434--436 | method state

---

# src/code-index/search-service.ts (108 lines)

   14--107 | class CodeIndexSearchService

   15--21 | method constructor
   30--106 | method searchIndex

---

# src/code-index/service-factory.ts (353 lines)

   29--352 | class CodeIndexServiceFactory

   30--35 | method constructor
   40--42 | method debug
   44--46 | method info
   48--50 | method warn
   52--54 | method error
   59--117 | method createEmbedder
   124--134 | method validateEmbedder
   139--173 | method createVectorStore
   178--196 | method createDirectoryScanner
   201--211 | method createFileWatcher
   217--247 | method createServices
   253--284 | method createReranker
   291--301 | method validateReranker
   307--335 | method createSummarizer
   342--351 | method validateSummarizer

---

# src/code-index/state-manager.ts (126 lines)

   9--125 | class CodeIndexStateManager

   17--20 | method constructor
   26--28 | method state
   30--39 | method getCurrentStatus
   43--66 | method setSystemState
   68--89 | method reportBlockIndexingProgress
   91--120 | method reportFileQueueProgress
   122--124 | method dispose

---

# src/code-index/validate-search-params.ts (43 lines)

   4--22 | function validateLimit
   25--42 | function validateMinScore

---

# src/commands/call.ts (620 lines)

   39--67 | function openGraphViewer
   72--213 | function displaySummary
   218--236 | function validateOptions
   238--269 | function exportViz
   274--308 | function querySingleFunction
   313--327 | function queryMultipleFunctions
   332--362 | function queryMode
   383--574 | function callHandler
   585--619 | function createCallCommand

---

# src/commands/index.ts (412 lines)

   13--35 | function initializeManagerForDryRun
   40--227 | function performIndexDryRun
   232--385 | function indexHandler
   390--411 | function createIndexCommand

---

# src/commands/outline.ts (195 lines)

   11--106 | function handleOutline
   111--169 | function outlineHandler
   174--194 | function createOutlineCommand

---

# src/commands/search.ts (303 lines)

   10--19 | interface SearchResult

   24--105 | function formatSearchResults
   110--175 | function formatSearchResultsAsJson
   180--278 | function searchHandler
   283--302 | function createSearchCommand

---

# src/commands/shared.ts (187 lines)

   12--40 | interface CommandOptions

   45--53 | function initGlobalLogger
   58--60 | function getLogger
   65--72 | function resolveWorkspacePath
   77--96 | function createDependencies
   104--113 | function ensureDemoFiles
   118--155 | function initializeManager
   160--186 | function waitForIndexingCompletion

---

# src/commands/stdio.ts (59 lines)

   11--40 | function stdioHandler
   45--58 | function createStdioCommand

---

# src/examples/create-sample-files.ts (1330 lines)

   2--1328 | function createSampleFiles

---

# src/examples/demo-sse-mcp-server.ts (64 lines)


---

# src/examples/embedding-test-simple.ts (254 lines)

   68--246 | function runEmbeddingTest

---

# src/examples/memory-vector-search.ts (239 lines)

   8--13 | interface VectorDocument

   15--238 | class MemoryVectorSearch

   19--51 | method constructor
   56--70 | method cosineSimilarity
   75--85 | method addDocument
   90--170 | method addDocuments
   175--209 | method search
   214--216 | method getDocumentCount
   221--223 | method clear
   228--230 | method getDocument
   235--237 | method getAllDocuments

---

# src/examples/nodejs-usage.ts (245 lines)

   23--48 | function basicUsageExample
   53--128 | function advancedUsageExample
   133--171 | function codeIndexManagerExample
   176--191 | function createTestDependencies
   196--239 | function cliExample

---

# src/examples/run-demo.ts (244 lines)

   21--178 | function main
   182--206 | function waitForIndexingToComplete
   208--236 | function demonstrateSearch

---

# src/examples/run-dependency-analyzer.ts (237 lines)

   26--233 | function main

---

# src/examples/run-example.ts (25 lines)

   6--22 | function main

---

# src/examples/simple-demo.ts (104 lines)

   16--75 | function main
   78--97 | function demonstrateFileSystem

---

# src/examples/test-embedding.ts (37 lines)

   9--30 | function main

---

# src/examples/test-full-parsing.ts (52 lines)

   6--50 | function testFullParsing

---

# src/examples/test-model-dimension.ts (29 lines)

   9--22 | function main

---

# src/examples/test-parser.ts (31 lines)

   3--29 | function testParserLoading

---

# src/examples/test-scanner.ts (37 lines)

   9--30 | function main

---

# src/glob/index.ts (2 lines)


---

# src/glob/list-files.ts (123 lines)

   23--28 | interface ListFilesDependencies
   31--39 | interface IFileSystem

   53--99 | function listFiles
   104--122 | function handleSpecialDirectories

---

# src/dependency/cache-manager.ts (420 lines)

   40--419 | class DependencyCacheManager

   51--74 | method constructor
   79--101 | method initialize
   107--134 | method getCacheEntry
   139--177 | method setCacheEntry
   182--187 | method deleteCacheEntry
   192--195 | method clearCache
   200--221 | method getStats
   226--228 | method getCachePath
   233--235 | method flush
   244--250 | method serializeNode
   255--260 | method deserializeNode
   265--274 | method createEmptyCache
   279--288 | method createFingerprint
   293--299 | method isFingerprintValid
   304--306 | method computeHash
   311--313 | method getRelativePath
   318--344 | method _performSave
   349--360 | method cleanOldEntries
   366--388 | method cleanOrphanedEntries
   394--418 | method cleanOldCacheEntries

---

# src/dependency/cache-types.ts (117 lines)

   11--17 | interface CacheFingerprint
   23--26 | interface SerializedDependencyNode
   31--55 | interface FileCacheEntry
   60--75 | interface AnalysisCache
   80--99 | interface CacheStats

---

# src/dependency/graph.ts (394 lines)

   20--23 | function extractSimpleName
   35--56 | function extractModulePath
   76--91 | function moduleDistance
   111--183 | function resolveEdges
   188--206 | function buildAdjacency
   220--265 | function detectCycles
   228--256 | function strongconnect
   278--316 | function topologicalSort
   323--332 | function getLeafNodes
   349--393 | function buildGraph

---

# src/dependency/index.ts (518 lines)

   66--70 | interface DependencyAnalyzerDeps

   85--98 | function findGitRoot
   120--325 | function analyze
   332--337 | function analyzeFile

   346--360 | interface VisualizationData

   383--472 | function generateVisualizationData

   483--518 | class DependencyAnalysisService

   489--517 | method analyzeLocalRepository

---

# src/dependency/models.ts (207 lines)

   18--68 | interface DependencyNode
   75--90 | interface DependencyEdge
   95--113 | interface DependencyResult
   118--130 | interface DependencySummary
   136--139 | interface ParseOutput
   145--163 | interface FileParseResult
   168--173 | interface LanguageConfig
   178--182 | interface ParserCacheEntry
   187--191 | interface FileFilter
   196--206 | interface AnalysisOptions

---

# src/dependency/parse.ts (399 lines)

   75--123 | class ParserCache

   80--83 | method constructor
   85--97 | method get
   99--118 | method set
   120--122 | method clear

   133--147 | function ensureParserInitialized
   152--192 | function initializeParser
   197--213 | function loadLanguageParser
   225--288 | function walkFiles
   238--284 | function walk
   293--336 | function parseFile
   341--364 | function parseDirectory
   369--377 | function getLanguageConfig
   382--384 | function clearParserCache
   389--391 | function getSupportedLanguages
   396--398 | function getLanguageConfigs

---

# src/dependency/query.ts (591 lines)

   19--22 | interface QueryOptions
   27--34 | interface NodeQueryResult
   39--54 | interface TreeNode
   59--70 | interface ConnectionAnalysisResult
   75--82 | interface DirectConnection
   87--92 | interface Chain

   102--108 | function globToRegex
   124--134 | function matchesPattern
   143--179 | function findMatchingNodes
   188--221 | function buildCalleeTree
   226--259 | function buildCallerTree
   269--287 | function queryNode
   296--304 | function buildAdjacency
   309--329 | function findDirectConnections
   334--368 | function findShortestPath
   373--396 | function findChains
   406--456 | function analyzeConnections
   465--478 | function formatTreeNode
   483--518 | function formatNodeQueryResult
   523--590 | function formatConnectionAnalysisResult

---

# src/ignore/IgnoreService.ts (191 lines)

   11--15 | interface IgnoreServiceOptions

   21--190 | class IgnoreService

   26--33 | method constructor
   39--60 | method initialize
   62--73 | method loadIgnoreFile
   87--109 | method shouldSkipDirectory
   118--130 | method shouldIgnore
   136--138 | method filterFiles
   143--145 | method filterDirectories
   150--173 | method toRelative
   178--182 | method getRules
   187--189 | method isInitialized

---

# src/ignore/default-dirs.ts (31 lines)


---

# src/lib/codebase.ts (4 lines)

   1--3 | function codebase

---

# src/mcp/http-server.ts (752 lines)

   20--24 | interface HTTPMCPServerOptions

   26--751 | class CodebaseHTTPMCPServer

   35--47 | method constructor
   49--159 | method setupTools
   161--163 | method createServer
   165--303 | method handleSearchCodebase
   305--340 | method handleGetSearchStats
   342--375 | method handleConfigureSearch
   380--509 | method handleOutlineCodebase
   514--516 | method generateSessionId
   518--682 | method setupHTTPServer
   684--696 | method start
   698--750 | method stop

---

# src/mcp/stdio-adapter.ts (418 lines)

   18--21 | interface StdioAdapterOptions

   23--417 | class StdioToStreamableHTTPAdapter

   32--36 | method constructor
   41--48 | method start
   53--68 | method stop
   74--140 | method connectSSE
   146--169 | method handleServerMessage
   174--200 | method setupStdioHandlers
   205--236 | method handleStdinMessage
   242--340 | method forwardRequestToServer
   346--404 | method httpRequest
   409--416 | method writeStdoutResponse

---

# src/ripgrep/index.ts (312 lines)

   55--58 | interface SearchFileResult
   60--62 | interface SearchResult
   64--69 | interface SearchLineResult

   80--82 | function truncateLine
   87--130 | function getBinPath
   132--170 | function execRipgrep

   172--176 | interface RipgrepOptions

   182--184 | function createIgnoreFilter
   186--267 | function regexSearchFiles
   269--311 | function formatResults

---

# src/search/file-search.ts (177 lines)

   17--20 | function getBinPath
   24--99 | function executeRipgrep
   101--121 | function executeRipgrepForFiles
   123--176 | function searchWorkspaceFiles

---

# src/search/index.ts (2 lines)


---

# src/shared/api.ts (10 lines)

   2--6 | interface ApiHandlerOptions
   8--10 | interface BaseApiHandler

---

# src/shared/embeddingModels.ts (196 lines)

   7--10 | interface EmbeddingModelProfile

   12--16 | type EmbeddingModelProfiles

   73--89 | function getModelDimension
   99--139 | function getDefaultModelId
   148--152 | function getModelQueryPrefix
   161--195 | function getModelScoreThreshold

---

# src/shared/index.ts (2 lines)


---

# src/tools/file-chunker-cli.ts (271 lines)

   9--23 | interface CLIOptions

   28--92 | function formatOutput
   97--101 | function findFiles
   106--261 | function main

---

# src/tools/file-chunker.ts (249 lines)

   11--14 | interface ParentContainer
   19--44 | interface FileChunk
   49--64 | interface FileChunkerOptions
   69--82 | interface ChunkResult

   109--227 | class FileChunker

   110--118 | property defaultOptions

   120--122 | method constructor
   130--186 | method chunkFile
   194--208 | method chunkFiles
   215--218 | method isFileSupported
   224--226 | method getSupportedExtensions

   235--238 | function chunkFile
   246--249 | function chunkFiles

---

# src/tools/test-tree-sitter.ts (201 lines)

   27--44 | function parseFile
   49--122 | function outputCapturesAsJson
   127--142 | function getFilePath
   147--163 | function showUsage
   166--194 | function main

---

# src/types/vitest.d.ts (140 lines)

   47--49 | method arrayContaining
   55--57 | method hasLength

   116--136 | interface Mock

---

# src/tree-sitter/index.ts (453 lines)

   9--13 | interface TreeSitterDependencies

   24--26 | function getMinComponentLines
   31--33 | function setMinComponentLines
   104--157 | function parseSourceCodeDefinitionsForFile
   160--242 | function parseSourceCodeForDefinitionsTopLevel
   244--248 | function separateFiles
   283--404 | function processCaptures
   414--452 | function parseFile

---

# src/tree-sitter/languageParser.ts (247 lines)

   34--39 | interface LanguageParser

   41--49 | function loadLanguage
   54--75 | function initializeParser
   99--246 | function loadRequiredLanguageParsers

---

# src/tree-sitter/markdownParser.ts (217 lines)

   10--19 | interface MockNode
   24--27 | interface MockCapture

   35--173 | function parseMarkdown
   183--216 | function formatMarkdownCaptures

---

# src/tree-sitter/wasm-loader.ts (116 lines)

   16--24 | function getBasePath
   30--34 | function isDevelopment
   55--90 | function resolveWasmPath
   104--115 | function createLocateFileFunction

---

# src/utils/config-provider.ts (154 lines)

   33--37 | interface IConfigProvider

   43--112 | class SimpleConfigProvider

   51--65 | method loadConfig
   71--75 | method ensureLoaded
   82--86 | method getGlobalState
   94--104 | method getSecret
   109--111 | method refreshSecrets

   118--120 | function createSimpleConfigProvider
   126--130 | function createInitializedConfigProvider
   140--145 | function getGlobalConfigProvider
   151--153 | function setGlobalConfigProvider

---

# src/utils/events.ts (95 lines)

   9--75 | class EventBus

   12--15 | method constructor
   21--27 | method on
   32--34 | method off
   39--41 | method emit
   47--53 | method once
   58--60 | method listenerCount
   65--67 | method removeAllListeners
   72--74 | method eventNames

   80--82 | function createEventBus
   89--94 | function getGlobalEventBus

---

# src/utils/filesystem.ts (118 lines)

   11--14 | function readFile
   19--21 | function readFileText
   26--35 | function writeFile
   40--47 | function exists
   52--65 | function stat
   70--73 | function readdir
   78--80 | function readdirNames
   85--87 | function mkdir
   92--99 | function remove
   104--108 | function copyFile
   113--117 | function rename

---

# src/utils/fs.ts (68 lines)

   11--32 | function createDirectoriesForFile
   40--47 | function fileExistsAtPath
   56--67 | function safeWriteJson

---

# src/utils/git-global-ignore.ts (221 lines)

   9--14 | interface GitCommandResult
   18--24 | interface EnsureGitGlobalIgnoreDependencies
   26--31 | interface EnsureGitGlobalIgnoreResult

   33--41 | function defaultRunGit
   43--46 | function getConfigHome
   48--63 | function atomicWriteFile
   65--67 | function detectEol
   69--71 | function splitLines
   73--80 | function fileExists
   82--87 | function getExcludesFilePath
   89--94 | function getExcludesFilePathRaw
   96--98 | function setExcludesFilePath
   100--102 | function unsetExcludesFilePath
   104--106 | function isGitAvailable
   117--220 | function ensureGitGlobalIgnorePatterns

---

# src/utils/index.ts (56 lines)


---

# src/utils/jsonc-helpers.ts (170 lines)

   16--115 | function saveJsoncPreservingComments
   45--51 | function isPlainObject
   56--100 | function applyUpdates
   120--122 | function getPathValue
   128--132 | function isValidJsonc
   139--158 | function mergeConfig
   163--169 | function isPlainObject

---

# src/utils/logger.ts (184 lines)

   8--17 | interface LoggerOptions

   34--145 | class Logger

   40--45 | method constructor
   50--52 | method debug
   57--59 | method info
   64--66 | method warn
   71--73 | method error
   78--117 | method log
   122--124 | method setLevel
   129--131 | method getLevel
   136--144 | method child

   150--152 | function createLogger
   157--159 | function createNamedLogger
   166--171 | function getGlobalLogger
   173--175 | function setGlobalLogger
   177--183 | function setGlobalLogLevel

---

# src/utils/path-filters.ts (57 lines)

   10--48 | function parsePathFilters
   53--55 | function isGlobPattern

---

# src/utils/path.ts (112 lines)

   29--38 | function toPosixPath

   43--45 | interface String

   53--68 | function arePathsEqual
   70--79 | function normalizePath
   81--101 | function getReadablePath

---

# src/utils/storage.ts (154 lines)

   8--11 | interface StorageOptions

   13--146 | class Storage

   18--20 | method constructor
   25--41 | method load
   46--52 | method save
   57--60 | method get
   65--68 | method getOrDefault
   73--77 | method set
   82--89 | method delete
   94--97 | method has
   102--105 | method keys
   110--113 | method values
   118--121 | method entries
   126--129 | method clear
   134--137 | method size
   142--145 | method reload

   151--153 | function createStorage

---

# src/adapters/nodejs/config.ts (354 lines)

   15--19 | interface NodeConfigOptions

   22--353 | class NodeConfigProvider

   29--42 | method constructor
   44--78 | method getEmbedderConfig
   80--86 | method getVectorStoreConfig
   88--90 | method isCodeIndexEnabled
   92--98 | method getSearchConfig
   100--102 | method getConfig
   104--114 | method onConfigChange
   119--124 | method ensureConfigLoaded
   129--132 | method reloadConfig
   137--181 | method loadConfig
   187--230 | method saveConfig
   235--240 | method updateConfig
   245--247 | method resetConfig
   252--254 | method getCurrentConfig
   259--289 | method isConfigured
   294--352 | method validateConfig

---

# src/adapters/nodejs/event-bus.ts (56 lines)

   8--56 | class NodeEventBus

   11--15 | method constructor
   17--19 | method emit
   21--28 | method on
   30--32 | method off
   34--41 | method once
   46--48 | method listenerCount
   53--55 | method removeAllListeners

---

# src/adapters/nodejs/file-system.ts (84 lines)

   9--83 | class NodeFileSystem

   10--17 | method readFile
   19--29 | method writeFile
   31--38 | method exists
   40--52 | method stat
   54--61 | method readdir
   63--69 | method mkdir
   71--82 | method delete

---

# src/adapters/nodejs/file-watcher.ts (88 lines)

   8--88 | class NodeFileWatcher

   11--32 | method watchFile
   34--57 | method watchDirectory
   62--67 | method dispose
   72--74 | method getWatcherCount
   76--87 | method mapEventType

---

# src/adapters/nodejs/index.ts (94 lines)

   29--76 | function createNodeDependencies
   81--93 | function createSimpleNodeDependencies

---

# src/adapters/nodejs/logger.ts (105 lines)

   7--12 | interface NodeLoggerOptions

   14--105 | class NodeLogger

   20--25 | property levels
   27--33 | property colorCodes

   35--40 | method constructor
   42--44 | method debug
   46--48 | method info
   50--52 | method warn
   54--56 | method error
   58--90 | method log
   95--97 | method setLevel
   102--104 | method getLevel

---

# src/adapters/nodejs/storage.ts (57 lines)

   12--15 | interface NodeStorageOptions

   17--57 | class NodeStorage

   21--24 | method constructor
   26--28 | method getGlobalStorageUri
   30--34 | method createCachePath
   36--38 | method getCacheBasePath
   40--46 | method hashWorkspacePath
   48--56 | method simpleHash

---

# src/adapters/nodejs/workspace.ts (193 lines)

   11--14 | interface NodeWorkspaceOptions

   16--158 | class NodeWorkspace

   23--34 | method constructor
   36--38 | method getRootPath
   40--44 | method getRelativePath
   46--48 | method getIgnoreRules
   54--73 | method getGlobIgnorePatterns
   75--78 | method shouldIgnore
   84--86 | method getIgnoreService
   88--91 | method getName
   93--100 | method getWorkspaceFolders
   102--123 | method findFiles
   129--137 | method matchPattern
   139--157 | method walkDirectory

   160--192 | class NodePathUtils

   161--163 | method join
   165--167 | method dirname
   169--171 | method basename
   173--175 | method extname
   177--179 | method resolve
   181--183 | method isAbsolute
   185--187 | method relative
   189--191 | method normalize

---

# src/code-index/constants/index.ts (114 lines)

   84--93 | function getBatchSizeForEmbedder

---

# src/code-index/constants/search-config.ts (25 lines)

   14--18 | type SearchLimits
   20--24 | type SearchMinScore

---

# src/code-index/embedders/gemini.ts (89 lines)

   13--89 | class GeminiEmbedder

   24--39 | method constructor
   47--56 | method createEmbeddings
   62--71 | method validateConfiguration
   76--80 | method embedderInfo
   85--88 | method optimalBatchSize

---

# src/code-index/embedders/jina-embedder.ts (223 lines)

   9--21 | interface JinaEmbeddingResponse

   26--222 | class JinaEmbedder

   32--42 | method constructor
   47--98 | method createEmbeddings
   103--162 | method _embedBatchWithRetries
   167--205 | method validateConfiguration
   210--214 | method embedderInfo
   219--221 | method optimalBatchSize

---

# src/code-index/embedders/mistral.ts (88 lines)

   12--88 | class MistralEmbedder

   23--38 | method constructor
   46--55 | method createEmbeddings
   61--70 | method validateConfiguration
   75--79 | method embedderInfo
   84--87 | method optimalBatchSize

---

# src/code-index/embedders/ollama.ts (385 lines)

   17--384 | class CodeIndexOllamaEmbedder

   22--33 | method constructor
   41--66 | method createEmbeddings
   71--170 | method _createEmbeddingsWithTimeout
   175--199 | method _isRetryableError
   204--220 | method _formatEmbeddingError
   226--370 | method validateConfiguration
   372--376 | method embedderInfo
   381--383 | method optimalBatchSize

---

# src/code-index/embedders/openai-compatible.ts (522 lines)

   15--18 | interface EmbeddingItem
   20--26 | interface OpenAIEmbeddingResponse

   32--521 | class OpenAICompatibleEmbedder

   42--49 | property globalRateLimitState

   58--119 | method constructor
   127--195 | method createEmbeddings
   203--217 | method isFullEndpointUrl
   227--280 | method makeDirectEmbeddingRequest
   288--379 | method _embedBatchWithRetries
   385--420 | method validateConfiguration
   425--429 | method embedderInfo
   434--436 | method optimalBatchSize
   441--468 | method waitForGlobalRateLimit
   473--502 | method updateGlobalRateLimitState
   507--520 | method getGlobalRateLimitDelay

---

# src/code-index/embedders/openai.ts (261 lines)

   18--260 | class OpenAiEmbedder

   27--75 | method constructor
   83--151 | method createEmbeddings
   159--216 | method _embedBatchWithRetries
   222--246 | method validateConfiguration
   248--252 | method embedderInfo
   257--259 | method optimalBatchSize

---

# src/code-index/embedders/openrouter.ts (380 lines)

   14--17 | interface EmbeddingItem
   19--25 | interface OpenRouterEmbeddingResponse

   32--380 | class OpenRouterEmbedder

   41--48 | property globalRateLimitState

   56--82 | method constructor
   90--158 | method createEmbeddings
   166--246 | method _embedBatchWithRetries
   252--279 | method validateConfiguration
   284--288 | method embedderInfo
   293--295 | method optimalBatchSize
   300--327 | method waitForGlobalRateLimit
   332--361 | method updateGlobalRateLimitState
   366--379 | method getGlobalRateLimitDelay

---

# src/code-index/embedders/vercel-ai-gateway.ts (97 lines)

   21--97 | class VercelAiGatewayEmbedder

   32--47 | method constructor
   55--64 | method createEmbeddings
   70--79 | method validateConfiguration
   84--88 | method embedderInfo
   93--96 | method optimalBatchSize

---

# src/code-index/interfaces/cache.ts (38 lines)

   1--37 | interface ICacheManager

---

# src/code-index/interfaces/config.ts (302 lines)

   3--11 | type EmbedderProvider

   16--21 | interface OllamaEmbedderConfig
   26--31 | interface OpenAIEmbedderConfig
   36--42 | interface OpenAICompatibleEmbedderConfig
   47--52 | interface JinaEmbedderConfig
   57--62 | interface GeminiEmbedderConfig
   67--72 | interface MistralEmbedderConfig
   77--82 | interface VercelAiGatewayEmbedderConfig
   87--92 | interface OpenRouterEmbedderConfig

   97--105 | type EmbedderConfig

   110--180 | interface CodeIndexConfig

   185--232 | type PreviousConfigSnapshot

   237--240 | interface VectorStoreConfig
   245--248 | interface SearchConfig
   254--301 | interface ConfigSnapshot

---

# src/code-index/interfaces/embedder.ts (49 lines)

   5--26 | interface IEmbedder
   28--34 | interface EmbeddingResponse

   36--44 | type AvailableEmbedders

   46--48 | interface EmbedderInfo

---

# src/code-index/interfaces/file-processor.ts (147 lines)

   6--22 | interface ICodeParser

   13--21 | method parseFile

   27--54 | interface IDirectoryScanner

   34--46 | method scanDirectory

   59--105 | interface ICodeFileWatcher
   107--112 | interface BatchProcessingSummary
   114--123 | interface FileProcessingResult
   129--132 | interface ParentContainer
   134--146 | interface CodeBlock

---

# src/code-index/interfaces/index.ts (7 lines)


---

# src/code-index/interfaces/manager.ts (92 lines)

   10--74 | interface ICodeIndexManager

   76--84 | type EmbedderProvider

   86--91 | interface IndexProgressUpdate

---

# src/code-index/interfaces/reranker.ts (56 lines)

   5--10 | interface RerankerCandidate
   12--17 | interface RerankerResult
   19--22 | interface RerankerInfo
   24--37 | interface RerankerConfig
   39--55 | interface IReranker

---

# src/code-index/interfaces/summarizer.ts (232 lines)

   4--35 | interface SummarizerRequest
   40--50 | interface SummarizerResult
   55--65 | interface SummarizerInfo
   70--135 | interface SummarizerConfig
   140--177 | interface SummarizerBatchRequest
   182--197 | interface SummarizerBatchResult
   203--231 | interface ISummarizer

---

# src/code-index/interfaces/vector-store.ts (103 lines)

   4--8 | type PointStruct

   10--82 | interface IVectorStore

   29--32 | method search

   84--88 | interface SearchFilter
   90--94 | interface VectorStoreSearchResult
   96--102 | interface Payload

---

# src/code-index/processors/batch-processor.ts (496 lines)

   16--21 | interface BatchProcessingResult
   23--44 | interface BatchProcessorOptions

   54--495 | class BatchProcessor

   60--70 | method _isRecoverableError
   76--104 | method _truncateTextByLines
   111--204 | method _processItemWithTruncation
   209--305 | method _processItemsIndividually
   307--340 | method processBatch
   342--376 | method handleDeletions
   378--393 | method processItemsInBatches
   398--494 | method processSingleBatch

---

# src/code-index/processors/file-watcher.ts (574 lines)

   34--573 | class FileWatcher

   56--60 | property onBatchProgressUpdate
   65--68 | property onBatchProgressBlocksUpdate

   84--115 | method constructor
   120--149 | method initialize
   154--161 | method dispose
   167--170 | method handleFileCreated
   176--179 | method handleFileChanged
   185--188 | method handleFileDeleted
   193--198 | method scheduleBatchProcessing
   203--215 | method triggerBatchProcessing
   221--427 | method processBatch
   437--481 | method handleFileDeletions
   488--572 | method processFile

---

# src/code-index/processors/index.ts (4 lines)


---

# src/code-index/processors/parser.ts (1059 lines)

   46--50 | interface MarkdownHeader

   55--1055 | class CodeParser

   67--101 | method parseFile
   108--110 | method isSupportedLanguage
   117--119 | method createFileHash
   128--319 | method parseContent
   324--500 | method _chunkTextByLines
   502--510 | method _performFallbackChunking
   512--548 | method _chunkLeafNodeByLines
   555--594 | method _chunkDefinitionNodeByLines
   599--615 | method deduplicateBlocks
   623--632 | method buildParentChain
   637--689 | method buildTreeSitterParentChain
   695--726 | method buildMarkdownParentChain
   732--734 | method getMarkdownDisplayType
   739--780 | method extractNodeIdentifier
   785--805 | method normalizeNodeType
   810--825 | method buildHierarchyDisplay
   830--845 | method buildMarkdownHierarchyDisplay
   850--860 | method updateHeaderStack
   865--870 | method isBlockContained
   875--944 | method processMarkdownSection
   946--1054 | method parseMarkdownContent

---

# src/code-index/processors/scanner.ts (458 lines)

   30--39 | interface DirectoryScannerDependencies

   41--458 | class DirectoryScanner

   45--56 | method constructor
   61--63 | method debug
   73--109 | method filterSupportedFiles
   119--363 | method scanDirectory
   365--450 | method processBatch
   452--457 | method getAllFilePaths

---

# src/code-index/rerankers/index.ts (3 lines)


---

# src/code-index/rerankers/ollama.ts (495 lines)

   12--494 | class OllamaLLMReranker

   20--36 | method constructor
   46--134 | method rerank
   142--162 | method rerankSingleBatch
   167--196 | method buildScoringPrompt
   201--225 | method buildContextInfo
   230--316 | method generateScores
   321--336 | method extractScoresFromText
   342--486 | method validateConfiguration
   488--493 | method rerankerInfo

---

# src/code-index/rerankers/openai-compatible.ts (575 lines)

   12--574 | class OpenAICompatibleReranker

   21--39 | method constructor
   49--139 | method rerank
   147--167 | method rerankSingleBatch
   172--201 | method buildScoringPrompt
   206--230 | method buildContextInfo
   235--344 | method generateScores
   349--364 | method extractScoresFromText
   370--566 | method validateConfiguration
   568--573 | method rerankerInfo

---

# src/code-index/shared/block-text-generator.ts (38 lines)

   13--37 | function generateBlockEmbeddingText

---

# src/code-index/shared/get-relative-path.ts (32 lines)

   11--16 | function generateNormalizedAbsolutePath
   26--31 | function generateRelativeFilePath

---

# src/code-index/shared/openai-error-handler.ts (20 lines)

   5--20 | function handleOpenAIError

---

# src/code-index/shared/supported-extensions.ts (35 lines)

   32--34 | function shouldUseFallbackChunking

---

# src/code-index/shared/validation-helpers.ts (212 lines)

   6--41 | function sanitizeErrorMessage

   46--51 | interface HttpError
   56--61 | interface ValidationError

   66--83 | function getErrorMessageForStatus
   88--104 | function extractStatusCode
   109--127 | function extractErrorMessage
   133--181 | function handleValidationError
   186--196 | function withValidationErrorHandling
   201--212 | function formatEmbeddingError

---

# src/code-index/search/query-prefill.ts (37 lines)

   18--37 | function applyQueryPrefill

---

# src/code-index/summarizers/index.ts (3 lines)


---

# src/code-index/summarizers/ollama.ts (424 lines)

   11--423 | class OllamaSummarizer

   17--29 | method constructor
   35--50 | method summarize
   56--104 | method buildPrompt
   111--155 | method extractCompleteJsonObject
   161--289 | method summarizeBatch
   294--415 | method validateConfiguration
   417--422 | method summarizerInfo

---

# src/code-index/summarizers/openai-compatible.ts (403 lines)

   13--57 | function extractCompleteJsonObject

   63--402 | class OpenAICompatibleSummarizer

   70--84 | method constructor
   90--105 | method summarize
   111--159 | method buildPrompt
   165--306 | method summarizeBatch
   311--394 | method validateConfiguration
   396--401 | method summarizerInfo

---

# src/code-index/vector-store/qdrant-client.ts (817 lines)

   18--120 | class PatternCompiler

   24--68 | method compile
   75--88 | method expandPattern
   95--119 | method extractSubstrings

   125--816 | class QdrantVectorStore

   141--187 | method constructor
   189--202 | method getCollectionInfo
   208--226 | method isCollectionNotFoundError
   232--294 | method initialize
   301--370 | method _recreateCollectionWithNewDimension
   375--425 | method _createPayloadIndexes
   431--481 | method upsertPoints
   488--495 | method isPayloadValid
   503--550 | method search
   556--558 | method deletePointsByFilePath
   560--622 | method deletePointsByMultipleFilePaths
   627--637 | method deleteCollection
   642--660 | method clearCollection
   666--669 | method collectionExists
   671--701 | method getAllFilePaths
   707--741 | method hasIndexedData
   747--778 | method markIndexingComplete
   784--815 | method markIndexingIncomplete

---

# src/commands/config/file-loader.ts (88 lines)

   14--19 | interface ConfigLayer
   24--33 | interface ConfigLayers

   42--54 | function loadConfigLayer
   67--87 | function loadConfigLayers

---

# src/commands/config/get.ts (123 lines)

   14--19 | function formatValue
   24--53 | function printAllConfigLayers
   58--74 | function printConfigItemLayers
   79--122 | function configGetHandler

---

# src/commands/config/index.ts (38 lines)

   9--37 | function createConfigCommand

---

# src/commands/config/metadata.ts (147 lines)

   13--24 | interface ConfigKeyMetadata

   130--132 | function getValidConfigKeys
   137--139 | function getConfigKeyMetadata
   144--146 | function isValidConfigKey

---

# src/commands/config/parser.ts (146 lines)

   18--97 | function parseConfigValue
   106--135 | function parseConfigPairs

---

# src/commands/config/set.ts (91 lines)

   20--49 | function saveConfig
   54--90 | function configSetHandler

---

# src/dependency/analyzers/base.ts (717 lines)

   11--15 | interface CallInfo
   20--41 | interface NodeTypes

   53--716 | class BaseAnalyzer

   70--82 | method constructor
   108--110 | method getLanguageName
   113--115 | method getFileExtensions
   118--120 | method shouldSkipNode
   123--134 | method getComponentType
   140--162 | method analyze
   168--203 | method traverseForNodes
   205--244 | method traverseForCalls
   250--266 | method addClassNode
   268--285 | method addFunctionNode
   287--309 | method addMethodNode
   315--343 | method createModuleNode
   349--351 | method getModuleNodeId
   361--372 | method ensureModuleNode
   374--411 | method addEdge
   421--443 | method resolveModulePath
   449--451 | method getNodeText
   453--463 | method findChildByType
   465--470 | method findChildrenByType
   473--486 | method getModulePath
   489--496 | method getRelativePath
   499--505 | method makeNodeId
   508--512 | method getSourceSegment
   515--522 | method findNodeIdByLine
   525--550 | method extractParameters
   557--559 | method getGlobalBuiltins
   562--564 | method getMemberBuiltins
   606--655 | method extractMemberPath
   662--701 | method extractCallInfo
   704--715 | method shouldFilterCall

---

# src/dependency/analyzers/c.ts (117 lines)

   13--116 | class CAnalyzer

   15--23 | property GLOBAL_BUILTINS

   25--35 | method getNodeTypes
   37--44 | method extractFunctionName
   46--49 | method extractClassName
   51--66 | method extractCallName
   68--70 | method extractImports
   72--101 | method traverseImports
   103--111 | method getComponentType
   113--115 | method getGlobalBuiltins

---

# src/dependency/analyzers/cpp.ts (57 lines)

   17--56 | class CppAnalyzer

   19--27 | method getNodeTypes
   29--42 | method extractClassName
   44--55 | method getComponentType

---

# src/dependency/analyzers/csharp.ts (134 lines)

   13--133 | class CSharpAnalyzer

   15--32 | method getNodeTypes
   34--37 | method extractFunctionName
   39--53 | method extractClassName
   55--80 | method extractCallName
   82--84 | method extractImports
   86--120 | method traverseImports
   122--132 | method getComponentType

---

# src/dependency/analyzers/go.ts (117 lines)

   10--116 | class GoAnalyzer

   12--15 | property GLOBAL_BUILTINS

   17--27 | method getNodeTypes
   29--32 | method extractFunctionName
   34--42 | method extractClassName
   44--61 | method extractCallName
   63--65 | method extractImports
   67--92 | method traverseImports
   94--111 | method getComponentType
   113--115 | method getGlobalBuiltins

---

# src/dependency/analyzers/index.ts (134 lines)

   97--102 | function getAnalyzer
   107--110 | function isSupported
   115--118 | function getWasmLanguage

---

# src/dependency/analyzers/java.ts (98 lines)

   10--97 | class JavaAnalyzer

   11--27 | method getNodeTypes
   29--32 | method extractFunctionName
   34--37 | method extractClassName
   39--56 | method extractCallName
   58--60 | method extractImports
   62--85 | method traverseImports
   87--96 | method getComponentType

---

# src/dependency/analyzers/python.ts (150 lines)

   9--149 | class PythonAnalyzer

   11--23 | property GLOBAL_BUILTINS

   25--35 | method getNodeTypes
   37--40 | method extractFunctionName
   42--45 | method extractClassName
   47--74 | method extractCallName
   76--78 | method extractImports
   80--144 | method traverseImports
   146--148 | method getGlobalBuiltins

---

# src/dependency/analyzers/rust.ts (112 lines)

   10--111 | class RustAnalyzer

   12--15 | property GLOBAL_BUILTINS

   17--32 | method getNodeTypes
   34--37 | method extractFunctionName
   39--42 | method extractClassName
   44--67 | method extractCallName
   69--71 | method extractImports
   73--94 | method traverseImports
   96--106 | method getComponentType
   108--110 | method getGlobalBuiltins

---

# src/dependency/analyzers/typescript.ts (265 lines)

   9--245 | class TypeScriptAnalyzer

   11--37 | property GLOBAL_BUILTINS
   39--66 | property MEMBER_BUILTINS

   68--86 | method getNodeTypes
   88--104 | method extractFunctionName
   106--112 | method extractClassName
   114--140 | method extractCallName
   142--144 | method extractImports
   146--188 | method traverseImports
   190--223 | method processImportClause
   225--236 | method getComponentType
   238--240 | method getGlobalBuiltins
   242--244 | method getMemberBuiltins

   256--264 | class TSXAnalyzer

   257--263 | method getNodeTypes

---

# src/tree-sitter/queries/c-sharp.ts (66 lines)


---

# src/tree-sitter/queries/c.ts (91 lines)


---

# src/tree-sitter/queries/cpp.ts (97 lines)


---

# src/tree-sitter/queries/css.ts (72 lines)


---

# src/tree-sitter/queries/elisp.ts (41 lines)


---

# src/tree-sitter/queries/elixir.ts (71 lines)


---

# src/tree-sitter/queries/embedded_template.ts (20 lines)


---

# src/tree-sitter/queries/go.ts (24 lines)


---

# src/tree-sitter/queries/html.ts (52 lines)


---

# src/tree-sitter/queries/index.ts (29 lines)


---

# src/tree-sitter/queries/java.ts (77 lines)


---

# src/tree-sitter/queries/javascript.ts (131 lines)


---

# src/tree-sitter/queries/kotlin.ts (111 lines)


---

# src/tree-sitter/queries/lua.ts (38 lines)


---

# src/tree-sitter/queries/ocaml.ts (32 lines)


---

# src/tree-sitter/queries/php.ts (173 lines)


---

# src/tree-sitter/queries/python.ts (89 lines)


---

# src/tree-sitter/queries/ruby.ts (205 lines)


---

# src/tree-sitter/queries/rust.ts (81 lines)


---

# src/tree-sitter/queries/scala.ts (45 lines)


---

# src/tree-sitter/queries/solidity.ts (45 lines)


---

# src/tree-sitter/queries/swift.ts (79 lines)


---

# src/tree-sitter/queries/systemrdl.ts (34 lines)


---

# src/tree-sitter/queries/tlaplus.ts (33 lines)


---

# src/tree-sitter/queries/toml.ts (25 lines)


---

# src/tree-sitter/queries/tsx.ts (88 lines)


---

# src/tree-sitter/queries/typescript.ts (124 lines)


---

# src/tree-sitter/queries/vue.ts (30 lines)


---

# src/tree-sitter/queries/zig.ts (22 lines)


---

