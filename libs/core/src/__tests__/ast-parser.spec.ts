import { describe, expect, it } from "vitest";
import { fullAstToSearchableText, parseSourceFile } from "../analysis/ast-parser";

describe("AST Parser", () => {
    describe("Function Extraction", () => {
        it("should extract function declarations with parameters", () => {
            const code = `
        export function sum(a: number, b: number): number {
          return a + b;
        }
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.functions).toHaveLength(1);
            expect(ast.functions[0].name).toBe("sum");
            expect(ast.functions[0].params).toEqual(["a", "b"]);
            expect(ast.functions[0].isExported).toBe(true);
            expect(ast.functions[0].isAsync).toBe(false);
        });

        it("should extract async functions", () => {
            const code = `
        export async function fetchData(url: string) {
          return await fetch(url);
        }
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.functions).toHaveLength(1);
            expect(ast.functions[0].name).toBe("fetchData");
            expect(ast.functions[0].isAsync).toBe(true);
            expect(ast.functions[0].isExported).toBe(true);
        });

        it("should extract arrow functions", () => {
            const code = `
        export const multiply = (a: number, b: number) => a * b;
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.functions).toHaveLength(1);
            expect(ast.functions[0].name).toBe("multiply");
            expect(ast.functions[0].params).toEqual(["a", "b"]);
            expect(ast.functions[0].isExported).toBe(true);
        });

        it("should extract function expressions", () => {
            const code = `
        const divide = function(a, b) {
          return a / b;
        };
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.functions).toHaveLength(1);
            expect(ast.functions[0].name).toBe("divide");
            expect(ast.functions[0].params).toEqual(["a", "b"]);
        });

        it("should handle functions with no parameters", () => {
            const code = `
        export function getCurrentTime() {
          return Date.now();
        }
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.functions).toHaveLength(1);
            expect(ast.functions[0].name).toBe("getCurrentTime");
            expect(ast.functions[0].params).toEqual([]);
        });

        it("should handle functions with rest parameters", () => {
            const code = `
        function sum(...numbers: number[]) {
          return numbers.reduce((a, b) => a + b, 0);
        }
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.functions).toHaveLength(1);
            expect(ast.functions[0].name).toBe("sum");
            expect(ast.functions[0].params).toContain("...numbers"); // Rest parameter includes ...
        });

        it("should detect exported vs non-exported functions", () => {
            const code = `
        export function exported() {}
        function notExported() {}
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.functions).toHaveLength(2);
            expect(ast.functions.find((f) => f.name === "exported")?.isExported).toBe(true);
            expect(ast.functions.find((f) => f.name === "notExported")?.isExported).toBe(false);
        });
    });

    describe("Class Extraction", () => {
        it("should extract class definitions", () => {
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
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.classes).toHaveLength(1);
            expect(ast.classes[0].name).toBe("Calculator");
            expect(ast.classes[0].isExported).toBe(true);
            expect(ast.classes[0].methods).toHaveLength(2);
            expect(ast.classes[0].methods[0]).toBe("add");
            expect(ast.classes[0].methods[1]).toBe("multiply");
        });

        it("should extract class properties", () => {
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
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.classes).toHaveLength(1);
            expect(ast.classes[0].properties).toHaveLength(2);
            expect(ast.classes[0].properties[0]).toBe("name");
            expect(ast.classes[0].properties[1]).toBe("age");
        });

        it("should extract class with constructor", () => {
            const code = `
        class Animal {
          constructor(public name: string) {}
        }
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.classes).toHaveLength(1);
            expect(ast.classes[0].methods.some((m) => m === "constructor")).toBe(true);
        });
    });

    describe("Import Extraction", () => {
        it("should extract named imports", () => {
            const code = `
        import { useState, useEffect } from 'react';
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.imports).toHaveLength(1);
            expect(ast.imports[0].source).toBe("react");
            expect(ast.imports[0].namedImports).toHaveLength(2);
            expect(ast.imports[0].namedImports).toContain("useState");
            expect(ast.imports[0].namedImports).toContain("useEffect");
        });

        it("should extract default imports", () => {
            const code = `
        import React from 'react';
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.imports).toHaveLength(1);
            expect(ast.imports[0].source).toBe("react");
            expect(ast.imports[0].defaultImport).toBe("React");
        });

        it("should extract namespace imports", () => {
            const code = `
        import * as path from 'path';
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.imports).toHaveLength(1);
            expect(ast.imports[0].source).toBe("path");
            expect(ast.imports[0].namespaceImport).toBe("path");
        });

        it("should detect type-only imports", () => {
            const code = `
        import type { User } from './types';
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.imports).toHaveLength(1);
            expect(ast.imports[0].isTypeOnly).toBe(true);
            expect(ast.imports[0].source).toBe("./types");
        });

        it("should extract mixed imports", () => {
            const code = `
        import React, { useState, useEffect } from 'react';
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.imports).toHaveLength(1);
            expect(ast.imports[0].defaultImport).toBe("React");
            expect(ast.imports[0].namedImports).toContain("useState");
            expect(ast.imports[0].namedImports).toContain("useEffect");
        });
    });

    describe("Export Extraction", () => {
        it("should extract named exports", () => {
            const code = `
        export function foo() {}
        export const bar = 42;
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.exports).toHaveLength(2);
            expect(ast.exports).toContain("foo");
            expect(ast.exports).toContain("bar");
        });

        it("should extract default exports", () => {
            const code = `
        export default function main() {}
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.exports).toHaveLength(1);
            expect(ast.exports[0]).toContain("default"); // Now includes function name: 'default (main)'
        });

        it("should extract re-exports and their dependency source", () => {
            const code = `
        export { foo, bar } from './module';
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.exports).toEqual(expect.arrayContaining(["foo", "bar"]));
            // The re-export is a dependency edge — the source must be
            // recorded so the code graph links this file to './module'
            // (review finding: the source used to be discarded).
            expect(ast.imports).toEqual([
                expect.objectContaining({ source: "./module", namedImports: ["foo", "bar"] }),
            ]);
        });

        it("should extract export all as a dependency edge", () => {
            const code = `
        export * from './module';
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            // Export-all carries no local export names, but the barrel
            // dependency must exist (review finding: no visitor at all).
            expect(ast.imports).toEqual([
                expect.objectContaining({ source: "./module" }),
            ]);
        });

        it("records dynamic imports and CJS requires as dependencies", () => {
            const code = `
        async function load() {
            const mod = await import('./lazy');
            const other = require('./legacy');
            return [mod, other];
        }
      `;
            const { parsed: ast } = parseSourceFile(code, "test.cjs.ts");

            const sources = ast.imports.map((imp) => imp.source);
            expect(sources).toEqual(expect.arrayContaining(["./lazy", "./legacy"]));
        });

        it("marks inline type-only imports as type-only", () => {
            const code = `import { type Foo, type Bar } from './types';\nexport const x = 1;\n`;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.imports[0]?.isTypeOnly).toBe(true);
        });

        it("records default-valued parameters by their bound name", () => {
            const code = `function f(a = 1, ...rest) { return [a, rest]; }\n`;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            // Review finding: default params used to render as the literal
            // string "param", corrupting every downstream signature.
            expect(ast.functions[0]?.params).toEqual(["a", "...rest"]);
        });
    });

    describe("TypeScript Type Extraction", () => {
        it("should extract interface definitions", () => {
            const code = `
        export interface User {
          name: string;
          age: number;
        }
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.types).toHaveLength(1);
            expect(ast.types[0].name).toBe("User");
            expect(ast.types[0].kind).toBe("interface");
            expect(ast.types[0].isExported).toBe(true);
        });

        it("should extract type aliases", () => {
            const code = `
        export type Status = 'pending' | 'success' | 'error';
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.types).toHaveLength(1);
            expect(ast.types[0].name).toBe("Status");
            expect(ast.types[0].kind).toBe("type");
        });

        it("should extract enum definitions", () => {
            const code = `
        export enum Color {
          Red,
          Green,
          Blue
        }
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.types).toHaveLength(1);
            expect(ast.types[0].name).toBe("Color");
            expect(ast.types[0].kind).toBe("enum");
        });
    });

    describe("JSX Handling", () => {
        it("should parse React components", () => {
            const code = `
        export function Button({ label }: { label: string }) {
          return <button>{label}</button>;
        }
      `;
            const { parsed: ast } = parseSourceFile(code, "test.tsx");

            expect(ast.functions).toHaveLength(1);
            expect(ast.functions[0].name).toBe("Button");
            expect(ast.functions[0].isExported).toBe(true);
        });

        it("should parse component with hooks", () => {
            const code = `
        import { useState } from 'react';
        
        export function Counter() {
          const [count, setCount] = useState(0);
          return <div>{count}</div>;
        }
      `;
            const { parsed: ast } = parseSourceFile(code, "test.tsx");

            expect(ast.imports).toHaveLength(1);
            expect(ast.functions).toHaveLength(1);
            expect(ast.functions[0].name).toBe("Counter");
        });
    });

    describe("Edge Cases", () => {
        it("should handle empty files", () => {
            const code = "";
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.functions).toHaveLength(0);
            expect(ast.classes).toHaveLength(0);
            expect(ast.imports).toHaveLength(0);
            expect(ast.exports).toHaveLength(0);
            expect(ast.types).toHaveLength(0);
        });

        it("should handle files with only comments", () => {
            const code = `
        // This is a comment
        /* This is a block comment */
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.functions).toHaveLength(0);
            expect(ast.classes).toHaveLength(0);
        });

        it("should handle complex nested structures", () => {
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
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.classes).toHaveLength(1);
            expect(ast.classes[0].properties).toHaveLength(1);
            expect(ast.classes[0].methods.length).toBeGreaterThan(0);
        });

        it("should handle generic types", () => {
            const code = `
        export function identity<T>(arg: T): T {
          return arg;
        }
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.functions).toHaveLength(1);
            expect(ast.functions[0].name).toBe("identity");
            expect(ast.functions[0].params).toEqual(["arg"]);
        });

        it("should handle decorators", () => {
            const code = `
        @Component
        export class MyComponent {
          @Input() name: string;
        }
      `;
            const { parsed: ast } = parseSourceFile(code, "test.ts");

            expect(ast.classes).toHaveLength(1);
            expect(ast.classes[0].name).toBe("MyComponent");
        });

        it("should parse modern syntax without throwing", () => {
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

            expect(() => parseSourceFile(code, "test.ts")).not.toThrow();
        });
    });

    describe("Performance", () => {
        it("should parse files quickly", () => {
            const code = `
        export function test1() {}
        export function test2() {}
        export function test3() {}
        export class Test4 {}
        export interface Test5 {}
      `;

            const start = Date.now();
            parseSourceFile(code, "test.ts");
            const duration = Date.now() - start;

            expect(duration).toBeLessThan(50); // Should parse in less than 50ms
        });
    });
});

