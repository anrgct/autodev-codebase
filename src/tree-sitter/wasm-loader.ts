/**
 * 统一的 WASM 路径解析模块
 * 
 * 负责解析核心 tree-sitter.wasm 和语言特定 WASM 文件的路径。
 * 支持开发环境（src/tree-sitter/）和生产环境（dist/tree-sitter/）。
 */

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * 获取当前模块的基础路径
 * 使用同步方式以兼容 rollup 打包
 */
function getBasePath(): string {
  // 在打包后的环境中，import.meta.url 应该可用
  if (typeof import.meta !== 'undefined' && import.meta.url) {
    const currentFilePath = fileURLToPath(import.meta.url);
    return path.dirname(currentFilePath);
  }
  // 降级方案（不应该到达这里）
  throw new Error('Unable to determine base path: import.meta.url is not available');
}

/**
 * 检测是否为开发环境
 * @param basePath - 当前模块的基础路径
 */
function isDevelopment(basePath: string): boolean {
  // 开发环境：basePath 包含 '/src/' 或文件以 .ts 结尾
  // 生产环境：basePath 包含 '/dist/'
  return basePath.includes('/src/');
}

/**
 * 解析 WASM 文件路径（核心 + 语言通用）
 * 
 * @param filename - WASM 文件名（如 'tree-sitter.wasm' 或 'tree-sitter-javascript.wasm'）
 * @param customDir - 可选的自定义目录，用于测试场景覆盖默认路径
 * @returns WASM 文件的绝对路径
 * @throws {Error} 如果文件不存在
 * 
 * @example
 * // 自动环境检测
 * const wasmPath = resolveWasmPath('tree-sitter.wasm');
 * // 开发环境：/path/to/project/src/tree-sitter/tree-sitter.wasm
 * // 生产环境：/path/to/project/dist/tree-sitter/tree-sitter.wasm
 * 
 * @example
 * // 测试场景使用自定义目录
 * const testWasmPath = resolveWasmPath('tree-sitter-javascript.wasm', '/custom/test/dir');
 * // 结果：/custom/test/dir/tree-sitter-javascript.wasm
 */
export function resolveWasmPath(filename: string, customDir?: string): string {
  let wasmPath: string;

  // 支持自定义目录（测试场景）
  if (customDir) {
    wasmPath = path.join(customDir, filename);
  } else {
    const basePath = getBasePath();
    const isDev = isDevelopment(basePath);

    // 根据环境返回对应路径
    if (isDev) {
      // 开发环境：basePath = src/tree-sitter/，直接使用
      // src/tree-sitter/{filename}
      wasmPath = path.join(basePath, filename);
    } else {
      // 生产环境：basePath = dist/（cli.js 所在目录）
      // 需要访问 dist/tree-sitter/{filename}
      wasmPath = path.join(basePath, 'tree-sitter', filename);
    }
  }

  // 验证文件存在
  if (!fs.existsSync(wasmPath)) {
    const basePath = getBasePath();
    const isDev = isDevelopment(basePath);
    throw new Error(
      `Unable to find ${filename} at ${wasmPath}\n` +
      `Environment: ${isDev ? 'development' : 'production'}\n` +
      `Base path: ${basePath}\n` +
      `Custom dir: ${customDir || 'none'}`
    );
  }

  return wasmPath;
}

/**
 * 创建 Parser.init() 所需的 locateFile 函数
 * 
 * 该函数用于 web-tree-sitter 的 Parser.init() 调用，
 * 拦截 'tree-sitter.wasm' 的加载请求并返回正确的路径。
 * 
 * @returns locateFile 函数，用于 web-tree-sitter 的 Parser.init()
 * 
 * @example
 * import Parser from 'web-tree-sitter';
 * await Parser.init(createLocateFileFunction());
 */
export function createLocateFileFunction(): (scriptName: string, scriptDirectory: string) => string {
  const coreWasmPath = resolveWasmPath('tree-sitter.wasm');
  
  return (scriptName: string, scriptDirectory: string) => {
    // 拦截 tree-sitter.wasm 的加载请求
    if (scriptName === 'tree-sitter.wasm') {
      return coreWasmPath;
    }
    // 其他文件使用默认行为
    return scriptDirectory + scriptName;
  };
}
