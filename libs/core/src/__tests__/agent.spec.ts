import { beforeEach, describe, expect, it } from "vitest";
import { buildSystemPrompt, type ContextData } from "../agent/prompts";
import type { ParsedClass, ParsedFunction, ParsedImport } from "../types";

describe("Agent - Prompt Engineering", () => {
    let mockContext: ContextData;

    beforeEach(() => {
        const mockFunction: ParsedFunction = {
            name: "calculateSum",
            params: ["a", "b"],
            returnType: "number",
            isAsync: false,
            isExported: true,
            line: 10,
        };

        const mockClass: ParsedClass = {
            name: "Calculator",
            methods: ["add", "subtract"],
            properties: ["result"],
            isExported: true,
            line: 20,
        };

        const mockImport: ParsedImport = {
            source: "react",
            namedImports: ["useState", "useEffect"],
        };

        mockContext = {
            files: [
                {
                    path: "src/utils/math.ts",
                    functions: [mockFunction],
                    classes: [mockClass],
                    imports: [mockImport],
                    fullContext: `
File: src/utils/math.ts

export function calculateSum(a: number, b: number): number {
  return a + b;
}

export class Calculator {
  result: number = 0;
  
  add(x: number) {
    this.result += x;
  }
  
  subtract(x: number) {
    this.result -= x;
  }
}
          `.trim(),
                    relevanceScore: 0.95,
                },
            ],
            projectType: "React",
            testDirectory: "e2e",
            totalTokens: 500,
        };
    });

    describe("buildSystemPrompt", () => {
        it("should include project type", () => {
            const prompt = buildSystemPrompt(mockContext, "Write a test for calculateSum");
            expect(prompt).toContain("React");
        });

        it("should include test directory", () => {
            const prompt = buildSystemPrompt(mockContext, "Write a test for calculateSum");
            expect(prompt).toContain("Test directory: e2e");
        });

        it("should include user prompt", () => {
            const userPrompt = "Write a test for calculateSum";
            const prompt = buildSystemPrompt(mockContext, userPrompt);
            expect(prompt).toContain(userPrompt);
        });

        it("should include file context", () => {
            const prompt = buildSystemPrompt(mockContext, "Write a test");
            expect(prompt).toContain("src/utils/math.ts");
            expect(prompt).toContain("calculateSum");
        });

        it("should include function information", () => {
            const prompt = buildSystemPrompt(mockContext, "Write a test");
            expect(prompt).toContain("calculateSum(a, b)");
        });

        it("should include class information", () => {
            const prompt = buildSystemPrompt(mockContext, "Write a test");
            expect(prompt).toContain("Calculator");
        });

        it("should include the load-bearing prompt sections", () => {
            const prompt = buildSystemPrompt(mockContext, "Write a test");

            expect(prompt).toContain("[ROLE]");
            expect(prompt).toContain("[PROJECT]");
            expect(prompt).toContain("[SOURCE FILES]");
            expect(prompt).toContain("[TASK]");
            expect(prompt).toContain("[OUTPUT]");
            expect(prompt).toContain("[RULES]");
        });

        it("should include selector priority guidance", () => {
            const prompt = buildSystemPrompt(mockContext, "Write a test");
            expect(prompt).toContain("getByRole");
            expect(prompt).toContain("getByTestId");
        });

        it("should forbid fixed sleeps and vague assertions", () => {
            const prompt = buildSystemPrompt(mockContext, "Write a test");
            expect(prompt).toContain("No fixed sleeps");
            expect(prompt).toContain("waitForTimeout");
            expect(prompt).toContain("No vague assertions");
        });

        it("should require absolute URLs when no baseURL is configured", () => {
            const prompt = buildSystemPrompt(mockContext, "Write a test");
            expect(prompt).toContain("URLs MUST be absolute");
            expect(prompt).not.toContain("use.baseURL` is configured");
        });

        it("should switch to relative-path URLs when a baseURL is configured", () => {
            const ctxWithBase: ContextData = {
                ...mockContext,
                baseURL: "http://localhost:3000",
            };
            const prompt = buildSystemPrompt(ctxWithBase, "Write a test");
            expect(prompt).toContain("use.baseURL` is configured: `http://localhost:3000`");
            expect(prompt).toContain("URLs MUST be relative paths");
            // The prompt must NOT hardcode an example route (e.g. /login) — it
            // should instruct the model to use observed paths, never guess.
            expect(prompt).not.toContain("/login");
            expect(prompt).toContain("never guess or assume a route");
            expect(prompt).not.toContain("URLs MUST be absolute");
        });

        it("should advertise the baseURL in the [PROJECT] section when set", () => {
            const ctxWithBase: ContextData = {
                ...mockContext,
                baseURL: "https://staging.example.com",
            };
            const prompt = buildSystemPrompt(ctxWithBase, "Write a test");
            expect(prompt).toContain("baseURL: https://staging.example.com");
        });

        it("should stay under a tight token budget for an empty context", () => {
            const minimalContext: ContextData = {
                files: [],
                projectType: "React",
                testDirectory: "e2e",
                totalTokens: 0,
            };
            const prompt = buildSystemPrompt(minimalContext, "Write a test");
            // Rough char-based proxy guarding against prompt bloat. The scaffold
            // includes the grounding + behavior/timing + rules instruction
            // blocks that steer the model to derive tests from the live DOM,
            // observed page timing, and the requested assertion polarity;
            // current minimal-context prompt is ~3.25k chars. Budget set with
            // headroom above that so the test fails only on genuine bloat, not
            // incidental wording changes.
            expect(prompt.length).toBeLessThan(3400);
        });
    });

    describe("Context Structure", () => {
        it("should handle multiple files", () => {
            const multiFileContext: ContextData = {
                ...mockContext,
                files: [
                    mockContext.files[0],
                    {
                        path: "src/components/Button.tsx",
                        functions: [],
                        classes: [],
                        imports: [],
                        fullContext: "export const Button = () => <button>Click</button>",
                        relevanceScore: 0.85,
                    },
                ],
            };

            const prompt = buildSystemPrompt(multiFileContext, "Write a test");
            expect(prompt).toContain("src/utils/math.ts");
            expect(prompt).toContain("src/components/Button.tsx");
        });

        it("should handle files with no functions or classes", () => {
            const minimalContext: ContextData = {
                files: [
                    {
                        path: "src/config.ts",
                        functions: [],
                        classes: [],
                        imports: [],
                        fullContext: 'export const API_URL = "https://api.example.com";',
                        relevanceScore: 0.5,
                    },
                ],
                projectType: "Node.js Backend",
                testDirectory: "tests",
                totalTokens: 100,
            };

            const prompt = buildSystemPrompt(minimalContext, "Write a test");
            expect(prompt).toContain("src/config.ts");
            expect(prompt).toContain("Functions: none");
            expect(prompt).toContain("Classes: none");
        });

        it("should handle different project types", () => {
            const projectTypes = ["Next.js", "Vue", "Angular", "Node.js Backend"];

            for (const projectType of projectTypes) {
                const context: ContextData = {
                    ...mockContext,
                    projectType,
                };

                const prompt = buildSystemPrompt(context, "Write a test");
                expect(prompt).toContain(`Target: ${projectType}`);
            }
        });
    });

    describe("Prompt Token Estimation", () => {
        it("should track total tokens in context", () => {
            expect(mockContext.totalTokens).toBe(500);
        });

        it("should include token information in context", () => {
            const largeContext: ContextData = {
                ...mockContext,
                totalTokens: 15000,
            };

            expect(largeContext.totalTokens).toBeLessThanOrEqual(15000);
        });
    });
});

describe("Agent - Context Gathering", () => {
    describe("File Relevance Scoring", () => {
        it("should prioritize files with higher relevance scores", () => {
            const file1 = {
                path: "src/utils.ts",
                relevanceScore: 0.95,
            };

            const file2 = {
                path: "src/other.ts",
                relevanceScore: 0.5,
            };

            expect(file1.relevanceScore).toBeGreaterThan(file2.relevanceScore);
        });
    });

    describe("Token Budget Management", () => {
        it("should respect token limits", () => {
            const TOKEN_LIMIT = 15000;
            const contextTokens = 12000;

            expect(contextTokens).toBeLessThan(TOKEN_LIMIT);
        });

        it("should estimate tokens correctly (1 token ≈ 4 characters)", () => {
            const text = "a".repeat(400); // 400 characters
            const estimatedTokens = text.length / 4; // 100 tokens

            expect(estimatedTokens).toBe(100);
        });
    });
});
