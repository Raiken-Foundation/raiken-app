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

  // Build the interpretation prompt
  const failedTests = testResults.filter(t => t.status === 'failed');
  const passedTests = testResults.filter(t => t.status === 'passed');
  
  let prompt = `You are a Playwright testing expert analyzing test results. Provide clear, actionable insights.

## Test Execution Summary
- **Total Tests**: ${testResults.length}
- **Passed**: ${passedTests.length}
- **Failed**: ${failedTests.length}

## Test Code
\`\`\`typescript
${testCode.slice(0, 4000)}
\`\`\`

`;

  // Add source code context if available
  if (sourceCode) {
    prompt += `## Source Code Being Tested
\`\`\`typescript
${sourceCode.slice(0, 2000)}
\`\`\`

`;
  }

  // Add DOM context if available
  if (domContext) {
    prompt += `## Live DOM Context (from ${domContext.url})
**Page Title**: ${domContext.title}

**Available Interactive Elements**:
${domContext.interactiveElements.slice(0, 15).map(el => 
  `- ${el.role || el.tagName}: "${el.name || el.text || 'unnamed'}" → ${el.suggestedSelectors[0] || 'no selector'}`
).join('\n')}

**Form Fields**:
${domContext.formFields.slice(0, 10).map(f => 
  `- ${f.name} (${f.type}): ${f.suggestedSelector}`
).join('\n')}

`;
  }

  // Add detailed failure information
  if (failedTests.length > 0) {
    prompt += `## Failed Tests Details

`;
    for (const test of failedTests) {
      prompt += `### ❌ ${test.suite} > ${test.name}
`;
      if (test.error?.message) {
        // Strip ANSI codes
        const cleanMessage = test.error.message.replace(/\u001b\[[0-9;]*m/g, '');
        prompt += `**Error**: ${cleanMessage}

`;
      }
      if (test.error?.snippet) {
        prompt += `**Code Snippet**:
\`\`\`
${test.error.snippet}
\`\`\`

`;
      }
      if (test.error?.location) {
        prompt += `**Location**: ${test.error.location.file.split('/').pop()}:${test.error.location.line}

`;
      }
    }
  }

  // Instructions for the AI
  prompt += `## Your Task

Provide a comprehensive analysis with the following sections:

### 1. Executive Summary
Brief overview of test results - what passed, what failed, overall health.

### 2. Failure Analysis (if any failures)
For each failed test:
- **Root Cause**: What specifically caused the failure
- **Selector Issues**: Are the selectors correct based on the DOM context?
- **Timing Issues**: Could this be a race condition or async problem?
- **Logic Issues**: Is the test logic correct?

### 3. Recommendations
Specific, actionable fixes for each failure. Include corrected code snippets when possible.

### 4. Test Quality Assessment
- Are the tests following best practices?
- Are selectors resilient (using role-based > test-id > CSS)?
- Are there missing assertions?
- Suggestions for improvement.

${failedTests.length === 0 ? `
### 5. Celebration! 🎉
All tests passed! Highlight what's working well.
` : ''}

Be concise but thorough. Focus on actionable insights.`;

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
