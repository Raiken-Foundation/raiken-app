/**
 * Test Result Interpreter
 * 
 * Uses AI to analyze test results alongside code and DOM context
 * to provide meaningful interpretations and actionable insights.
 */

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { streamText } from 'ai';
import type { DOMContext } from '../browser/dom-capture';

export interface TestResultForInterpretation {
  name: string;
  suite: string;
  status: 'passed' | 'failed' | 'skipped';
  duration?: number;
  error?: {
    message?: string;
    snippet?: string;
    location?: {
      file: string;
      line: number;
      column: number;
    };
  };
}

export interface InterpretationContext {
  testResults: TestResultForInterpretation[];
  testCode: string;
  sourceCode?: string;
  domContext?: DOMContext;
  projectPath: string;
}

export interface InterpretationConfig {
  apiKey: string;
  model?: string;
}

/**
 * Interpret test results using AI
 * Returns a streaming response with insights
 */
export async function* interpretTestResults(
  context: InterpretationContext,
  config: InterpretationConfig
): AsyncGenerator<string, void, unknown> {
  const { testResults, testCode, sourceCode, domContext } = context;
  
  if (!config.apiKey) {
    yield 'Error: API key not configured for test interpretation.';
    return;
  }

  const openrouter = createOpenRouter({
    apiKey: config.apiKey,
  });

  const failedTests = testResults.filter(t => t.status === 'failed');
  const passedTests = testResults.filter(t => t.status === 'passed');

  let prompt = `Analyze Playwright test results. Be concise and actionable.

Summary: ${testResults.length} total, ${passedTests.length} passed, ${failedTests.length} failed.

Test code:
\`\`\`typescript
${testCode.slice(0, 4000)}
\`\`\`
`;

  if (sourceCode) {
    prompt += `\nSource under test:
\`\`\`typescript
${sourceCode.slice(0, 2000)}
\`\`\`
`;
  }

  if (domContext) {
    prompt += `\nLive DOM (${domContext.url} — "${domContext.title}")
Interactive:
${domContext.interactiveElements.slice(0, 15).map(el =>
  `- ${el.role || el.tagName}: "${el.name || el.text || 'unnamed'}" → ${el.suggestedSelectors[0] || 'no selector'}`
).join('\n')}
Forms:
${domContext.formFields.slice(0, 10).map(f =>
  `- ${f.name} (${f.type}): ${f.suggestedSelector}`
).join('\n')}
`;
  }

  if (failedTests.length > 0) {
    prompt += `\nFailures:\n`;
    for (const test of failedTests) {
      prompt += `\n- ${test.suite} > ${test.name}\n`;
      if (test.error?.message) {
        const cleanMessage = test.error.message.replace(/\u001b\[[0-9;]*m/g, '');
        prompt += `  error: ${cleanMessage}\n`;
      }
      if (test.error?.snippet) {
        prompt += `  snippet:\n\`\`\`\n${test.error.snippet}\n\`\`\`\n`;
      }
      if (test.error?.location) {
        prompt += `  at: ${test.error.location.file.split('/').pop()}:${test.error.location.line}\n`;
      }
    }
  }

  prompt += `
Output (skip empty sections):
1. Summary — overall health in 1-2 lines.
2. Failures — for each: root cause, selector/timing/logic, then a fix (with corrected code if useful).
3. Quality — selector resilience, missing assertions, concrete improvements.${failedTests.length === 0 ? '\n4. What is working well — short.' : ''}`;

  try {
    const result = await streamText({
      model: openrouter.chat(config.model || 'anthropic/claude-sonnet-4.5'),
      prompt,
      temperature: 0.5,
      maxOutputTokens: 4096,
    });

    for await (const chunk of result.textStream) {
      yield chunk;
    }
  } catch (error) {
    yield `Error interpreting test results: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Get a quick summary interpretation (non-streaming)
 */
export async function getQuickInterpretation(
  context: InterpretationContext,
  config: InterpretationConfig
): Promise<string> {
  let result = '';
  for await (const chunk of interpretTestResults(context, config)) {
    result += chunk;
  }
  return result;
}
