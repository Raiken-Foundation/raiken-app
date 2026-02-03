import { createActor } from 'xstate';
import { orchestratorMachine } from './machine';
import type { OrchestratorInput, OrchestratorContext } from './types';
import { recordAction } from './actions';

export { getSessionStats, clearSession } from './session';
export type { OrchestratorInput } from './types';

/**
 * Options for running the orchestrator
 */
export interface RunOrchestratorOptions {
  userPrompt: string;
  projectPath: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  fileContext?: string[];
}

/**
 * Run the orchestrator state machine and stream responses
 * 
 * This is the main entry point for the orchestrator.
 * It uses XState to manage state transitions and yields response chunks.
 */
export async function* runOrchestrator(
  options: RunOrchestratorOptions
): AsyncGenerator<string, void, unknown> {
  const input: OrchestratorInput = {
    userPrompt: options.userPrompt,
    projectPath: options.projectPath,
    conversationHistory: options.conversationHistory || [],
    fileContext: options.fileContext || [],
  };

  console.log('🎯 XState Orchestrator: Starting...');
  console.log(`📝 Prompt: "${options.userPrompt.slice(0, 50)}..."`);

  // Create and start the actor
  const actor = createActor(orchestratorMachine, {
    input: input,
  });
  
  // Promise that resolves when we reach the streaming state
  const streamingPromise = new Promise<OrchestratorContext>((resolve, reject) => {
    const subscription = actor.subscribe((snapshot) => {
      if (snapshot.matches('streaming')) {
        subscription.unsubscribe();
        resolve(snapshot.context);
      }
    });
    
    // Timeout after 60 seconds
    setTimeout(() => {
      subscription.unsubscribe();
      reject(new Error('Orchestrator timeout'));
    }, 60000);
  });

  actor.start();
  actor.send({ type: 'RECEIVE_MESSAGE', input });

  try {
    // Wait for the machine to reach the streaming state
    const finalContext = await streamingPromise;
    
    console.log(`📍 Reached streaming state: type=${finalContext.streamType}`);

    // Handle different stream types
    if (finalContext.streamType === 'test') {
      // Generate test using the agent
      yield* streamTestGeneration(finalContext);
    } else if (finalContext.streamType === 'chat') {
      // Stream chat response
      yield* streamChatResponse(finalContext);
    } else if (finalContext.streamType === 'error') {
      // Stream error/help response
      yield* streamErrorResponse(finalContext);
    } else {
      yield 'Error: Unknown stream type';
    }

    // Send reset to prepare for next turn
    actor.send({ type: 'RESET' });
  } catch (error) {
    console.error('Orchestrator error:', error);
    yield `Error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    actor.stop();
  }
}

/**
 * Stream test generation response
 */
async function* streamTestGeneration(
  context: OrchestratorContext
): AsyncGenerator<string> {
  const { generateTest } = await import('../agent');
  recordAction(context.projectPath, 'testGen');
  
  yield* generateTest({
    userPrompt: context.userPrompt,
    projectPath: context.projectPath,
    fileContext: context.resolvedFiles,
    conversationHistory: context.conversationHistory,
    domContext: context.domContext || undefined,
  });
}

/**
 * Stream chat response
 */
async function* streamChatResponse(
  context: OrchestratorContext
): AsyncGenerator<string> {
  if (context.metaIntent === 'stop' || context.metaIntent === 'cancel') {
    yield 'Okay—stopping here. Tell me when you want to continue.';
    return;
  }

  const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
  const { streamText } = await import('ai');
  const { CodeGraphDB } = await import('../db');
  
  const openrouter = createOpenRouter({ apiKey: context.config.apiKey });
  
  let chatPrompt = `You are Raiken, an AI assistant specialized in generating Playwright tests. You can also help users understand their code, explain functionality, and discuss testing strategies.

Control intent: ${context.metaIntent || 'new'}
User message: "${context.userPrompt}"

Guidance:
- If control intent is "stop" or "cancel": acknowledge and stop.
- If control intent is "clarify": ask a concise, targeted follow-up question.
- If control intent is "retry" or "continue": proceed with the same task.
- If control intent is "refine": incorporate the user's refinement into the task.
`;

  // If files were resolved, load their content for context
  if (context.resolvedFiles.length > 0) {
    console.log(`📄 Loading file content for chat: ${context.resolvedFiles.join(', ')}`);
    const db = new CodeGraphDB(context.projectPath);
    
    chatPrompt += `\n[RELEVANT FILES]\n`;
    for (const filePath of context.resolvedFiles.slice(0, 3)) {
      let fileContent: string | null = null;
      
      const file = db.getFileByRelativePath(filePath);
      if (file?.ast) {
        try {
          const ast = JSON.parse(file.ast);
          const { fullAstToSearchableText } = await import('../ast-parser');
          fileContent = fullAstToSearchableText(ast, file.relative_path);
        } catch (error) {
          console.warn(`Could not parse AST for ${filePath}:`, error);
        }
      }
      
      if (fileContent) {
        chatPrompt += `\nFile: ${filePath}\n${fileContent.slice(0, 3000)}\n`;
      }
    }
    chatPrompt += `\n[END FILES]\n\n`;
    db.close();
  }

  if (context.conversationHistory.length > 0) {
    const historyText = context.conversationHistory
      .slice(-4)
      .map(msg => `${msg.role === 'user' ? 'User' : 'Raiken'}: ${msg.content.substring(0, 150)}`)
      .join('\n');
    chatPrompt += `Recent conversation:\n${historyText}\n\n`;
  }

  chatPrompt += `Instructions:
- If user asks to explain/describe code: Provide a clear, helpful explanation based on the file content above
- If user asks questions about how something works: Explain it clearly and technically
- If user wants to discuss testing: Discuss strategies and offer to generate tests
- If greeting: Greet back warmly
- If help request: Explain how to use Raiken (mention files with @, ask you to generate tests)
- Be helpful, clear, and conversational`;

  const result = await streamText({
    model: openrouter.chat(context.config.model),
    prompt: chatPrompt,
    temperature: 0.7,
  });

  for await (const chunk of result.textStream) {
    yield chunk;
  }
}

/**
 * Stream error/explanation response
 */
async function* streamErrorResponse(
  context: OrchestratorContext
): AsyncGenerator<string> {
  if (context.metaIntent === 'stop' || context.metaIntent === 'cancel') {
    yield 'Okay—stopping here. Tell me when you want to continue.';
    return;
  }

  const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
  const { streamText } = await import('ai');
  
  const openrouter = createOpenRouter({ apiKey: context.config.apiKey });
  
  let errorPrompt = `You are Raiken, an AI assistant that generates Playwright tests.

User message: "${context.userPrompt}"
`;

  // Different error scenarios
  if (!context.appUrl && context.intent === 'test-generation') {
    // No URL provided
    errorPrompt += `
Problem: The user wants to generate tests but didn't provide a URL.

Ask them to include the URL where their app is running. Be brief and helpful.
Examples: "test login at localhost:3000" or "test the counter at http://localhost:8080"`;
  } else if (context.error) {
    // DOM capture failed - but we might still have partial DOM info
    errorPrompt += `
You tried to access: ${context.appUrl}
Error: ${context.errorMessage}
Retry attempts: ${context.retryCount}/${context.maxRetries}
`;
    // Include any DOM context we managed to capture before the error
    if (context.domContext) {
      errorPrompt += `
[PARTIAL DOM CAPTURED BEFORE ERROR]
Page Title: "${context.domContext.title}"
URL: ${context.domContext.url}
Interactive Elements Found: ${context.domContext.interactiveElements.length}
${context.domContext.interactiveElements.slice(0, 15).map(el => 
  `- ${el.role || el.tagName}: "${el.name || el.text || 'unnamed'}" ${el.suggestedSelectors?.[0] ? `(${el.suggestedSelectors[0]})` : ''}`
).join('\n')}
Form Fields: ${context.domContext.formFields.length > 0 
  ? context.domContext.formFields.map(f => `${f.name} (${f.type})`).join(', ')
  : 'none detected'}
[END PARTIAL DOM]
`;
    }
    errorPrompt += `
Explain EXACTLY what happened - the specific error you got. Use the DOM information above to suggest what might have gone wrong (e.g., "I see a login form, maybe authentication is required").`;
  } else if (context.pageAnalysis && !context.pageAnalysis.matchesIntent) {
    // Page mismatch - include comprehensive DOM details
    errorPrompt += `
You visited: ${context.appUrl}
Page title: "${context.domContext?.title}"
What you found: ${context.pageAnalysis.currentPageType}
Analysis: ${context.pageAnalysis.reasoning}

[FULL DOM CONTEXT FOR THIS PAGE]
Interactive Elements (${context.domContext?.interactiveElements?.length || 0}):
${context.domContext?.interactiveElements?.slice(0, 20).map(el => 
  `- ${el.role || el.tagName}: "${el.name || el.text || 'unnamed'}" ${el.suggestedSelectors?.[0] ? `→ selector: ${el.suggestedSelectors[0]}` : ''}`
).join('\n') || 'none'}

Form Fields (${context.domContext?.formFields?.length || 0}):
${context.domContext?.formFields?.map(f => 
  `- ${f.name}: type=${f.type}${f.required ? ' (required)' : ''} ${f.suggestedSelector ? `→ ${f.suggestedSelector}` : ''}`
).join('\n') || 'none'}

Buttons: ${context.domContext?.interactiveElements?.filter(el => el.role === 'button' || el.tagName === 'button').map(el => el.name || el.text).join(', ') || 'none'}
Links: ${context.domContext?.interactiveElements?.filter(el => el.role === 'link' || el.tagName === 'a').slice(0, 5).map(el => el.name || el.text).join(', ') || 'none'}
[END DOM CONTEXT]

Using this DOM information, explain SPECIFICALLY:
1. What page you're actually on (be factual about what you see)
2. Why this doesn't match what the user asked for
3. What steps might be needed (login? different URL? navigation?)
Suggest concrete next steps based on the actual elements you found on the page.`;
  } else {
    // Generic error
    errorPrompt += `
Something went wrong. Explain the situation and ask how to help.`;
  }

  const result = await streamText({
    model: openrouter.chat(context.config.model),
    prompt: errorPrompt,
    temperature: 0.7,
  });

  for await (const chunk of result.textStream) {
    yield chunk;
  }
}

