import { describe, it, expect } from 'vitest';
import { parsePathFilters, isGlobPattern } from '../path-filters';

describe('parsePathFilters', () => {
  it('should parse single pattern', () => {
    expect(parsePathFilters('src/**/*.ts')).toEqual(['src/**/*.ts']);
  });

  it('should parse comma-separated patterns', () => {
    expect(parsePathFilters('src/**/*.ts,test/**/*.js')).toEqual([
      'src/**/*.ts',
      'test/**/*.js'
    ]);
  });

  it('should handle spaces around commas', () => {
    expect(parsePathFilters('src/**/*.ts, test/**/*.js , lib/**/*.ts')).toEqual([
      'src/**/*.ts',
      'test/**/*.js',
      'lib/**/*.ts'
    ]);
  });

  it('should respect brace expansion (not split commas inside braces)', () => {
    expect(parsePathFilters('**/*.{ts,js}')).toEqual(['**/*.{ts,js}']);
    expect(parsePathFilters('**/*.{ts,js},!node_modules/**')).toEqual([
      '**/*.{ts,js}',
      '!node_modules/**'
    ]);
  });

  it('should handle nested braces', () => {
    expect(parsePathFilters('src/**/*.{ts,{jsx,tsx}}')).toEqual(['src/**/*.{ts,{jsx,tsx}}']);
  });

  it('should handle exclude patterns', () => {
    expect(parsePathFilters('src/**/*.ts,!src/**/*.test.ts')).toEqual([
      'src/**/*.ts',
      '!src/**/*.test.ts'
    ]);
  });

  it('should handle empty strings', () => {
    expect(parsePathFilters('')).toEqual([]);
    expect(parsePathFilters('  ')).toEqual([]);
  });

  it('should ignore empty segments', () => {
    expect(parsePathFilters('src/**/*.ts,,test/**/*.js')).toEqual([
      'src/**/*.ts',
      'test/**/*.js'
    ]);
  });

  it('should handle mixed patterns with braces and excludes', () => {
    expect(parsePathFilters('src/**/*.{ts,tsx},lib/**/*.js,!**/*.test.ts')).toEqual([
      'src/**/*.{ts,tsx}',
      'lib/**/*.js',
      '!**/*.test.ts'
    ]);
  });
});

describe('isGlobPattern', () => {
  it('should detect asterisk wildcard', () => {
    expect(isGlobPattern('src/**/*.ts')).toBe(true);
    expect(isGlobPattern('*.js')).toBe(true);
  });

  it('should detect question mark wildcard', () => {
    expect(isGlobPattern('file?.ts')).toBe(true);
  });

  it('should detect braces', () => {
    expect(isGlobPattern('**/*.{ts,js}')).toBe(true);
  });

  it('should detect brackets', () => {
    expect(isGlobPattern('[abc].ts')).toBe(true);
  });

  it('should detect comma-separated patterns', () => {
    expect(isGlobPattern('src/a.ts,src/b.ts')).toBe(true);
  });

  it('should not detect plain file paths', () => {
    expect(isGlobPattern('src/file.ts')).toBe(false);
    expect(isGlobPattern('path/to/file')).toBe(false);
  });

  it('should handle empty strings', () => {
    expect(isGlobPattern('')).toBe(false);
  });
});
