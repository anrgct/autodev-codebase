import { CodeBlock } from "../interfaces"
import { generateRelativeFilePath } from "./get-relative-path"

/**
 * 生成用于向量嵌入的增强文本（包含上下文信息）
 *
 * 通过添加文件路径、类名、函数名等上下文信息，提高语义搜索的准确性
 *
 * @param block 代码块对象
 * @param workspaceRootPath 工作区根路径（用于转换为相对路径）
 * @param prefix 可选的文本前缀（如 "Document: "），用于 jina retrieval 等模型
 * @returns 增强后的文本（包含上下文和代码内容）
 */
export function generateBlockEmbeddingText(block: CodeBlock, workspaceRootPath: string, prefix?: string): string {
  const parts: string[] = []

  // 0. 可选的文档前缀（如 "Document: " for jina retrieval models）
  if (prefix) {
    parts.push(prefix)
  }

  // 1. 文件路径（转换为相对路径）
  const relativePath = generateRelativeFilePath(block.file_path, workspaceRootPath)
  parts.push(`File: ${relativePath}`)

  // 2. 函数/类名（如果有）
  if (block.identifier) {
    parts.push(`Name: [${block.type}]${block.identifier}`)
  }

  // 3. 父级容器（类名、命名空间等）
  if (block.parentChain?.length > 0) {
    const parents = block.parentChain
      .map(p => p.identifier ? `[${p.type}]${p.identifier}` : null)
      .filter(id => id)  // 过滤空值
      .join('.')
    if (parents) {
      parts.push(`Parent: ${parents}`)
    }
  }
  // 组合上下文和代码内容
  return `${parts.join('\n')}\n\n${block.content}`
}
