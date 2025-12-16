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
 * 调试捕获详情的函数
 */
async function debugCaptures(filePath: string): Promise<void> {
	console.log(`\n调试捕获信息: ${filePath}`)
	
	try {
		// 模拟解析过程来获取捕获信息
		const fileContentArray = await fs.readFile(filePath, 'utf-8')
		const fileContent = fileContentArray
		const ext = path.extname(filePath).toLowerCase().slice(1)
		
		// 动态导入相关模块
		const { loadRequiredLanguageParsers } = await import('../tree-sitter/languageParser')
		const languageParsers = await loadRequiredLanguageParsers([filePath])
		
		const { parser, query } = languageParsers[ext] || {}
		if (!parser || !query) {
			console.log(`无法加载 ${ext} 解析器`)
			return
		}
		
		// 解析文件
		const tree = parser.parse(fileContent)
		const captures = query.captures(tree.rootNode)
		const lines = fileContent.split('\n')
		
		console.log(`\n找到 ${captures.length} 个捕获:`)
		console.log('-'.repeat(80))
		
		// 显示前20个捕获的详细信息
		captures.slice(0, 20).forEach((capture, index) => {
			const { node, name } = capture
			const startLine = node.startPosition.row
			const endLine = node.endPosition.row
			const lineCount = endLine - startLine + 1
			
			console.log(`${index + 1}. ${name}:`)
			console.log(`   行范围: ${startLine + 1}-${endLine + 1} (${lineCount} 行)`)
			console.log(`   内容: ${lines[startLine].trim().substring(0, 60)}...`)
			console.log(`   节点类型: ${node.type}`)
			if (node.parent) {
				console.log(`   父节点类型: ${node.parent.type}`)
				console.log(`   父节点范围: ${node.parent.startPosition.row + 1}-${node.parent.endPosition.row + 1}`)
			}
			console.log('')
		})
		
		if (captures.length > 20) {
			console.log(`... 还有 ${captures.length - 20} 个捕获`)
		}
		
	} catch (error) {
		console.error(`调试时发生错误: ${error}`)
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
	console.log('示例:')
	console.log('  npm run test-tree-sitter src/index.ts')
	console.log('  TEST_FILE_PATH=src/utils.ts npm run test-tree-sitter')
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
	
	// 运行调试（可选）
	if (process.argv.includes('--debug')) {
		await debugCaptures(filePath)
	}
}

// 运行主函数
main().catch((error) => {
	console.error('程序执行失败:', error)
	process.exit(1)
})
