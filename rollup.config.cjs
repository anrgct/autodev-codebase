const resolve = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');
const typescript = require('@rollup/plugin-typescript');
const json = require('@rollup/plugin-json');
const replace = require('@rollup/plugin-replace');
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

      // Ensure tree-sitter directory exists
      if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true })
      }

      // Copy core tree-sitter.wasm to src/tree-sitter/
      const coreWasmSrc = path.join(nodeModulesDir, "web-tree-sitter", "tree-sitter.wasm")
      if (fs.existsSync(coreWasmSrc)) {
        const coreWasmDest = path.join(distDir, "tree-sitter.wasm")
        fs.copyFileSync(coreWasmSrc, coreWasmDest)
        console.log(`[copyWasms] Copied core tree-sitter.wasm to ${coreWasmDest}`)
      } else {
        console.warn(`[copyWasms] Core tree-sitter.wasm not found at ${coreWasmSrc}`)
      }

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
      const srcDir = __dirname
      const nodeModulesDir = path.join(srcDir, "node_modules")
      const distDir = path.join(srcDir, "dist")

      // Ensure dist directory exists
      if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true })
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

      // Copy core tree-sitter.wasm file from node_modules to dist/tree-sitter/
      const coreWasmSrc = path.join(nodeModulesDir, "web-tree-sitter", "tree-sitter.wasm")
      if (fs.existsSync(coreWasmSrc)) {
        const coreWasmDest = path.join(treeSitterDistDir, "tree-sitter.wasm")
        fs.copyFileSync(coreWasmSrc, coreWasmDest)
        console.log(`[copyWasms] Copied core tree-sitter.wasm to ${coreWasmDest}`)
      } else {
        console.warn(`[copyWasms] Core tree-sitter.wasm not found at ${coreWasmSrc}`)
      }

      // Copy static files to dist
      const staticSrcDir = path.join(srcDir, "static")
      const staticDistDir = path.join(distDir, "static")
      
      if (fs.existsSync(staticSrcDir)) {
        if (!fs.existsSync(staticDistDir)) {
          fs.mkdirSync(staticDistDir, { recursive: true })
        }
        
        // Copy all files from static directory
        const staticFiles = fs.readdirSync(staticSrcDir)
        staticFiles.forEach(filename => {
          const srcPath = path.join(staticSrcDir, filename)
          const destPath = path.join(staticDistDir, filename)
          
          if (fs.statSync(srcPath).isFile()) {
            fs.copyFileSync(srcPath, destPath)
          }
        })
        
        console.log(`[copyStatic] Copied ${staticFiles.filter(f => fs.statSync(path.join(staticSrcDir, f)).isFile()).length} static files to ${staticDistDir}`)
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
      intro: `
import { fileURLToPath as __fileURLToPath__ } from 'url';
import { dirname as __dirname__ } from 'path';
const __getScriptDir__ = () => __dirname__(__fileURLToPath__(import.meta.url));
`.trim(),
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
      // Externalize @realtimex/node-llama-cpp (native addon - must NOT be bundled)
      if (id === 'node-llama-cpp' || id.startsWith('node-llama-cpp/') ||
          id === '@realtimex/node-llama-cpp' || id.startsWith('@realtimex/node-llama-cpp/') ||
          id.startsWith('@node-llama-cpp/')) {
        return true;
      }
      // Bundle everything else (including web-tree-sitter, fzf, tslib, etc.)
      return false;
    },
    plugins: [
      copyFilesPlugin(),
      json(),
      replace({
        preventAssignment: true,
        delimiters: ['', ''],
        values: {
          'scriptDirectory = __dirname + "/"': 'scriptDirectory = __getScriptDir__() + "/tree-sitter/"',
        },
      }),
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
      intro: `
import { fileURLToPath as __fileURLToPath__ } from 'url';
import { dirname as __dirname__ } from 'path';
const __getScriptDir__ = () => __dirname__(__fileURLToPath__(import.meta.url));
`.trim(),
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
      // Externalize @realtimex/node-llama-cpp (native addon - must NOT be bundled)
      if (id === 'node-llama-cpp' || id.startsWith('node-llama-cpp/') ||
          id === '@realtimex/node-llama-cpp' || id.startsWith('@realtimex/node-llama-cpp/') ||
          id.startsWith('@node-llama-cpp/')) {
        return true;
      }
      // Bundle everything else (including web-tree-sitter, fzf, tslib, etc.)
      return false;
    },
    plugins: [
      copyFilesPlugin(),
      json(),
      replace({
        preventAssignment: true,
        delimiters: ['', ''],
        values: {
          'scriptDirectory = __dirname + "/"': 'scriptDirectory = __getScriptDir__() + "/tree-sitter/"',
        },
      }),
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
