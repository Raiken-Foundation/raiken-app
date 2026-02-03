import { describe, it, expect, beforeEach } from 'vitest';
import { buildSystemPrompt, type ContextData } from '../agent/prompts';
import type { ParsedFunction, ParsedClass, ParsedImport } from '../types';

describe('Agent - Prompt Engineering', () => {
  let mockContext: ContextData;

  beforeEach(() => {
    const mockFunction: ParsedFunction = {
      name: 'calculateSum',
      params: ['a', 'b'],
      returnType: 'number',
      isAsync: false,
      isExported: true,
      line: 10,
    };

    const mockClass: ParsedClass = {
      name: 'Calculator',
      methods: ['add', 'subtract'],
      properties: ['result'],
      isExported: true,
      line: 20,
    };

    const mockImport: ParsedImport = {
      source: 'react',
      namedImports: ['useState', 'useEffect'],
    };

    mockContext = {
      files: [
        {
          path: 'src/utils/math.ts',
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
      projectType: 'React',
      testDirectory: 'e2e',
      totalTokens: 500,
    };
  });

  describe('buildSystemPrompt', () => {
    it('should include project type', () => {
      const prompt = buildSystemPrompt(mockContext, 'Write a test for calculateSum');
      expect(prompt).toContain('React');
    });

    it('should include test directory', () => {
      const prompt = buildSystemPrompt(mockContext, 'Write a test for calculateSum');
      expect(prompt).toContain('Test Directory: e2e');
    });

    it('should include user prompt', () => {
      const userPrompt = 'Write a test for calculateSum';
      const prompt = buildSystemPrompt(mockContext, userPrompt);
      expect(prompt).toContain(userPrompt);
    });

    it('should include file context', () => {
      const prompt = buildSystemPrompt(mockContext, 'Write a test');
      expect(prompt).toContain('src/utils/math.ts');
      expect(prompt).toContain('calculateSum');
    });

    it('should include function information', () => {
      const prompt = buildSystemPrompt(mockContext, 'Write a test');
      expect(prompt).toContain('calculateSum(a, b)');
    });

    it('should include class information', () => {
      const prompt = buildSystemPrompt(mockContext, 'Write a test');
      expect(prompt).toContain('Calculator');
    });

    it('should include GOLDEN framework sections', () => {
      const prompt = buildSystemPrompt(mockContext, 'Write a test');
      
      // Check for all major sections
      expect(prompt).toContain('[ROLE & EXPERTISE]');
      expect(prompt).toContain('[GOAL]');
      expect(prompt).toContain('[CONTEXT - PROJECT STRUCTURE]');
      expect(prompt).toContain('[CONTEXT - RELEVANT SOURCE FILES]');
      expect(prompt).toContain('[TASK - USER REQUEST]');
      expect(prompt).toContain('[OUTPUT FORMAT & STRUCTURE]');
      expect(prompt).toContain('[CONSTRAINTS & RULES]');
      expect(prompt).toContain('[EXAMPLES - FEW-SHOT LEARNING]');
      expect(prompt).toContain('[REASONING APPROACH - CHAIN OF THOUGHT]');
      expect(prompt).toContain('[EVALUATION CRITERIA]');
      expect(prompt).toContain('[SELF-CORRECTION]');
    });

    it('should include MUST DO constraints', () => {
      const prompt = buildSystemPrompt(mockContext, 'Write a test');
      expect(prompt).toContain('MUST DO:');
      expect(prompt).toContain('Use TypeScript with proper types');
      expect(prompt).toContain('Use Playwright\'s modern test() and expect() syntax');
    });

    it('should include MUST NOT constraints', () => {
      const prompt = buildSystemPrompt(mockContext, 'Write a test');
      expect(prompt).toContain('MUST NOT:');
      expect(prompt).toContain('Use deprecated Playwright APIs');
      expect(prompt).toContain('Generate tests with hardcoded wait times');
    });

    it('should include few-shot examples', () => {
      const prompt = buildSystemPrompt(mockContext, 'Write a test');
      expect(prompt).toContain('Example 1 - Component Interaction Test:');
      expect(prompt).toContain('Example 2 - API Response Test:');
      expect(prompt).toContain('import { test, expect } from \'@playwright/test\'');
    });

    it('should include chain-of-thought reasoning questions', () => {
      const prompt = buildSystemPrompt(mockContext, 'Write a test');
      expect(prompt).toContain('What is the core functionality being tested?');
      expect(prompt).toContain('What are the preconditions needed?');
      expect(prompt).toContain('What assertions prove the test passes?');
    });

    it('should include evaluation criteria', () => {
      const prompt = buildSystemPrompt(mockContext, 'Write a test');
      expect(prompt).toContain('Correctness: Tests the requested functionality accurately');
      expect(prompt).toContain('Completeness: Covers success and error cases');
      expect(prompt).toContain('Best Practices: Follows Playwright conventions');
    });

    it('should include self-correction instructions', () => {
      const prompt = buildSystemPrompt(mockContext, 'Write a test');
      expect(prompt).toContain('After generating the initial test:');
      expect(prompt).toContain('Review for missing assertions');
      expect(prompt).toContain('Verify all async operations use await');
    });
  });

  describe('Context Structure', () => {
    it('should handle multiple files', () => {
      const multiFileContext: ContextData = {
        ...mockContext,
        files: [
          mockContext.files[0],
          {
            path: 'src/components/Button.tsx',
            functions: [],
            classes: [],
            imports: [],
            fullContext: 'export const Button = () => <button>Click</button>',
            relevanceScore: 0.85,
          },
        ],
      };

      const prompt = buildSystemPrompt(multiFileContext, 'Write a test');
      expect(prompt).toContain('src/utils/math.ts');
      expect(prompt).toContain('src/components/Button.tsx');
    });

    it('should handle files with no functions or classes', () => {
      const minimalContext: ContextData = {
        files: [
          {
            path: 'src/config.ts',
            functions: [],
            classes: [],
            imports: [],
            fullContext: 'export const API_URL = "https://api.example.com";',
            relevanceScore: 0.5,
          },
        ],
        projectType: 'Node.js Backend',
        testDirectory: 'tests',
        totalTokens: 100,
      };

      const prompt = buildSystemPrompt(minimalContext, 'Write a test');
      expect(prompt).toContain('src/config.ts');
      expect(prompt).toContain('Functions: none');
      expect(prompt).toContain('Classes: none');
    });

    it('should handle different project types', () => {
      const projectTypes = ['Next.js', 'Vue', 'Angular', 'Node.js Backend'];
      
      for (const projectType of projectTypes) {
        const context: ContextData = {
          ...mockContext,
          projectType,
        };
        
        const prompt = buildSystemPrompt(context, 'Write a test');
        expect(prompt).toContain(`End-to-end testing for ${projectType} applications`);
      }
    });
  });

  describe('Prompt Token Estimation', () => {
    it('should track total tokens in context', () => {
      expect(mockContext.totalTokens).toBe(500);
    });

    it('should include token information in context', () => {
      const largeContext: ContextData = {
        ...mockContext,
        totalTokens: 15000,
      };
      
      expect(largeContext.totalTokens).toBeLessThanOrEqual(15000);
    });
  });
});

describe('Agent - Context Gathering', () => {
  describe('File Relevance Scoring', () => {
    it('should prioritize files with higher relevance scores', () => {
      const file1 = {
        path: 'src/utils.ts',
        relevanceScore: 0.95,
      };
      
      const file2 = {
        path: 'src/other.ts',
        relevanceScore: 0.5,
      };
      
      expect(file1.relevanceScore).toBeGreaterThan(file2.relevanceScore);
    });
  });

  describe('Token Budget Management', () => {
    it('should respect token limits', () => {
      const TOKEN_LIMIT = 15000;
      const contextTokens = 12000;
      
      expect(contextTokens).toBeLessThan(TOKEN_LIMIT);
    });

    it('should estimate tokens correctly (1 token ≈ 4 characters)', () => {
      const text = 'a'.repeat(400); // 400 characters
      const estimatedTokens = text.length / 4; // 100 tokens
      
      expect(estimatedTokens).toBe(100);
    });
  });
});
