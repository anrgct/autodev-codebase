import { Project, SyntaxKind, Node } from 'ts-morph';

/**
 * 数据流节点
 */
interface DataFlowNode {
  id: string;
  file: string;
  line: number;
  type: 'function' | 'class' | 'method' | 'command';
  name: string;
  layer: string;
}

/**
 * 数据流边
 */
interface DataFlowEdge {
  from: string;
  to: string;
  type: 'calls' | 'creates' | 'implements';
  async?: boolean;
}

/**
 * 分析结果
 */
interface AnalysisResult {
  nodes: DataFlowNode[];
  edges: DataFlowEdge[];
  text: string;
  json: string;
}

/**
 * 数据流分析器 - MVP版本
 * 
 * 功能：
 * - 识别CLI和MCP入口点
 * - 追踪核心组件调用链
 * - 生成Mermaid流程图
 */
export class DataFlowAnalyzer {
  private project: Project;
  private nodes: Map<string, DataFlowNode> = new Map();
  private edges: DataFlowEdge[] = [];
  private visitedCalls = new Set<string>();
  private maxDepth = 15;

  constructor(projectPath: string) {
    this.project = new Project({
      tsConfigFilePath: `${projectPath}/tsconfig.json`,
      skipAddingFilesFromTsConfig: false,
    });
  }

  /**
   * 主分析入口
   */
  public analyze(): AnalysisResult {
    console.log('🔍 开始分析数据流...\n');

    // 1. 识别入口点
    this.analyzeCliMain();
    this.analyzeMcpServer();
    this.analyzePublicApi();

    // 2. 生成输出
    const result: AnalysisResult = {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
      text: this.generateTextTree(),
      json: JSON.stringify({ nodes: Array.from(this.nodes.values()), edges: this.edges }, null, 2),
    };

    console.log(`✓ 分析完成: ${result.nodes.length} 个节点, ${result.edges.length} 条边\n`);
    return result;
  }

  /**
   * 分析 CLI 主入口
   */
  private analyzeCliMain() {
    console.log('📂 分析 CLI 主入口...');
    const file = this.project.getSourceFile('src/cli.ts');
    if (!file) {
      console.warn('  ⚠️  src/cli.ts 未找到');
      return;
    }

    // 查找 main 函数
    const mainFunc = file.getFunction('main');
    if (!mainFunc) {
      console.warn('  ⚠️  main 函数未找到');
      return;
    }

    const mainId = this.addNode({
      id: 'cli:main',
      file: 'src/cli.ts',
      line: mainFunc.getStartLineNumber(),
      type: 'function',
      name: 'main',
      layer: 'cli',
    });

    console.log(`  ✓ 找到 main 函数 (行 ${mainFunc.getStartLineNumber()})`);

    // 递归分析调用链
    this.analyzeCallChain(mainFunc, mainId, 0);
  }

  /**
   * 分析 MCP 服务器入口
   */
  private analyzeMcpServer() {
    console.log('📂 分析 MCP 服务器入口...');

    // HTTP Server
    const httpFile = this.project.getSourceFile('src/mcp/http-server.ts');
    if (httpFile) {
      const startFunc = httpFile.getFunction('startServer') || 
                       httpFile.getClasses().find(c => c.getName() === 'MCPServer')?.getMethod('start');
      
      if (startFunc) {
        const id = this.addNode({
          id: 'mcp:http-server',
          file: 'src/mcp/http-server.ts',
          line: startFunc.getStartLineNumber(),
          type: 'function',
          name: 'startServer',
          layer: 'mcp',
        });
        console.log(`  ✓ 找到 HTTP Server (行 ${startFunc.getStartLineNumber()})`);
        this.analyzeCallChain(startFunc, id, 0);
      }
    }

    // Stdio Adapter
    const stdioFile = this.project.getSourceFile('src/mcp/stdio-adapter.ts');
    if (stdioFile) {
      const startFunc = stdioFile.getFunction('startStdioAdapter') ||
                       stdioFile.getFunction('main');
      
      if (startFunc) {
        const id = this.addNode({
          id: 'mcp:stdio-adapter',
          file: 'src/mcp/stdio-adapter.ts',
          line: startFunc.getStartLineNumber(),
          type: 'function',
          name: 'startStdioAdapter',
          layer: 'mcp',
        });
        console.log(`  ✓ 找到 Stdio Adapter (行 ${startFunc.getStartLineNumber()})`);
        this.analyzeCallChain(startFunc, id, 0);
      }
    }
  }

