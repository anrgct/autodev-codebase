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

    }
  };
}

module.exports = {
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
    // Externalize optional dependencies that should not be bundled
    if (id === 'react-devtools-core' || id.includes('react-devtools-core')) {
      return true;
    }
    // Externalize Node.js built-ins that shouldn't be bundled
    if (['fs', 'path', 'child_process', 'readline', 'crypto', 'os', 'stream', 'util'].includes(id)) {
      return true;
    }
    // Bundle everything else (including fzf, tslib, etc.)
    return false;
  },
  plugins: [
    copyFilesPlugin(),
    json(),
    resolve({
      preferBuiltins: true,
      ignoreMissing: ['react-devtools-core'],
    }),
    commonjs(),
    typescript({
      tsconfig: './tsconfig.cli.json',
      rootDir: './src',
      noEmitOnError: false,
    }),
  ],
};
