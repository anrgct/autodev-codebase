import { readFile, stat } from "fs/promises"
import { createHash } from "crypto"
import * as path from "path"
import { CodeParser } from "../code-index/processors/parser"
import { scannerExtensions } from "../code-index/shared/supported-extensions"
import { MAX_BLOCK_CHARS, MIN_BLOCK_CHARS, MIN_CHUNK_REMAINDER_CHARS, MAX_CHARS_TOLERANCE_FACTOR } from "../code-index/constants"

/**
 * 父级容器信息
 */
export interface ParentContainer {
  identifier: string | null
  type: string
}

/**
 * 文件块结构
 */
export interface FileChunk {
  /** 文件路径 */
  filePath: string
  /** 块的唯一标识符 */
  identifier: string | null
  /** 块类型 */
  type: string
  /** 起始行号（1-based） */
  startLine: number
  /** 结束行号（1-based） */
  endLine: number
  /** 块内容 */
  content: string
  /** 块的哈希值 */
  segmentHash: string
  /** 文件哈希值 */
  fileHash: string
  /** 块来源 */
  chunkSource: 'tree-sitter' | 'fallback' | 'line-segment' | 'markdown'
  /** 父级容器信息 */
  parentChain: ParentContainer[]
  /** 层级显示信息 */
  hierarchyDisplay: string | null
  /** 块大小（字符数） */
  size: number
}

/**
 * 文件切块配置选项
 */
export interface FileChunkerOptions {
  /** 最小块大小（字符数） */
  minChunkChars?: number
  /** 最大块大小（字符数） */
  maxChunkChars?: number
  /** 最小剩余字符数 */
  minChunkRemainderChars?: number
  /** 最大字符容错因子 */
  maxCharsToleranceFactor?: number
  /** 自定义块类型 */
  chunkType?: string
  /** 是否跳过空块 */
  skipEmptyChunks?: boolean
  /** 行重叠数量（用于保持上下文） */
  lineOverlap?: number
}

/**
 * 文件切块结果
 */
export interface ChunkResult {
  /** 原始文件路径 */
  filePath: string
  /** 文件大小（字节） */
  fileSize: number
  /** 文件哈希值 */
  fileHash: string
  /** 生成的块列表 */
  chunks: FileChunk[]
  /** 处理耗时（毫秒） */
  processingTime: number
  /** 使用的切块策略 */
  strategy: 'tree-sitter' | 'fallback' | 'markdown'
}

/**
 * 模拟依赖项，用于调用 parseSourceCodeDefinitionsForFile
 */
const mockDependencies = {
  fileSystem: {
    exists: async (filePath: string) => true,
    readFile: async (filePath: string) => {
      const content = await readFile(filePath, 'utf-8')
      return new TextEncoder().encode(content)
    }
  },
  workspace: {
    shouldIgnore: async (filePath: string) => false
  },
  pathUtils: {
    extname: (filePath: string) => path.extname(filePath),
    basename: (filePath: string) => path.basename(filePath),
    relative: (from: string, to: string) => path.relative(from, to)
  }
}


/**
 * 使用项目 tree-sitter 逻辑的文件切块工具类
 */
export class FileChunker {
  private readonly defaultOptions: Required<FileChunkerOptions> = {
    minChunkChars: MIN_BLOCK_CHARS,
    maxChunkChars: MAX_BLOCK_CHARS,
    minChunkRemainderChars: MIN_CHUNK_REMAINDER_CHARS,
    maxCharsToleranceFactor: MAX_CHARS_TOLERANCE_FACTOR,
    chunkType: 'chunk',
    skipEmptyChunks: true,
    lineOverlap: 0
  }

  constructor(private options: FileChunkerOptions = {}) {
    this.options = { ...this.defaultOptions, ...options }
  }

  /**
   * 对单个文件进行切块
   * @param filePath 文件路径
   * @param options 可选的覆盖选项
   * @returns 切块结果
   */
  async chunkFile(filePath: string, options?: FileChunkerOptions): Promise<ChunkResult> {
    const startTime = Date.now()
    const finalOptions = { ...this.options, ...options }

    try {
      // 读取文件内容
      const fileContent = await readFile(filePath, 'utf-8')
      const fileStats = await stat(filePath)

      // 计算文件哈希
      const fileHash = createHash('sha256').update(fileContent).digest('hex')

      // 使用项目的 CodeParser 进行切块
      const parser = new CodeParser()
      const codeBlocks = await parser.parseFile(filePath)

      // 将 CodeBlock 转换为 FileChunk 格式
      const chunks: FileChunk[] = codeBlocks.map(block => ({
        filePath: block.file_path,
        identifier: block.identifier,
        type: block.type,
        startLine: block.start_line,
        endLine: block.end_line,
        content: block.content,
        segmentHash: block.segmentHash,
        fileHash: block.fileHash,
        chunkSource: block.chunkSource as any,
        parentChain: block.parentChain.map(p => ({
          identifier: p.identifier,
          type: p.type
        })),
        hierarchyDisplay: block.hierarchyDisplay,
        size: block.content.length
      }))

      const processingTime = Date.now() - startTime

      // 确定策略
      let strategy: 'tree-sitter' | 'fallback' | 'markdown' = 'tree-sitter'
      if (chunks.length > 0 && chunks[0].chunkSource === 'fallback') {
        strategy = 'fallback'
      } else if (chunks.length > 0 && chunks[0].chunkSource === 'markdown') {
        strategy = 'markdown'
      }

      return {
        filePath,
        fileSize: fileStats.size,
        fileHash,
        chunks,
        processingTime,
        strategy
      }
    } catch (error) {
      throw new Error(`Failed to chunk file ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 批量处理多个文件
   * @param filePaths 文件路径列表
   * @param options 可选的覆盖选项
   * @returns 切块结果列表
   */
  async chunkFiles(filePaths: string[], options?: FileChunkerOptions): Promise<ChunkResult[]> {
    const results: ChunkResult[] = []

    for (const filePath of filePaths) {
      try {
        const result = await this.chunkFile(filePath, options)
        results.push(result)
      } catch (error) {
        console.error(`Error processing file ${filePath}:`, error)
        // 可以选择跳过错误文件或抛出异常
      }
    }

    return results
  }

  /**
   * 检查文件是否支持切块
   * @param filePath 文件路径
   * @returns 是否支持
   */
  isFileSupported(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    return scannerExtensions.includes(ext)
  }

  /**
   * 获取支持的文件扩展名列表
   * @returns 扩展名列表
   */
  getSupportedExtensions(): string[] {
    return scannerExtensions
  }
}

/**
 * 便捷函数：快速切分单个文件
 * @param filePath 文件路径
 * @param options 切块选项
 * @returns 切块结果
 */
export async function chunkFile(filePath: string, options?: FileChunkerOptions): Promise<ChunkResult> {
  const chunker = new FileChunker(options)
  return chunker.chunkFile(filePath)
}

/**
 * 便捷函数：快速切分多个文件
 * @param filePaths 文件路径列表
 * @param options 切块选项
 * @returns 切块结果列表
 */
export async function chunkFiles(filePaths: string[], options?: FileChunkerOptions): Promise<ChunkResult[]> {
  const chunker = new FileChunker(options)
  return chunker.chunkFiles(filePaths)
}
