import { parseSourceCodeDefinitionsForFile } from '../tree-sitter'
import * as fs from 'fs/promises'
import * as path from 'path'

const mockDependencies = {
  fileSystem: {
    exists: async (filePath: string) => true,
    readFile: async (filePath: string) => {
      const content = await fs.readFile(filePath, 'utf-8')
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
 * 解析指定文件的代码定义
 * @param filePath - 要解析的文件路径
 */
async function parseFile(filePath: string): Promise<void> {
  console.log(`解析文件: ${filePath}`)

  try {
    const output = await parseSourceCodeDefinitionsForFile(filePath, mockDependencies as any)

    if (output) {
      console.log('\n解析结果:')
      console.log('='.repeat(50))
      console.log(output)
      console.log('='.repeat(50))
    } else {
      console.log('该文件不支持解析或没有找到代码定义')
    }
  } catch (error) {
    console.error(`解析文件时发生错误: ${error}`)
  }
}

/**
 * 输出 JSON 格式的捕获详情
 */
async function outputCapturesAsJson(filePath: string): Promise<void> {
  try {
    // 读取文件内容
    const fileContent = await fs.readFile(filePath, 'utf-8')
    const ext = path.extname(filePath).toLowerCase().slice(1)

    // 动态导入相关模块
    const { loadRequiredLanguageParsers } = await import('../tree-sitter/languageParser')
    const languageParsers = await loadRequiredLanguageParsers([filePath])

    const { parser, query } = languageParsers[ext] || {}
    if (!parser || !query) {
      console.log(JSON.stringify({
        error: `无法加载 ${ext} 解析器`,
        filePath,
        extension: ext
      }, null, 2))
      return
    }

    // 解析文件
    const tree = parser.parse(fileContent)
    const captures = query.captures(tree.rootNode)
    const lines = fileContent.split('\n')

    // 构建捕获数据的 JSON 结构
    const capturesData = captures.map((capture) => {
      const { node, name } = capture
      const startLine = node.startPosition.row
      const endLine = node.endPosition.row

      return {
        captureName: name,
        nodeType: node.type,
        startPosition: {
          row: startLine,
          column: node.startPosition.column
        },
        endPosition: {
          row: endLine,
          column: node.endPosition.column
        },
        text: node.text,
        lineRange: `${startLine + 1}-${endLine + 1}`,
        lineContent: lines[startLine]?.trim() || '',
        parentNode: node.parent ? {
          type: node.parent.type,
          startPosition: {
            row: node.parent.startPosition.row,
            column: node.parent.startPosition.column
          },
          endPosition: {
            row: node.parent.endPosition.row,
            column: node.parent.endPosition.column
          }
        } : null
      }
    })

    // 输出完整的 JSON
    console.log(JSON.stringify({
      filePath,
      extension: ext,
      totalCaptures: captures.length,
      captures: capturesData
    }, null, 2))

  } catch (error) {
    console.error(JSON.stringify({
      error: `处理文件时发生错误: ${error}`,
      filePath
    }, null, 2))
  }
}

/**
 * 从命令行参数或环境变量获取文件路径
 */
function getFilePath(): string {
  // 优先使用命令行参数
  const args = process.argv.slice(2)
  if (args.length > 0) {
    return args[0]
  }

  // 其次使用环境变量
  const envPath = process.env['TEST_FILE_PATH']
  if (envPath) {
    return envPath
  }

  // 最后使用默认值
  return 'demo/model.py'
}

/**
 * 显示使用说明
 */
function showUsage(): void {
  console.log('使用方法:')
  console.log('  npm run test-tree-sitter <文件路径>')
  console.log('  或者')
  console.log('  TEST_FILE_PATH=<文件路径> npm run test-tree-sitter')
  console.log('  或者')
  console.log('  直接运行，使用默认文件: demo/model.py')
  console.log('')
  console.log('选项:')
  console.log('  --json    输出原始 JSON 格式的捕获数据')
  console.log('  --help, -h  显示此帮助信息')
  console.log('')
  console.log('示例:')
  console.log('  npm run test-tree-sitter src/index.ts')
  console.log('  npm run test-tree-sitter src/index.ts --json')
  console.log('  TEST_FILE_PATH=src/utils.ts npm run test-tree-sitter --json')
}

// 主函数
async function main(): Promise<void> {
  const filePath = getFilePath()

  // 检查是否需要显示帮助信息
  if (filePath === '--help' || filePath === '-h') {
    showUsage()
    return
  }

  console.log(`开始解析文件: ${filePath}`)

  // 检查文件是否存在
  try {
    await fs.access(filePath)
  } catch (error) {
    console.error(`错误: 文件 "${filePath}" 不存在或无法访问`)
    console.log('')
    showUsage()
    process.exit(1)
  }

  await parseFile(filePath)

  // 运行 JSON 输出（可选）
  if (process.argv.includes('--json')) {
    console.log('\n')  // 添加空行分隔
    await outputCapturesAsJson(filePath)
  }
}

// 运行主函数
main().catch((error) => {
  console.error('程序执行失败:', error)
  process.exit(1)
})
