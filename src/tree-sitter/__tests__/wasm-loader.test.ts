import { describe, it, expect, beforeAll } from 'vitest';
import { resolveWasmPath, createLocateFileFunction } from '../wasm-loader';
import * as fs from 'fs';
import * as path from 'path';

describe('wasm-loader', () => {
  beforeAll(async () => {
    // Ensure WASM files exist (after build)
    const coreWasmPath = path.join(process.cwd(), 'dist/tree-sitter/tree-sitter.wasm');
    if (!fs.existsSync(coreWasmPath)) {
      throw new Error(`Core WASM not found at ${coreWasmPath}. Run 'npm run build' first.`);
    }
  });

  describe('resolveWasmPath', () => {
    it('should resolve core WASM path', () => {
      const wasmPath = resolveWasmPath('tree-sitter.wasm');
      
      expect(wasmPath).toBeTruthy();
      expect(wasmPath).toMatch(/tree-sitter\/tree-sitter\.wasm$/);
      expect(fs.existsSync(wasmPath)).toBe(true);
    });

    it('should resolve language WASM path', () => {
      const wasmPath = resolveWasmPath('tree-sitter-javascript.wasm');
      
      expect(wasmPath).toBeTruthy();
      expect(wasmPath).toMatch(/tree-sitter\/tree-sitter-javascript\.wasm$/);
      expect(fs.existsSync(wasmPath)).toBe(true);
    });

    it('should support custom directory (test scenario)', () => {
      // Use the actual existing dist/tree-sitter directory as custom directory
      const customDir = path.join(process.cwd(), 'dist/tree-sitter');
      const wasmPath = resolveWasmPath('tree-sitter.wasm', customDir);
      
      expect(wasmPath).toBe(path.join(customDir, 'tree-sitter.wasm'));
      expect(fs.existsSync(wasmPath)).toBe(true);
    });

    it('should keep core and language WASM in the same directory', () => {
      const coreWasmPath = resolveWasmPath('tree-sitter.wasm');
      const langWasmPath = resolveWasmPath('tree-sitter-javascript.wasm');
      
      const coreDir = path.dirname(coreWasmPath);
      const langDir = path.dirname(langWasmPath);
      
      expect(coreDir).toBe(langDir);
      expect(coreDir).toMatch(/tree-sitter$/);
    });

    it('should throw detailed error when file does not exist', () => {
      expect(() => {
        resolveWasmPath('non-existent.wasm');
      }).toThrow(/Unable to find.*non-existent\.wasm/);
    });
  });

  describe('createLocateFileFunction', () => {
    it('should return a valid locateFile function', () => {
      const locateFile = createLocateFileFunction();
      
      expect(typeof locateFile).toBe('function');
    });

    it('should correctly locate tree-sitter.wasm', () => {
      const locateFile = createLocateFileFunction();
      const wasmPath = locateFile('tree-sitter.wasm', '');
      
      expect(wasmPath).toBeTruthy();
      expect(wasmPath).toMatch(/tree-sitter\/tree-sitter\.wasm$/);
      expect(fs.existsSync(wasmPath)).toBe(true);
    });

    it('should use default behavior for other files', () => {
      const locateFile = createLocateFileFunction();
      const result = locateFile('other-file.js', '/some/dir/');
      
      expect(result).toBe('/some/dir/other-file.js');
    });
  });

  describe('path uniformity validation', () => {
    it('should keep all WASM files in tree-sitter subdirectory', () => {
      const wasmFiles = [
        'tree-sitter.wasm',
        'tree-sitter-javascript.wasm',
        'tree-sitter-python.wasm',
        'tree-sitter-typescript.wasm',
      ];

      const resolvedPaths = wasmFiles.map(f => resolveWasmPath(f));
      const dirs = resolvedPaths.map(p => path.dirname(p));

      // All directories should be the same
      const uniqueDirs = new Set(dirs);
      expect(uniqueDirs.size).toBe(1);

      // Directory name should be tree-sitter
      const dir = dirs[0];
      expect(path.basename(dir)).toBe('tree-sitter');
    });
  });
});