  /**
   * 分析公开 API
   */
  private analyzePublicApi() {
    console.log('📂 分析公开 API...');
    const file = this.project.getSourceFile('src/code-index/manager.ts');
    if (!file) {
      console.warn('  ⚠️  src/code-index/manager.ts 未找到');
      return;
    }

    const managerClass = file.getClass('CodeIndexManager');
    if (managerClass) {
      // 关键方法
      const keyMethods = ['initialize', 'startIndexing', 'searchIndex', 'clearIndexData'];
      for (const methodName of keyMethods) {
        const method = managerClass.getMethod(methodName);
        if (method) {
          const id = this.addNode({
            id: `manager:${methodName}`,
            file: 'src/code-index/manager.ts',
            line: method.getStartLineNumber(),
            type: 'method',
            name: `CodeIndexManager.${methodName}`,
            layer: 'manager',
          });
        }
      }
      console.log(`  ✓ 找到 CodeIndexManager 类`);
    }
  }

  /**
   * 递归分析调用链
   */
  private analyzeCallChain(node: Node, callerId: string, depth: number) {
    if (depth > this.maxDepth) {
      return;
    }

    const calls = node.getDescendantsOfKind(SyntaxKind.CallExpression);
    const indent = '  '.repeat(depth + 1);
    
    console.log(`${indent}[深度${depth}] 从 ${callerId} 找到 ${calls.length} 个调用`);
    
    for (const call of calls) {
      const callText = call.getExpression().getText();
      
      // 跳过内置方法
      if (this.isBuiltinCall(callText)) {
        continue;
      }

      // 只追踪重要调用
      if (this.isImportantCall(callText)) {
        console.log(`${indent}  ✓ 找到重要调用: ${callText}`);
        
        const callKey = `${callerId}:${callText}`;
        
        if (this.visitedCalls.has(callKey)) {
          console.log(`${indent}    └─ 已访问，跳过`);
          continue;
        }
        this.visitedCalls.add(callKey);

        const targetInfo = this.extractTarget(call, callText);
        if (targetInfo) {
          console.log(`${indent}    └─ 提取目标: ${targetInfo.id} (${targetInfo.type})`);
          
          // 添加边
          this.edges.push({
            from: callerId,
            to: targetInfo.id,
            type: targetInfo.type,
            async: this.isAsyncCall(call),
          });

          // 递归分析目标
          const targetNode = this.findTargetNode(targetInfo);
          if (targetNode && depth < this.maxDepth && typeof targetNode.getDescendantsOfKind === 'function') {
            this.analyzeCallChain(targetNode, targetInfo.id, depth + 1);
          } else if (!targetNode) {
            console.log(`${indent}      └─ 未找到目标节点`);
          }
        } else {
          console.log(`${indent}    └─ 无法提取目标信息`);
        }
      }
    }
  }

  /**
   * 判断是否为内置调用
   */
  private isBuiltinCall(callText: string): boolean {
    const builtins = [
      'console.', 'logger.', 'log(', 'info(', 'warn(', 'error(', 'debug(',
      'Array.', 'Object.', 'String.', 'Number.', 'Math.',
      'fs.', 'path.', 'process.', 'Buffer.',
      '.map(', '.filter(', '.forEach(', '.reduce(', '.find(',
      '.push(', '.pop(', '.shift(', '.unshift(',
      'JSON.', 'Promise.', 'async ',
    ];
    return builtins.some(b => callText.startsWith(b)) || callText.includes('.');
  }

