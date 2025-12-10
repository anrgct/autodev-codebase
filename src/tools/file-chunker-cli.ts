#!/usr/bin/env node

import { program } from 'commander'
import { FileChunker, chunkFile, chunkFiles } from './file-chunker'
import { writeFile, readFile } from 'fs/promises'
import { stat } from 'fs/promises'
import * as path from 'path'

interface CLIOptions {
  output?: string
  format?: 'json' | 'csv' | 'text'
  minChars?: number
  maxChars?: number
  minRemainder?: number
  tolerance?: number
  chunkType?: string
  skipEmpty?: boolean
  overlap?: number
  includeHeader?: boolean
  recursive?: boolean
  pattern?: string
  verbose?: boolean
}

/**
 * 格式化输出结果
 */
async function formatOutput(results: any[], format: string, outputPath?: string): Promise<void> {
  let output: string = ''

  switch (format) {
    case 'json':
      output = JSON.stringify(results, null, 2)
      break

    case 'csv':
      const headers = ['filePath', 'chunkIndex', 'startLine', 'endLine', 'size', 'type', 'chunkSource', 'identifier', 'content']
      const rows = results.flatMap(result => {
        const sortedChunks = [...result.chunks].sort((a: any, b: any) => a.startLine - b.startLine)
        return sortedChunks.map((chunk: any, index: number) => [
          result.filePath,
          index + 1,
          chunk.startLine,
          chunk.endLine,
          chunk.size,
          chunk.type,
          chunk.chunkSource,
          chunk.identifier || '',
          `"${chunk.content.replace(/"/g, '""')}"`
        ])
      })
      output = [headers, ...rows].map(row => row.join(',')).join('\n')
      break

    case 'text':
      output = results.map(result => {
        let text = `文件: ${result.filePath}\n`
        text += `大小: ${result.fileSize} 字节\n`
        text += `块数: ${result.chunks.length}\n`
        text += `策略: ${result.strategy}\n`
        text += `处理时间: ${result.processingTime}ms\n`
        text += '='.repeat(50) + '\n\n'
        
        // 按 startLine 排序后显示
        const sortedChunks = [...result.chunks].sort((a: any, b: any) => a.startLine - b.startLine)
        sortedChunks.forEach((chunk: any, index: number) => {
          text += `块 ${index + 1} (${chunk.startLine}-${chunk.endLine}, ${chunk.size} 字符)\n`
          text += `标识符: ${chunk.identifier || 'N/A'}\n`
          text += `类型: ${chunk.type}\n`
          text += `来源: ${chunk.chunkSource}\n`
          if (chunk.hierarchyDisplay) {
            text += `层级: ${chunk.hierarchyDisplay}\n`
          }
          text += '-'.repeat(30) + '\n'
          text += chunk.content + '\n\n'
        })
        
        return text
      }).join('\n' + '='.repeat(50) + '\n\n')
      break

    default:
      throw new Error(`不支持的输出格式: ${format}`)
  }

  if (outputPath) {
    await writeFile(outputPath, output, 'utf-8')
    console.log(`结果已保存到: ${outputPath}`)
  } else {
    console.log(output)
  }
}

/**
 * 查找文件
 */
async function findFiles(pattern: string, recursive: boolean = false): Promise<string[]> {
  // 这里可以实现文件查找逻辑
  // 简化实现，实际项目中可以使用 glob 或其他库
  return []
}

/**
 * 主程序
 */
