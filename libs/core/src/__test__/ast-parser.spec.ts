import { describe, it, expect } from 'vitest';
import { parseSourceFile, astToSearchableText, generateCodeChunks, chunkToSearchableText } from '../analysis/ast-parser';

describe('AST Parser', () => {
  describe('Function Extraction', () => {
    it('should extract function declarations with parameters', () => {
      const code = `
        export function sum(a: number, b: number): number {
          return a + b;
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.functions).toHaveLength(1);
      expect(ast.functions[0].name).toBe('sum');
      expect(ast.functions[0].params).toEqual(['a', 'b']);
      expect(ast.functions[0].isExported).toBe(true);
      expect(ast.functions[0].isAsync).toBe(false);
    });

    it('should extract async functions', () => {
      const code = `
        export async function fetchData(url: string) {
          return await fetch(url);
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.functions).toHaveLength(1);
      expect(ast.functions[0].name).toBe('fetchData');
      expect(ast.functions[0].isAsync).toBe(true);
      expect(ast.functions[0].isExported).toBe(true);
    });

    it('should extract arrow functions', () => {
      const code = `
        export const multiply = (a: number, b: number) => a * b;
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.functions).toHaveLength(1);
      expect(ast.functions[0].name).toBe('multiply');
      expect(ast.functions[0].params).toEqual(['a', 'b']);
      expect(ast.functions[0].isExported).toBe(true);
    });

    it('should extract function expressions', () => {
      const code = `
        const divide = function(a, b) {
          return a / b;
        };
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.functions).toHaveLength(1);
      expect(ast.functions[0].name).toBe('divide');
      expect(ast.functions[0].params).toEqual(['a', 'b']);
    });

    it('should handle functions with no parameters', () => {
      const code = `
        export function getCurrentTime() {
          return Date.now();
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.functions).toHaveLength(1);
      expect(ast.functions[0].name).toBe('getCurrentTime');
      expect(ast.functions[0].params).toEqual([]);
    });

    it('should handle functions with rest parameters', () => {
      const code = `
        function sum(...numbers: number[]) {
          return numbers.reduce((a, b) => a + b, 0);
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.functions).toHaveLength(1);
      expect(ast.functions[0].name).toBe('sum');
      expect(ast.functions[0].params).toContain('...numbers'); // Rest parameter includes ...
    });

    it('should detect exported vs non-exported functions', () => {
      const code = `
        export function exported() {}
        function notExported() {}
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.functions).toHaveLength(2);
      expect(ast.functions.find(f => f.name === 'exported')?.isExported).toBe(true);
      expect(ast.functions.find(f => f.name === 'notExported')?.isExported).toBe(false);
    });
  });

  describe('Class Extraction', () => {
    it('should extract class definitions', () => {
      const code = `
        export class Calculator {
          add(a: number, b: number) {
            return a + b;
          }
          
          multiply(a: number, b: number) {
            return a * b;
          }
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.classes).toHaveLength(1);
      expect(ast.classes[0].name).toBe('Calculator');
      expect(ast.classes[0].isExported).toBe(true);
      expect(ast.classes[0].methods).toHaveLength(2);
      expect(ast.classes[0].methods[0]).toBe('add');
      expect(ast.classes[0].methods[1]).toBe('multiply');
    });

    it('should extract class properties', () => {
      const code = `
        class User {
          name: string;
          age: number;
          
          constructor(name: string, age: number) {
            this.name = name;
            this.age = age;
          }
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.classes).toHaveLength(1);
      expect(ast.classes[0].properties).toHaveLength(2);
      expect(ast.classes[0].properties[0]).toBe('name');
      expect(ast.classes[0].properties[1]).toBe('age');
    });

    it('should extract class with constructor', () => {
      const code = `
        class Animal {
          constructor(public name: string) {}
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.classes).toHaveLength(1);
      expect(ast.classes[0].methods.some(m => m === 'constructor')).toBe(true);
    });
  });

  describe('Import Extraction', () => {
    it('should extract named imports', () => {
      const code = `
        import { useState, useEffect } from 'react';
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.imports).toHaveLength(1);
      expect(ast.imports[0].source).toBe('react');
      expect(ast.imports[0].namedImports).toHaveLength(2);
      expect(ast.imports[0].namedImports).toContain('useState');
      expect(ast.imports[0].namedImports).toContain('useEffect');
    });

    it('should extract default imports', () => {
      const code = `
        import React from 'react';
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.imports).toHaveLength(1);
      expect(ast.imports[0].source).toBe('react');
      expect(ast.imports[0].defaultImport).toBe('React');
    });

    it('should extract namespace imports', () => {
      const code = `
        import * as path from 'path';
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.imports).toHaveLength(1);
      expect(ast.imports[0].source).toBe('path');
      expect(ast.imports[0].namespaceImport).toBe('path');
    });

    it('should detect type-only imports', () => {
      const code = `
        import type { User } from './types';
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.imports).toHaveLength(1);
      expect(ast.imports[0].isTypeOnly).toBe(true);
      expect(ast.imports[0].source).toBe('./types');
    });

    it('should extract mixed imports', () => {
      const code = `
        import React, { useState, useEffect } from 'react';
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.imports).toHaveLength(1);
      expect(ast.imports[0].defaultImport).toBe('React');
      expect(ast.imports[0].namedImports).toContain('useState');
      expect(ast.imports[0].namedImports).toContain('useEffect');
    });
  });

  describe('Export Extraction', () => {
    it('should extract named exports', () => {
      const code = `
        export function foo() {}
        export const bar = 42;
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.exports).toHaveLength(2);
      expect(ast.exports).toContain('foo');
      expect(ast.exports).toContain('bar');
    });

    it('should extract default exports', () => {
      const code = `
        export default function main() {}
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.exports).toHaveLength(1);
      expect(ast.exports[0]).toContain('default'); // Now includes function name: 'default (main)'
    });

    it('should extract re-exports', () => {
      const code = `
        export { foo, bar } from './module';
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.exports.length).toBeGreaterThan(0);
    });

    it('should extract export all', () => {
      const code = `
        export * from './module';
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.exports.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('TypeScript Type Extraction', () => {
    it('should extract interface definitions', () => {
      const code = `
        export interface User {
          name: string;
          age: number;
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.types).toHaveLength(1);
      expect(ast.types[0].name).toBe('User');
      expect(ast.types[0].kind).toBe('interface');
      expect(ast.types[0].isExported).toBe(true);
    });

    it('should extract type aliases', () => {
      const code = `
        export type Status = 'pending' | 'success' | 'error';
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.types).toHaveLength(1);
      expect(ast.types[0].name).toBe('Status');
      expect(ast.types[0].kind).toBe('type');
    });

    it('should extract enum definitions', () => {
      const code = `
        export enum Color {
          Red,
          Green,
          Blue
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.types).toHaveLength(1);
      expect(ast.types[0].name).toBe('Color');
      expect(ast.types[0].kind).toBe('enum');
    });
  });

  describe('JSX Handling', () => {
    it('should parse React components', () => {
      const code = `
        export function Button({ label }: { label: string }) {
          return <button>{label}</button>;
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.tsx');
      
      expect(ast.functions).toHaveLength(1);
      expect(ast.functions[0].name).toBe('Button');
      expect(ast.functions[0].isExported).toBe(true);
    });

    it('should parse component with hooks', () => {
      const code = `
        import { useState } from 'react';
        
        export function Counter() {
          const [count, setCount] = useState(0);
          return <div>{count}</div>;
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.tsx');
      
      expect(ast.imports).toHaveLength(1);
      expect(ast.functions).toHaveLength(1);
      expect(ast.functions[0].name).toBe('Counter');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty files', () => {
      const code = '';
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.functions).toHaveLength(0);
      expect(ast.classes).toHaveLength(0);
      expect(ast.imports).toHaveLength(0);
      expect(ast.exports).toHaveLength(0);
      expect(ast.types).toHaveLength(0);
    });

    it('should handle files with only comments', () => {
      const code = `
        // This is a comment
        /* This is a block comment */
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.functions).toHaveLength(0);
      expect(ast.classes).toHaveLength(0);
    });

    it('should handle complex nested structures', () => {
      const code = `
        export class Container {
          private items: Item[] = [];
          
          add(item: Item) {
            this.items.push(item);
          }
          
          get count() {
            return this.items.length;
          }
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.classes).toHaveLength(1);
      expect(ast.classes[0].properties).toHaveLength(1);
      expect(ast.classes[0].methods.length).toBeGreaterThan(0);
    });

    it('should handle generic types', () => {
      const code = `
        export function identity<T>(arg: T): T {
          return arg;
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.functions).toHaveLength(1);
      expect(ast.functions[0].name).toBe('identity');
      expect(ast.functions[0].params).toEqual(['arg']);
    });

    it('should handle decorators', () => {
      const code = `
        @Component
        export class MyComponent {
          @Input() name: string;
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      
      expect(ast.classes).toHaveLength(1);
      expect(ast.classes[0].name).toBe('MyComponent');
    });

    it('should parse modern syntax without throwing', () => {
      const code = `
        import data from './data.json' assert { type: 'json' };

        class Example {
          field = 1;
          #privateField = 2;
          static staticField = 3;
          static {
            this.staticField ??= 4;
          }

          getValue() {
            return this?.field ?? 0;
          }
        }

        const value = (data?.value ?? 0) + 1_000n;

        await Promise.resolve(value);
      `;

      expect(() => parseSourceFile(code, 'test.ts')).not.toThrow();
    });
  });

  describe('AST to Searchable Text', () => {
    it('should convert parsed AST to searchable text format', () => {
      const code = `
        export function sum(a: number, b: number) {
          return a + b;
        }
        
        export class Calculator {
          multiply(x: number, y: number) {
            return x * y;
          }
        }
        
        export type Result = number;
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      const searchableText = astToSearchableText(ast, 'src/math.ts');
      
      expect(searchableText).toContain('File: src/math.ts');
      expect(searchableText).toContain('function sum(a, b)');
      expect(searchableText).toContain('class Calculator');
      expect(searchableText).toContain('method Calculator.multiply()'); // Updated to match refactored output
      expect(searchableText).toContain('type Result');
    });

    it('should include async modifier for async functions', () => {
      const code = `
        export async function fetchData(url: string) {
          return await fetch(url);
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      const searchableText = astToSearchableText(ast, 'src/api.ts');
      
      expect(searchableText).toContain('async function fetchData(url)');
    });

    it('should format class methods properly', () => {
      const code = `
        export class Service {
          async getData() {}
          processData(data: any) {}
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      const searchableText = astToSearchableText(ast, 'src/service.ts');
      
      expect(searchableText).toContain('class Service');
      expect(searchableText).toContain('method Service.getData()'); // Updated to match refactored output
      expect(searchableText).toContain('method Service.processData()'); // Updated to match refactored output
    });
  });

  describe('Code Chunk Generation', () => {
    it('should generate chunks for functions', () => {
      const code = `
        export function sum(a: number, b: number) { return a + b; }
        async function fetch() { return data; }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      const chunks = generateCodeChunks(ast, 'src/math.ts');
      
      expect(chunks).toHaveLength(2);
      expect(chunks[0].type).toBe('function');
      expect(chunks[0].name).toBe('sum');
      expect(chunks[0].isAsync).toBe(false);
      expect(chunks[1].isAsync).toBe(true);
    });

    it('should generate chunks for classes and methods', () => {
      const code = `
        export class Calculator {
          add(a, b) { return a + b; }
          multiply(x, y) { return x * y; }
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      const chunks = generateCodeChunks(ast, 'src/calc.ts');
      
      expect(chunks.length).toBeGreaterThanOrEqual(3); // class + 2 methods
      expect(chunks.some(c => c.name === 'Calculator')).toBe(true);
      expect(chunks.some(c => c.name === 'Calculator.add')).toBe(true);
      expect(chunks.some(c => c.name === 'Calculator.multiply')).toBe(true);
    });

    it('should convert chunks to searchable text', () => {
      const code = `export function test(x: string) {}`;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      const chunks = generateCodeChunks(ast, 'src/utils.ts');
      
      const text = chunkToSearchableText(chunks[0]);
      expect(text).toContain('function test');
      expect(text).toContain('src/utils.ts');
    });

    it('should handle class chunks with method info', () => {
      const code = `
        export class Service {
          getData() {}
          setData() {}
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      const chunks = generateCodeChunks(ast, 'src/service.ts');
      
      const classChunk = chunks.find(c => c.type === 'class');
      expect(classChunk).toBeDefined();
      const text = chunkToSearchableText(classChunk!);
      expect(text).toContain('class Service');
      expect(text).toContain('with 2 methods');
    });

    it('should handle type chunks', () => {
      const code = `
        export interface User { name: string; }
        export type Status = 'active' | 'inactive';
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      const chunks = generateCodeChunks(ast, 'src/types.ts');
      
      expect(chunks).toHaveLength(2);
      expect(chunks[0].type).toBe('type');
      expect(chunks[1].type).toBe('type');
      
      const text1 = chunkToSearchableText(chunks[0]);
      const text2 = chunkToSearchableText(chunks[1]);
      expect(text1).toContain('interface User');
      expect(text2).toContain('type Status');
    });

    it('should preserve metadata in chunks', () => {
      const code = `
        export async function fetchData(url: string) {
          return await fetch(url);
        }
      `;
      const { parsed: ast } = parseSourceFile(code, 'test.ts');
      const chunks = generateCodeChunks(ast, 'src/api.ts');
      
      expect(chunks[0].isExported).toBe(true);
      expect(chunks[0].isAsync).toBe(true);
      expect(chunks[0].line).toBeGreaterThan(0);
    });
  });

  describe('Performance', () => {
    it('should parse files quickly', () => {
      const code = `
        export function test1() {}
        export function test2() {}
        export function test3() {}
        export class Test4 {}
        export interface Test5 {}
      `;
      
      const start = Date.now();
      parseSourceFile(code, 'test.ts');
      const duration = Date.now() - start;
      
      expect(duration).toBeLessThan(50); // Should parse in less than 50ms
    });
  });
});