  /**
   * 判断是否为重要调用
   */
  private isImportantCall(callText: string): boolean {
    const patterns = [
      // 工厂方法
      /create[A-Z]\w+/,
      /getInstance/,
      /getOrCreate/,
      
      // 核心组件
      /CodeIndexManager/,
      /Orchestrator/,
      /Scanner\b/,
      /Parser/,
      /Embedder/,
      /VectorStore/,
      /SearchService/,
      /ConfigManager/,
      /StateManager/,
      /CacheManager/,
      /BatchProcessor/,
      /FileWatcher/,
      
      // 关键操作
      /initialize/,
      /startIndexing/,
      /searchIndex/,
      /clearIndex/,
      /scanDirectory/,
      /parseFiles/,
      /processBatch/,
      
      // MCP 相关
      /registerTool/,
      /handleRequest/,
      
      // CLI 命令处理函数
      /startMCPServer/,
      /startStdioAdapter/,
      /indexCodebase/,
      /searchIndex/,
      /clearIndex/,
      /handleOutlineCommand/,
    ];

    return patterns.some(p => p.test(callText));
  }

  /**
   * 提取目标信息
   */
  private extractTarget(call: Node, callText: string): { id: string; type: 'calls' | 'creates' | 'implements' } | null {
    // 工厂方法
    if (callText.match(/create[A-Z]\w+/) || callText.includes('getInstance')) {
      const className = callText.match(/create([A-Z]\w+)/)?.[1] || 
                       callText.match(/(\w+)\.getInstance/)?.[1];
      if (className) {
        return {
          id: `factory:${className}`,
          type: 'creates',
        };
      }
    }

    // 方法调用: ClassName.methodName 或 obj.methodName
    const methodMatch = callText.match(/(\w+)\.(\w+)/);
    if (methodMatch) {
      const [, objName, methodName] = methodMatch;
      
      // 识别关键对象
      const keyObjects = [
        'manager', 'orchestrator', 'scanner', 'parser', 
        'embedder', 'vectorStore', 'searchService', 'configManager',
        'stateManager', 'cacheManager', 'batcher'
      ];
      
      if (keyObjects.includes(objName) || methodName === 'initialize' || methodName === 'startIndexing') {
        return {
          id: `${objName}:${methodName}`,
          type: 'calls',
        };
      }
    }

    // 直接函数调用（非对象方法）
    const directCallMatch = callText.match(/^([a-zA-Z][a-zA-Z0-9]+)/);
    if (directCallMatch) {
      const funcName = directCallMatch[1];
      // 识别重要的直接函数调用
      const importantFunctions = [
        'startMCPServer', 'startStdioAdapter', 'indexCodebase', 
        'searchIndex', 'clearIndex', 'handleOutlineCommand',
        'initializeManager', 'CodeIndexManager'
      ];
      if (importantFunctions.some(f => callText.startsWith(f))) {
        return {
          id: `cli:${funcName}`,
          type: 'calls',
        };
      }
    }

    return null;
  }

