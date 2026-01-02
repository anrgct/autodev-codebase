import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CodeParser } from '../../processors/parser'
import { IFileSystem } from '../../../abstractions/core'
import { IWorkspace, IPathUtils } from '../../../abstractions/workspace'

// Mock dependencies
const mockFileSystem: IFileSystem = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  exists: vi.fn(() => Promise.resolve(true)),
  stat: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  delete: vi.fn(),
}

const mockWorkspace: IWorkspace = {
  getRootPath: vi.fn(() => '/test'),
  getRelativePath: vi.fn(),
  findFiles: vi.fn(),
  getWorkspaceFolders: vi.fn(),
  isWorkspaceFile: vi.fn(),
  getIgnoreRules: vi.fn().mockReturnValue([]),
  shouldIgnore: vi.fn().mockResolvedValue(false),
  getName: vi.fn().mockReturnValue('test'),
  getGlobIgnorePatterns: vi.fn().mockResolvedValue([]),
} as IWorkspace

const mockPathUtils: IPathUtils = {
  basename: vi.fn((path: string) => path.split('/').pop() || ''),
  dirname: vi.fn((path: string) => path.split('/').slice(0, -1).join('/')),
  extname: vi.fn((path: string) => '.' + path.split('.').pop()),
  join: vi.fn((...paths: string[]) => paths.join('/')),
  resolve: vi.fn((...paths: string[]) => paths.join('/')),
  relative: vi.fn((from: string, to: string) => to),
  normalize: vi.fn((path: string) => path),
  isAbsolute: vi.fn((path: string) => path.startsWith('/')),
} as IPathUtils

