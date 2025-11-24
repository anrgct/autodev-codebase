import { CodeIndexOllamaEmbedder } from '../code-index/embedders/ollama'
import { OpenAICompatibleEmbedder } from '../code-index/embedders/openai-compatible'
import { JinaEmbedder } from '../code-index/embedders/jina-embedder'
import { IEmbedder } from '../code-index/interfaces/embedder'
import { EmbedderConfig } from '../code-index/interfaces/config'
import { JinaEmbedderConfig } from '../code-index/interfaces/config'

export interface VectorDocument {
  id: string
  content: string
  vector: number[]
  metadata?: Record<string, any>
}

export class MemoryVectorSearch {
  private documents: VectorDocument[] = []
  private embedder: IEmbedder

  constructor(config?: EmbedderConfig, model?: string) {
    console.log('[memory-vector-search]', config)
    // 向后兼容：如果第一个参数是字符串，则使用旧的 Ollama 配置
    if (typeof config === 'string' || config === undefined) {
      const ollamaBaseUrl = config || 'http://localhost:11434'
      const ollamaModelId = model || 'nomic-embed-text'
      this.embedder = new CodeIndexOllamaEmbedder({
        ollamaBaseUrl,
        ollamaModelId: ollamaModelId
      })
    } else {
      // 新的配置对象方式
      if (config.provider === 'openai-compatible') {
        this.embedder = new OpenAICompatibleEmbedder(
          (config as any).baseUrl,
          (config as any).apiKey,
          config.model
        )
      } else if (config.provider === 'jina') {
        const jinaConfig = config as JinaEmbedderConfig
        this.embedder = new JinaEmbedder(
          jinaConfig.apiKey,
          jinaConfig.model
        )
      } else {
        // 默认使用 Ollama
        this.embedder = new CodeIndexOllamaEmbedder({
          ollamaBaseUrl: (config as any).baseUrl || 'http://localhost:11434',
          ollamaModelId: config.model || 'nomic-embed-text'
        })
      }
    }
  }

  /**
   * 计算两个向量的余弦相似度
   */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      throw new Error('Vectors must have the same length')
    }

    const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0)
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0))
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0))

    if (magnitudeA === 0 || magnitudeB === 0) {
      return 0
    }

    return dotProduct / (magnitudeA * magnitudeB)
  }

  /**
   * 添加文档到内存存储
   */
  async addDocument(id: string, content: string, metadata?: Record<string, any>): Promise<void> {
    const response = await this.embedder.createEmbeddings([content])
    const vector = response.embeddings[0]

    this.documents.push({
      id,
      content,
      vector,
      metadata
    })
  }

  /**
   * 批量添加文档
   */
  async addDocuments(docs: Array<{ id: string; content: string; metadata?: Record<string, any> }>): Promise<void> {
    try {
      console.log('📝 开始批量添加文档，数量:', docs.length)

      // 分批处理以避免超时和服务器负载过大
      const BATCH_SIZE = 10
      const batches = []
      for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        batches.push(docs.slice(i, i + BATCH_SIZE))
      }

      console.log(`📝 将分成 ${batches.length} 个批次处理，每批最多 ${BATCH_SIZE} 个文档`)

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex]
        console.log(`📝 处理批次 ${batchIndex + 1}/${batches.length}: ${batch.length} 个文档`)

        const contents = batch.map(doc => doc.content)
        console.log('📝 内容示例:', contents.slice(0, 3))

        console.log('📝 调用embedder.createEmbeddings...')
        console.log('📝 准备发送网络请求，等待响应...')

        // 添加超时控制，给分批处理更长的超时时间
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`批次 ${batchIndex + 1} 请求超时：等待嵌入服务响应超过60秒`)), 60000)
        })

        const embeddingPromise = this.embedder.createEmbeddings(contents)

        const response: any = await Promise.race([embeddingPromise, timeoutPromise])
        console.log('📝 嵌入向量创建成功，维度:', response.embeddings[0].length)
        console.log('📝 返回的嵌入向量数量:', response.embeddings.length)

        for (let i = 0; i < batch.length; i++) {
          this.documents.push({
            id: batch[i].id,
            content: batch[i].content,
            vector: response.embeddings[i],
            metadata: batch[i].metadata
          })
        }
        console.log(`📝 批次 ${batchIndex + 1} 添加成功`)
      }

      console.log('📝 所有文档添加成功')
    } catch (error: any) {
      console.error('❌ addDocuments 发生错误:')
      console.error('错误类型:', error?.constructor?.name || 'Unknown')
      console.error('错误消息:', error?.message || error)
      console.error('错误堆栈:', error?.stack || 'No stack trace')

      // 网络相关错误诊断
      if (error?.message?.includes('请求超时')) {
        console.error('🔍 网络诊断: 请求超时，可能的原因:')
        console.error('  1. 嵌入服务未启动或无响应')
        console.error('  2. 网络连接问题')
        console.error('  3. 代理配置问题')
        console.error('  4. 服务器负载过高')
        console.error('  💡 建议: 当前使用分批处理，如仍超时可进一步减小批次大小')
      } else if (error?.code === 'ECONNREFUSED') {
        console.error('🔍 网络诊断: 连接被拒绝')
        console.error('  - 请检查嵌入服务是否在 http://192.168.31.10:5000 运行')
        console.error('  - 请检查防火墙设置')
      } else if (error?.code === 'ENOTFOUND') {
        console.error('🔍 网络诊断: 主机未找到')
        console.error('  - 请检查IP地址���否正确')
        console.error('  - 请检查网络连接')
      } else if (error?.message?.includes('fetch')) {
        console.error('🔍 网络诊断: HTTP请求失败')
        console.error('  - 请检查服务URL和API密钥')
        console.error('  - 请检查服务是否支持该模型')
      }

      if (error?.cause) {
        console.error('根本原因:', error.cause)
      }

      throw error
    }
  }

  /**
   * 搜索相似文档
   */
  async search(query: string, topK = 5): Promise<Array<{ document: VectorDocument; score: number }>> {
    try {
      if (this.documents.length === 0) {
        console.log('📝 没有文档可搜索')
        return []
      }

      console.log('📝 开始搜索，查询:', query)
      // 获取查询向量
      const queryResponse = await this.embedder.createEmbeddings(["search_code: " + query])
      const queryVector = queryResponse.embeddings[0]
      console.log('📝 查询向量维度:', queryVector.length)

      // 计算所有文档的相似度
      const scores = this.documents.map(doc => ({
        document: doc,
        score: this.cosineSimilarity(queryVector, doc.vector)
      }))

      // 按相似度排序并返回前K个
      const results = scores
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)

      console.log('📝 搜索完成，返回结果数量:', results.length)
      return results
    } catch (error: any) {
      console.error('❌ search 发生错误:')
      console.error('错误类型:', error?.constructor?.name || 'Unknown')
      console.error('错误消息:', error?.message || error)
      console.error('错误堆栈:', error?.stack || 'No stack trace')

      throw error
    }
  }

  /**
   * 获取存储的文档数量
   */
  getDocumentCount(): number {
    return this.documents.length
  }

  /**
   * 清空所有文档
   */
  clear(): void {
    this.documents = []
  }

  /**
   * 根据ID获取文档
   */
  getDocument(id: string): VectorDocument | undefined {
    return this.documents.find(doc => doc.id === id)
  }

  /**
   * 获取所有文档
   */
  getAllDocuments(): VectorDocument[] {
    return [...this.documents]
  }
}