  /**
   * 查找目标节点
   */
  private findTargetNode(targetInfo: { id: string; type: string }): Node | null {
    // 如果节点已经存在，返回 null 表示不继续追踪
    if (this.nodes.has(targetInfo.id)) {
      return null;
    }

    const parts = targetInfo.id.split(':');
    const prefix = parts[0];
    const name = parts[1] || '';
    
    // 处理 CLI 函数（定义在 cli.ts 中的函数）
    if (prefix === 'cli' || prefix === 'func') {
      const cliFile = this.project.getSourceFile('src/cli.ts');
      if (cliFile) {
        // 查找函数
        const func = cliFile.getFunction(name);
        if (func) {
          this.addNode({
            id: targetInfo.id,
            file: 'src/cli.ts',
            line: func.getStartLineNumber(),
            type: 'function',
            name: name,
            layer: 'cli',
          });
          return func;
        }
      }
    }
    
    // 处理工厂创建的类
    if (prefix === 'factory') {
      const className = name;
      const possiblePaths = [
        `src/cli.ts`,  // 先检查 cli.ts，很多工厂函数在这里
        `src/examples/create-sample-files.ts`,  // 特殊处理 createSampleFiles
        `src/code-index/${className.toLowerCase()}.ts`,
        `src/code-index/processors/${className.toLowerCase()}.ts`,
        `src/code-index/manager.ts`,
        `src/code-index/orchestrator.ts`,
        `src/adapters/nodejs/index.ts`,  // 工厂函数可能在这里
        `src/adapters/nodejs/`,           // 或者其他 adapter 文件
      ];

      for (const path of possiblePaths) {
        const file = this.project.getSourceFile(path);
        if (file) {
          // 先尝试找类
          const cls = file.getClass(className);
          if (cls) {
            this.addNode({
              id: targetInfo.id,
              file: path,
              line: cls.getStartLineNumber(),
              type: 'class',
              name: className,
              layer: this.identifyLayer(path),
            });
            return cls;
          }
          
          // 如果没找到类，尝试找函数（工厂函数）
          const func = file.getFunction(`create${className}`) || 
                      file.getFunction(className);
          if (func) {
            this.addNode({
              id: targetInfo.id,
              file: path,
              line: func.getStartLineNumber(),
              type: 'function',
              name: `create${className}`,
              layer: this.identifyLayer(path),
            });
            return func;
          }
          
          // 尝试查找导出的声明（包括默认导出）
          const exports = file.getExportedDeclarations();
          
          // 先尝试具名导出
          let exportFunc = exports.get(`create${className}`);
          if (exportFunc && Array.isArray(exportFunc) && exportFunc[0]) {
            const funcNode = exportFunc[0] as any;
            this.addNode({
              id: targetInfo.id,
              file: path,
              line: funcNode.getStartLineNumber(),
              type: 'function',
              name: `create${className}`,
              layer: this.identifyLayer(path),
            });
            return funcNode;
          }
          
          // 尝试默认导出
          const defaultExport = exports.get('default');
          if (defaultExport && Array.isArray(defaultExport) && defaultExport[0]) {
            const funcNode = defaultExport[0] as any;
            // 检查是否是函数并且名称匹配
            const funcName = funcNode.getName?.();
            if (funcName === `create${className}` || path.includes('create-sample-files')) {
              this.addNode({
                id: targetInfo.id,
                file: path,
                line: funcNode.getStartLineNumber(),
                type: 'function',
                name: `create${className}`,
                layer: this.identifyLayer(path),
              });
              return funcNode;
            }
          }
          
          // 如果是目录，列出其中的文件
          if (path.endsWith('/')) {
            const files = file.getDirectory().getSourceFiles();
            for (const subFile of files) {
              if (subFile.getFilePath().includes('nodejs')) {
                const subFunc = subFile.getFunction(`create${className}`) ||
                               subFile.getExportedDeclarations().get(`create${className}`);
                if (subFunc && Array.isArray(subFunc) && subFunc[0]) {
                  const funcNode = subFunc[0] as any;
                  this.addNode({
                    id: targetInfo.id,
                    file: subFile.getFilePath().replace(process.cwd() + '/', ''),
                    line: funcNode.getStartLineNumber(),
                    type: 'function',
                    name: `create${className}`,
                    layer: this.identifyLayer(subFile.getFilePath()),
                  });
                  return funcNode;
                }
              }
            }
          }
        }
      }
      
      // 如果实在找不到，至少创建一个占位节点
      this.addNode({
        id: targetInfo.id,
        file: 'unknown',
        line: 0,
        type: 'function',
        name: `create${className}`,
        layer: 'unknown',
      });
      return null;  // 返回 null 因为没有实际的 AST 节点
    }
    
    // 处理方法调用 (objName:methodName)
    if (!prefix && targetInfo.id.includes(':')) {
      const [objName, methodName] = targetInfo.id.split(':');
      
      // 尝试查找对应的类文件
      const possiblePaths = [
        `src/code-index/${objName.toLowerCase()}.ts`,
        `src/code-index/processors/${objName.toLowerCase()}.ts`,
        `src/code-index/manager.ts`,
        `src/code-index/orchestrator.ts`,
        `src/code-index/search-service.ts`,
        `src/code-index/config-manager.ts`,
      ];

      for (const path of possiblePaths) {
        const file = this.project.getSourceFile(path);
        if (file) {
          const cls = file.getClass(objName.charAt(0).toUpperCase() + objName.slice(1));
          if (!cls) continue;
          
          const method = cls.getMethod(methodName);
          if (method) {
            this.addNode({
              id: targetInfo.id,
              file: path,
              line: method.getStartLineNumber(),
              type: 'method',
              name: `${objName}.${methodName}`,
              layer: this.identifyLayer(path),
            });
            return method;
          }
        }
      }
    }

    return null;
  }