async function main(): Promise<void> {
  program
    .name('file-chunker')
    .description('通用文件切块工具 - 将文件切分成适合embedding处理的小块')
    .version('1.0.0')

  program
    .command('chunk')
    .description('切分单个或多个文件')
    .argument('<files...>', '要切分的文件路径')
    .option('-o, --output <path>', '输出文件路径')
    .option('-f, --format <format>', '输出格式 (json|csv|text)', 'json')
    .option('--min-chars <number>', '最小块大小（字符数）', '50')
    .option('--max-chars <number>', '最大块大小（字符数）', '2000')
    .option('--min-remainder <number>', '最小剩余字符数', '20')
    .option('--tolerance <number>', '最大字符容错因子', '1.5')
    .option('--chunk-type <type>', '块类型标识', 'chunk')
    .option('--skip-empty', '跳过空块')
    .option('--overlap <number>', '行重叠数量', '0')
    .option('--no-header', '不包含头部信息')
    .option('-v, --verbose', '详细输出')
    .action(async (files: string[], options: CLIOptions) => {
      try {
        if (options.verbose) {
          console.log('开始处理文件:', files)
        }

        const chunkerOptions = {
          minChunkChars: options.minChars ? parseInt(options.minChars) : undefined,
          maxChunkChars: options.maxChars ? parseInt(options.maxChars) : undefined,
          minChunkRemainderChars: options.minRemainder ? parseInt(options.minRemainder) : undefined,
          maxCharsToleranceFactor: options.tolerance ? parseFloat(options.tolerance) : undefined,
          chunkType: options.chunkType,
          skipEmptyChunks: options.skipEmpty,
          lineOverlap: options.overlap ? parseInt(options.overlap) : undefined
        }

        const chunker = new FileChunker(chunkerOptions)
        const results = await chunker.chunkFiles(files)

        if (options.verbose) {
          console.log(`处理完成，共生成 ${results.reduce((sum, r) => sum + r.chunks.length, 0)} 个块`)
        }

        await formatOutput(results, options.format || 'json', options.output)

      } catch (error) {
        console.error('错误:', error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
    })

  program
    .command('find')
    .description('查找并切分文件')
    .argument('<pattern>', '文件模式（如 *.js, **/*.ts）')
    .option('-o, --output <path>', '输出文件路径')
    .option('-f, --format <format>', '输出格式 (json|csv|text)', 'json')
    .option('-r, --recursive', '递归搜索')
    .option('--min-chars <number>', '最小块大小（字符数）', '50')
    .option('--max-chars <number>', '最大块大小（字符数）', '2000')
    .option('--min-remainder <number>', '最小剩余字符数', '20')
    .option('--tolerance <number>', '最大字符容错因子', '1.5')
    .option('--chunk-type <type>', '块类型标识', 'chunk')
    .option('--skip-empty', '跳过空块')
    .option('--overlap <number>', '行重叠数量', '0')
    .option('--no-header', '不包含头部信息')
    .option('-v, --verbose', '详细输出')
    .action(async (pattern: string, options: CLIOptions) => {
      try {
        if (options.verbose) {
          console.log('搜索文件:', pattern)
        }

        const files = await findFiles(pattern, options.recursive || false)

        if (files.length === 0) {
          console.log('未找到匹配的文件')
          return
        }

        if (options.verbose) {
          console.log(`找到 ${files.length} 个文件`)
        }

        const chunkerOptions = {
          minChunkChars: options.minChars ? parseInt(options.minChars) : undefined,
          maxChunkChars: options.maxChars ? parseInt(options.maxChars) : undefined,
          minChunkRemainderChars: options.minRemainder ? parseInt(options.minRemainder) : undefined,
          maxCharsToleranceFactor: options.tolerance ? parseFloat(options.tolerance) : undefined,
          chunkType: options.chunkType,
          skipEmptyChunks: options.skipEmpty,
          lineOverlap: options.overlap ? parseInt(options.overlap) : undefined
        }

        const chunker = new FileChunker(chunkerOptions)
        const results = await chunker.chunkFiles(files)

        if (options.verbose) {
          console.log(`处理完成，共生成 ${results.reduce((sum, r) => sum + r.chunks.length, 0)} 个块`)
        }

        await formatOutput(results, options.format || 'json', options.output)

      } catch (error) {
        console.error('错误:', error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
    })

  program
    .command('info')
    .description('显示文件信息而不进行切块')
    .argument('<file>', '文件路径')
    .option('-v, --verbose', '详细输出')
    .action(async (file: string, options: CLIOptions) => {
      try {
        const { stat } = await import('fs')
        const stats = await stat(file)
        const content = await readFile(file, 'utf-8')
        
        console.log(`文件: ${file}`)
        console.log(`大小: ${stats.size} 字节`)
        console.log(`行数: ${content.split('\n').length}`)
        console.log(`字符数: ${content.length}`)
        console.log(`扩展名: ${path.extname(file)}`)
        
        const chunker = new FileChunker()
        console.log(`支持切块: ${chunker.isFileSupported(file) ? '是' : '否'}`)
        
        if (options.verbose) {
          const strategy = (chunker as any).selectStrategy(file, content.length)
          console.log(`推荐策略: ${strategy}`)
        }

      } catch (error) {
        console.error('错误:', error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
    })

  program
    .command('list-ext')
    .description('列出支持的文件扩展名')
    .action(() => {
      const chunker = new FileChunker()
      const extensions = chunker.getSupportedExtensions()
      
      console.log('支持的文件扩展名:')
      extensions.sort().forEach(ext => {
        console.log(`  ${ext}`)
      })
      console.log(`\n总计: ${extensions.length} 种扩展名`)
    })

  program.parse()
}

// 运行主程序
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('程序执行失败:', error)
    process.exit(1)
  })
}

export { main }