describe('CodeParser', () => {
  let parser: CodeParser

  beforeEach(() => {
    parser = new CodeParser()
    vi.clearAllMocks()
  })

  const findHeaderBlock = (
    blocks: any[],
    type: string,
    identifier: string
  ) => blocks.find(block => block.type === type && block.identifier === identifier)

  describe('Markdown parentChain building', () => {
    it('should build correct parentChain for nested headers', async () => {
      const markdownContent = `# 项目概述

这是项目的基本介绍。本项目是一个现代化的全栈应用程序，采用了最新的技术栈和最佳实践。项目的主要目标是提供一个高性能、可扩展的用户管理系统。

项目的核心功能包括用户认证、数据管理、实时通信和数据分析。系统支持多种客户端，包括Web应用、移动应用和桌面应用。

在开发过程中，我们特别注重代码质量、测试覆盖率和系统安全性。通过使用持续集成和持续部署（CI/CD）流程，确保代码的快速迭代和稳定交付。

## 技术架构

这里描述技术架构。系统采用微服务架构，每个服务都有明确的职责边界。服务之间通过RESTful API和消息队列进行通信。

前端使用现代化的单页应用架构，后端采用云原生设计。数据库选择了分布式SQL数据库，确保数据的一致性和高可用性。

系统的监控和日志系统采用集中式管理，便于问题定位和性能优化。安全性方面实现了多层防护，包括网络层、应用层和数据层的全面保护。

### 前端架构

前端使用React框架。采用TypeScript进行类型安全的开发，使用Redux进行状态管理。组件库选择了Ant Design，提供了丰富的UI组件。

前端构建工具使用Webpack和Vite，实现了快速的热重载和优化打包。代码分割和懒加载技术确保了应用的快速启动。

移动端使用React Native开发，实现了跨平台兼容。PWA技术让Web应用具备了原生应用的体验。

### 后端架构

后端使用Node.js。框架选择了Express.js，配合TypeScript进行开发。数据库ORM使用Prisma，提供了类型安全的数据库操作。

微服务架构使用Docker容器化部署，通过Kubernetes进行编排。API网关使用Kong，实现了路由、认证和限流等功能。

消息队列使用RabbitMQ，处理异步任务和事件驱动架构。缓存层使用Redis，提高了系统的响应速度。

## 部署方案

部署使用Docker。所有服务都容器化，支持快速部署和扩展。CI/CD流程使用GitHub Actions，实现了自动化测试和部署。

监控使用Prometheus和Grafana，日志系统使用ELK Stack。告警机制确保问题能够及时发现和处理。

备份策略采用多重备份，确保数据安全。灾备方案支持快速恢复，保证业务连续性。`

      // Parse the markdown file
      const result = await parser.parseFile('/test/README.md', {
        content: markdownContent,
        fileHash: 'test-hash'
      })

      // Verify we have blocks
      expect(result).toBeDefined()
      expect(result.length).toBeGreaterThan(0)

      // Check that we have proper parentChain and hierarchyDisplay
      const h1Block = findHeaderBlock(result, 'markdown_header_h1', '项目概述')
      expect(h1Block?.parentChain).toEqual([])
      expect(h1Block?.hierarchyDisplay).toBe('header_1 项目概述')

      const h2Block = findHeaderBlock(result, 'markdown_header_h2', '技术架构')
      expect(h2Block?.parentChain).toEqual([
        { identifier: '项目概述', type: 'header_1' }
      ])
      expect(h2Block?.hierarchyDisplay).toBe('header_1 项目概述 > header_2 技术架构')

      const h3FrontendBlock = findHeaderBlock(result, 'markdown_header_h3', '前端架构')
      expect(h3FrontendBlock?.parentChain).toEqual([
        { identifier: '项目概述', type: 'header_1' },
        { identifier: '技术架构', type: 'header_2' }
      ])
      expect(h3FrontendBlock?.hierarchyDisplay).toBe('header_1 项目概述 > header_2 技术架构 > header_3 前端架构')

      const h3BackendBlock = findHeaderBlock(result, 'markdown_header_h3', '后端架构')
      expect(h3BackendBlock?.parentChain).toEqual([
        { identifier: '项目概述', type: 'header_1' },
        { identifier: '技术架构', type: 'header_2' }
      ])
      expect(h3BackendBlock?.hierarchyDisplay).toBe('header_1 项目概述 > header_2 技术架构 > header_3 后端架构')

      const h2DeployBlock = findHeaderBlock(result, 'markdown_header_h2', '部署方案')
      expect(h2DeployBlock?.parentChain).toEqual([
        { identifier: '项目概述', type: 'header_1' }
      ])
      expect(h2DeployBlock?.hierarchyDisplay).toBe('header_1 项目概述 > header_2 部署方案')
    })

    it('should handle complex header nesting correctly', async () => {
      const markdownContent = `# Main Section
# Main Section

这是主章节的内容。主章节包含了整个文档的核心概念和基本结构。在这里我们将介绍系统的整体架构和设计理念。

主章节的内容非常丰富，涵盖了系统的各个重要方面。我们将从宏观的角度来理解整个系统的设计思路和实现方法。

## Sub Section 1

子章节1的内容详细阐述了主章节中的具体实现细节。这里包含了大量的技术说明和代码示例，帮助开发者更好地理解系统的工作原理。

在这个子章节中，我们将深入探讨系统的各个组件，以及它们之间是如何协同工作的。每个组件都有其特定的职责和功能。

### Sub Sub Section 1

这是更深层次的内容，属于三级标题。这里的内容非常具体，包含了详细的实现步骤和最佳实践。我们将通过实际的代码示例来展示如何实现特定的功能。

这个子子章节的重点是实际应用，包含了大量的代码片段和配置示例。每个示例都经过精心设计，确保读者能够快速上手。

#### Deep Section

这是最深层次的内容，属于四级标题。这里的内容非常技术性，面向有经验的开发者。我们将深入探讨系统的高级特性和优化技巧。

在这个深度章节中，我们将讨论性能优化、安全加固、错误处理等高级主题。每个主题都有详细的说明和实际的解决方案。

### Sub Sub Section 2

这是另一个三级标题的内容，与前面的内容相关但侧重点不同。这里我们将讨论系统的其他重要方面，包括测试、文档和部署等内容。

测试策略包括单元测试、集成测试和端到端测试。文档编写遵循最佳实践，确保内容清晰易懂。

## Sub Section 2

这是第二个子章节，包含了系统的其他重要组成部分。这里的内容与前面的内容相辅相成，共同构成了完整的系统文档。

在这个子章节中，我们将讨论系统的可扩展性、可维护性和可测试性。这些质量属性对于系统的长期发展至关重要。

### Another Sub Sub Section

这是最后一个子子章节，总结了整个文档的重要内容。我们将回顾前面讨论的所有概念，并提供一些额外的资源和参考资料。

这里还包含了一些常见问题的解答，以及系统使用的最佳实践建议。开发者可以根据这些建议来优化自己的工作流程。`

      // Parse the markdown file
      const result = await parser.parseFile('/test/complex.md', {
        content: markdownContent,
        fileHash: 'test-hash'
      })

      // Find the deep section
      const deepSection = result.find(block =>
        block.type === 'markdown_header_h4' &&
        block.identifier === 'Deep Section'
      )

      expect(deepSection?.parentChain).toEqual([
        { identifier: 'Main Section', type: 'header_1' },
        { identifier: 'Sub Section 1', type: 'header_2' },
        { identifier: 'Sub Sub Section 1', type: 'header_3' }
      ])

      expect(deepSection?.hierarchyDisplay).toBe(
        'header_1 Main Section > header_2 Sub Section 1 > header_3 Sub Sub Section 1 > header_4 Deep Section'
      )

      // Find the second sub sub section
      const secondSubSub = result.find(block =>
        block.type === 'markdown_header_h3' &&
        block.identifier === 'Sub Sub Section 2'
      )

      expect(secondSubSub?.parentChain).toEqual([
        { identifier: 'Main Section', type: 'header_1' },
        { identifier: 'Sub Section 1', type: 'header_2' }
      ])

      expect(secondSubSub?.hierarchyDisplay).toBe(
        'header_1 Main Section > header_2 Sub Section 1 > header_3 Sub Sub Section 2'
      )
    })

    it('should handle headers at the same level correctly', async () => {
      const markdownContent = `# Chapter 1
# Chapter 1

这是第一章的内容。第一章介绍了项目的基本概念和背景信息。我们在这里讨论了项目的起源、目标和预期收益。

第一章还包含了项目的整体规划和时间线。通过详细的计划，我们能够确保项目按时完成并达到预期的质量标准。

项目团队成员的介绍也在第一章中，包括他们的职责和专长。这有助于读者了解项目的人力资源配置。

# Chapter 2

这是第二章的内容。第二章详细描述了技术架构的设计决策。我们选择了特定的技术栈，并解释了选择这些技术的原因。

第二章还包含了系统架构图和数据流图。这些图表帮助读者更好地理解系统的整体结构和组件之间的关系。

性能指标和基准测试结果也在第二章中展示。这些数据证明了我们的技术选择是合理的，系统能够满足性能要求。

# Chapter 3

这是第三章的内容。第三章重点关注系统的安全性和可扩展性。我们实施了多层安全策略，保护系统免受各种威胁。

第三章还讨论了系统的监控和运维策略。通过完善的监控体系，我们能够及时发现和解决系统中的问题。

最后，第三章还包含了未来发展的规划。我们将根据用户反馈和技术发展，持续改进系统的功能和性能。`

      // Parse the markdown file
      const result = await parser.parseFile('/test/chapters.md', {
        content: markdownContent,
        fileHash: 'test-hash'
      })

      // All chapters should have empty parentChain (they are all h1)
      const chapters = result.filter(block => block.type === 'markdown_header_h1')

      chapters.forEach(chapter => {
        expect(chapter.parentChain).toEqual([])
        expect(chapter.hierarchyDisplay).toBe(`header_1 ${chapter.identifier}`)
      })
    })

    it('should test markdown parser directly', async () => {
      const markdownContent = `# Header 1
## Header 2
### Header 3`

      // Test the parseMarkdown function directly
      const { parseMarkdown } = await import('../../../tree-sitter/markdownParser')
      const captures = parseMarkdown(markdownContent)
      expect(captures.length).toBeGreaterThan(0)
    })

    it('should handle markdown without headers', async () => {
      const markdownContent = `This is a simple markdown file
without any headers.
Just some plain text content.`

      // Parse the markdown file
      const result = await parser.parseFile('/test/simple.md', {
        content: markdownContent,
        fileHash: 'test-hash'
      })

      // Should have blocks but without header-specific info
      expect(result).toBeDefined()
      if (result.length > 0) {
        // The content should be processed as markdown_content type
        result.forEach(block => {
          expect(block.type).toBe('markdown_content')
          expect(block.parentChain).toEqual([])
          expect(block.hierarchyDisplay).toBe(null)
        })
      }
    })
  })
})