  /**
   * 识别层级
   */
  private identifyLayer(filePath: string): string {
    if (filePath.includes('cli.ts')) return 'cli';
    if (filePath.includes('mcp/')) return 'mcp';
    if (filePath.includes('manager.ts')) return 'manager';
    if (filePath.includes('orchestrator') || filePath.includes('service') || filePath.includes('config-manager')) return 'service';
    if (filePath.includes('processors/')) return 'processor';
    if (filePath.includes('adapters/')) return 'adapter';
    return 'unknown';
  }

  /**
   * 判断是否为异步调用
   */
  private isAsyncCall(call: Node): boolean {
    let parent = call.getParent();
    while (parent) {
      if (parent.getKind() === SyntaxKind.AwaitExpression) {
        return true;
      }
      parent = parent.getParent();
    }
    return false;
  }

  /**
   * 添加节点
   */
  private addNode(node: DataFlowNode): string {
    if (!this.nodes.has(node.id)) {
      this.nodes.set(node.id, node);
    }
    return node.id;
  }

  /**
   * 生成文本树状格式
   */
  private generateTextTree(): string {
    let output = '';
    
    // 构建邻接表用于树状遍历（去重边）
    const edgeMap = new Map<string, DataFlowEdge>();
    for (const edge of this.edges) {
      const key = `${edge.from}->${edge.to}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, edge);
      }
    }
    
    // 构建邻接表
    const adjList = new Map<string, DataFlowEdge[]>();
    for (const edge of edgeMap.values()) {
      if (!adjList.has(edge.from)) {
        adjList.set(edge.from, []);
      }
      adjList.get(edge.from)!.push(edge);
    }
    
    // 找到所有根节点（没有入边的节点）
    const allTargets = new Set(this.edges.map(e => e.to));
    const roots = Array.from(this.nodes.keys()).filter(id => !allTargets.has(id));
    
    // 递归生成树
    const visited = new Set<string>();
    const generateBranch = (nodeId: string, isLast: boolean, prefix: string): void => {
      const node = this.nodes.get(nodeId);
      if (!node) return;
      
      // 打印当前节点
      const connector = isLast ? '└─' : '├─';
      const layerTag = node.layer !== 'unknown' ? `[${node.layer}]` : '';
      const location = `(${node.file}:${node.line})`;
      output += `${prefix}${connector} ${node.name} ${layerTag} ${location}\n`;
      
      // 标记为已访问
      visited.add(nodeId);
      
      // 获取子节点
      const children = adjList.get(nodeId) || [];
      if (children.length === 0) return;
      
      // 排序子节点
      children.sort((a, b) => a.to.localeCompare(b.to));
      
      // 生成子节点
      const newPrefix = prefix + (isLast ? '  ' : '│ ');
      for (let i = 0; i < children.length; i++) {
        const edge = children[i];
        const isLastChild = i === children.length - 1;
        
        // 打印边（只显示调用类型）
        const asyncMark = edge.async ? ' (async)' : '';
        output += `${newPrefix}${isLastChild ? '└─' : '├─'} ${edge.type}${asyncMark}\n`;
        
        // 递归处理子节点（如果还没访问过）
        if (!visited.has(edge.to)) {
          generateBranch(edge.to, isLastChild, newPrefix + (isLastChild ? '  ' : '│ '));
        }
      }
    };
    
    // 从根节点开始生成
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      const isLast = i === roots.length - 1;
      
      if (!visited.has(root)) {
        generateBranch(root, isLast, '');
        output += '\n';
      }
    }
    
    return output;
  }
}

/**
 * CLI 命令包装器
 */
export function generateDataFlowDiagram(projectPath: string = process.cwd()): AnalysisResult {
  const analyzer = new DataFlowAnalyzer(projectPath);
  return analyzer.analyze();
}

// 如果直接运行此文件，显示文本树输出
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = generateDataFlowDiagram();
  console.log(`\n${'='.repeat(80)}\n`);
  console.log(result.text);
  console.log(`\n${'='.repeat(80)}`);
  console.log(`\n💡 提示: 文本树格式更清晰地展示了调用层次和深度\n`);
}