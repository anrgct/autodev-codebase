const resolve = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');
const typescript = require('@rollup/plugin-typescript');
const json = require('@rollup/plugin-json');
const fs = require('fs')
const path = require('path')


function copyFilesPlugin() {
  return {
    name: 'copy-files-plugin',
    buildStart() {
      const srcDir = __dirname
      const nodeModulesDir = path.join(srcDir, "node_modules")
      const distDir = path.join(srcDir, "src/tree-sitter")

      console.log(`[copyWasms] Copying WASM files to ${distDir}`)

      // Copy language-specific WASM files.
      const languageWasmDir = path.join(nodeModulesDir, "tree-sitter-wasms", "out")

      if (!fs.existsSync(languageWasmDir)) {
          throw new Error(`Directory does not exist: ${languageWasmDir}`)
      }

      // Dynamically read all WASM files from the directory
      const wasmFiles = fs.readdirSync(languageWasmDir).filter((file) => file.endsWith(".wasm"))

      wasmFiles.forEach((filename) => {
          const srcPath = path.join(languageWasmDir, filename)
          const destPath = path.join(distDir, filename)
          fs.copyFileSync(srcPath, destPath)
      })

      console.log(`[copyWasms] Successfully copied ${wasmFiles.length} tree-sitter language WASMs to ${distDir}`)
    },
    generateBundle() {
      // Copy yoga.wasm from Ink dependencies to dist
      const srcDir = __dirname
      const nodeModulesDir = path.join(srcDir, "node_modules")
      const distDir = path.join(srcDir, "dist")

      // Ensure dist directory exists
      if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true })
      }

      // Find yoga.wasm in Ink's dependencies
      const yogaWasmPath = path.join(nodeModulesDir, "yoga-wasm-web", "dist", "yoga.wasm")
      if (fs.existsSync(yogaWasmPath)) {
        const destPath = path.join(distDir, "yoga.wasm")
        fs.copyFileSync(yogaWasmPath, destPath)
        console.log(`[copyWasms] Copied yoga.wasm to ${destPath}`)
      } else {
        console.warn(`[copyWasms] yoga.wasm not found at ${yogaWasmPath}`)
      }

      // Copy tree-sitter WASM files from src/tree-sitter to dist
      const treeSitterSrcDir = path.join(srcDir, "src", "tree-sitter")
      const treeSitterDistDir = path.join(distDir, "tree-sitter")

      if (fs.existsSync(treeSitterSrcDir)) {
        // Ensure tree-sitter directory exists in dist
        if (!fs.existsSync(treeSitterDistDir)) {
          fs.mkdirSync(treeSitterDistDir, { recursive: true })
        }

        // Copy all WASM files
        const wasmFiles = fs.readdirSync(treeSitterSrcDir).filter(file => file.endsWith('.wasm'))
        wasmFiles.forEach(filename => {
          const srcPath = path.join(treeSitterSrcDir, filename)
          const destPath = path.join(treeSitterDistDir, filename)
          fs.copyFileSync(srcPath, destPath)
        })

        console.log(`[copyWasms] Copied ${wasmFiles.length} tree-sitter WASM files to ${treeSitterDistDir}`)
      } else {
        console.warn(`[copyWasms] tree-sitter source directory not found at ${treeSitterSrcDir}`)
      }

      // Copy core tree-sitter.wasm file from node_modules to dist root
      const coreWasmSrc = path.join(nodeModulesDir, "web-tree-sitter", "tree-sitter.wasm")
      if (fs.existsSync(coreWasmSrc)) {
        const coreWasmDest = path.join(distDir, "tree-sitter.wasm")
        fs.copyFileSync(coreWasmSrc, coreWasmDest)
        console.log(`[copyWasms] Copied core tree-sitter.wasm to ${coreWasmDest}`)
      } else {
        console.warn(`[copyWasms] Core tree-sitter.wasm not found at ${coreWasmSrc}`)
      }

    }
  };
}

module.exports = [
  // Main library build
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/index.js',
      format: 'esm',
      sourcemap: true,
      inlineDynamicImports: true,
    },
    external: (id) => {
      // Externalize vscode and its submodules
      if (id === 'vscode' || id.startsWith('vscode/')) {
        return true;
      }
      // Also externalize yoga-wasm-web to avoid bundling issues
      if (id.includes('yoga-wasm-web')) {
        return true;
      }
      // Externalize Node.js built-ins that shouldn't be bundled
      if (['fs', 'path', 'child_process', 'readline', 'crypto', 'os', 'stream', 'util'].includes(id)) {
        return true;
      }
      // Bundle everything else (including fzf, tslib, etc.)
      // 特别将 web-tree-sitter 设为外部依赖，避免 __dirname 问题
      if (id === 'web-tree-sitter' || id.includes('web-tree-sitter')) {
        return true;
      }
      return false;
    },
    plugins: [
      copyFilesPlugin(),
      json(),
      resolve({
        preferBuiltins: true,
      }),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.json',
        rootDir: './src',
        noEmitOnError: false,
      }),
    ],
  },
  // CLI build
  {
    input: 'src/cli.ts',
    output: {
      file: 'dist/cli.js',
      format: 'esm',
      sourcemap: true,
      inlineDynamicImports: true,
      banner: '#!/usr/bin/env node',
    },
    external: (id) => {
      // Externalize vscode and its submodules
      if (id === 'vscode' || id.startsWith('vscode/')) {
        return true;
      }

      // Externalize Node.js built-ins that shouldn't be bundled
      if (['fs', 'path', 'child_process', 'readline', 'crypto', 'os', 'stream', 'util'].includes(id)) {
        return true;
      }
      // Bundle everything else (including fzf, tslib, etc.)
      // 特别将 web-tree-sitter 设为外部依赖，避免 __dirname 问题
      if (id === 'web-tree-sitter' || id.includes('web-tree-sitter')) {
        return true;
      }
      return false;
    },
    plugins: [
      copyFilesPlugin(),
      json(),
      resolve({
        preferBuiltins: true,
      }),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.json',
        rootDir: './src',
        noEmitOnError: false,
      }),
    ],
  },
];