describe("fullAstToSearchableText", () => {
    it("extracts functions, classes, types, and imports with full context", () => {
        const code = `
import React from "react";

export async function fetchData(url: string) {
    return url;
}

export class Store {
    constructor() {}
    get value() { return 1; }
    set value(v: number) {}
    async load() {}
    count = 0;
}

export interface Options {
    timeout: number;
    retry(): void;
}

export type Id = string;

export enum Color { Red, Green }
`;
        const { ast } = parseSourceFile(code, "sample.ts");
        const text = fullAstToSearchableText(ast, "sample.ts");

        expect(text).toContain("File: sample.ts");
        expect(text).toContain("export async function fetchData(url)");
        expect(text).toContain("export class Store");
        expect(text).toContain("getter value()");
        expect(text).toContain("setter value(v)");
        expect(text).toContain("async method load()");
        expect(text).toContain("property count");
        expect(text).toContain("export interface Options");
        expect(text).toContain("timeout: type");
        expect(text).toContain("retry()");
        expect(text).toContain("export type Id = ...");
        expect(text).toContain("export enum Color");
        expect(text).toContain("Red");
        expect(text).toContain('import React from "react"');
    });

    it("returns just the file header for a missing program", () => {
        expect(fullAstToSearchableText(null, "x.ts")).toBe("File: x.ts\n");
        expect(fullAstToSearchableText({}, "x.ts")).toBe("File: x.ts\n");
    });

    it("appends a code snippet for short source code", () => {
        const { ast } = parseSourceFile("export const a = 1;", "s.ts");
        const text = fullAstToSearchableText(ast, "s.ts", "export const a = 1;");
        expect(text).toContain("--- Code Snippet ---");
        expect(text).toContain("export const a = 1;");
    });
});

describe("parse error handling", () => {
    it("reports the filename and message for invalid syntax", () => {
        expect(() => parseSourceFile("const = ;", "bad.ts")).toThrow(/Parse error in bad\.ts/);
    });
});
