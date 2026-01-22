import type { OrchestratorContext, Intent, PageStateAnalysis } from './types';
import type { DOMContext } from '../dom-capture';
import { resolveUrl, checkCachedDom } from './actions';

export interface IntentResult {
  control: 'stop' | 'go' | 'retry' | 'continue' | 'refine' | 'clarify' | 'cancel' | 'new';
  intent: Intent;
  nextTool: 'domCapture' | 'codeSearch' | 'testGen' | 'explain' | 'none';
  files: string[];
  effectivePrompt: string;
  reasoning: string;
}

export async function extractFilesActor(context: OrchestratorContext): Promise<string[]> {
  const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
  const { generateObject } = await import('ai');
  const { z } = await import('zod');
  const { lookupFilesTool } = await import('../tools');
  
  const openrouter = createOpenRouter({ apiKey: context.config.apiKey });
  
  // Extract @ mentions from the user prompt (explicit mentions)
  const explicitMentions: string[] = [];
  const mentionRegex = /@([\w/.-]+)/g;
  let match;
  while ((match = mentionRegex.exec(context.userPrompt)) !== null) {
    explicitMentions.push(match[1]);
  }
  
  // Use AI to extract file names mentioned naturally (without @)
  let naturalMentions: string[] = [];
  try {
    const fileExtractionResult = await generateObject({
      model: openrouter.chat(context.config.model),
      schema: z.object({
        files: z.array(z.string()).describe('File names or paths mentioned in the user message'),
      }),
      prompt: `Extract any file names or paths mentioned in this user message:

"${context.userPrompt}"

Look for:
- File names like "Counter.tsx", "LoginForm.tsx", "utils.ts"
- Paths like "src/components/Button.tsx", "lib/helpers.js"
- Component names that might be files (e.g., "Counter component" → "Counter.tsx" or "Counter.ts")
- Any reference to specific code files

Return ONLY the file names/paths, without explanations. If no files are mentioned, return an empty array.`,
      temperature: 0.3,
    });
    
    naturalMentions = fileExtractionResult.object.files;
    if (naturalMentions.length > 0) {
      console.log(`🤖 AI extracted file mentions: ${naturalMentions.join(', ')}`);
    }
  } catch (error) {
    console.warn('File extraction failed, continuing with explicit mentions only:', error);
  }
  
  // Combine all mentions
  const allMentions = [...new Set([...explicitMentions, ...naturalMentions, ...context.fileContext])];
  
  // Lookup mentioned files
  let resolvedFiles: string[] = [];
  if (allMentions.length > 0) {
    console.log(`🔍 Looking up files: ${allMentions.join(', ')}`);
    
    for (const filePattern of allMentions) {
      const result = await lookupFilesTool(context.projectPath, filePattern);
      if (result.files.length > 0) {
        resolvedFiles.push(...result.files);
        console.log(`✓ Found: ${result.files.join(', ')}`);
      } else {
        console.log(`⚠️  No matches for: ${filePattern}`);
      }
    }
    resolvedFiles = [...new Set(resolvedFiles)]; // Deduplicate
  }
  
  return resolvedFiles;
}

export async function classifyIntentActor(context: OrchestratorContext): Promise<IntentResult> {
  const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
  const { generateObject } = await import('ai');
  const { z } = await import('zod');
  const { buildIntentClassificationPrompt } = await import('../prompt-templates');
  
  const openrouter = createOpenRouter({ apiKey: context.config.apiKey });
  
  // Build context for intent detection
  let promptContext = `Latest user message: "${context.userPrompt}"\n`;
  if (context.fileContext.length > 0) {
    promptContext += `\nFile context hints: ${context.fileContext.join(', ')}\n`;
  }
  if (context.conversationHistory.length > 0) {
    const recentHistory = context.conversationHistory.slice(-6);
    promptContext += `\nRecent conversation:\n${recentHistory.map(m => `${m.role}: ${m.content.substring(0, 200)}`).join('\n')}\n`;
  }
  
  const intentAnalysis = await generateObject({
    model: openrouter.chat(context.config.model),
    schema: z.object({
      control: z.enum(['stop', 'go', 'retry', 'continue', 'refine', 'clarify', 'cancel', 'new'])
        .describe('Control intent for the request'),
      intent: z.enum(['test-generation', 'chat', 'help']).describe('The user intent'),
      nextTool: z.enum(['domCapture', 'codeSearch', 'testGen', 'explain', 'none'])
        .describe('Best next tool to use, if any'),
      reasoning: z.string().describe('Brief explanation of the decision'),
      effectivePrompt: z.string().describe('The task prompt to use if this is a retry/continue/refine; otherwise the latest user prompt'),
      shouldGenerateTest: z.boolean().describe('Whether to generate tests'),
      filesToTest: z.array(z.string()).describe('Files to generate tests for (if applicable)'),
    }),
    prompt: buildIntentClassificationPrompt(promptContext),
    temperature: 0.4,
  });

  console.log(`💭 Reasoning: ${intentAnalysis.object.reasoning}`);
  
  return {
    control: intentAnalysis.object.control as IntentResult['control'],
    intent: intentAnalysis.object.intent as Intent,
    nextTool: intentAnalysis.object.nextTool as IntentResult['nextTool'],
    files: intentAnalysis.object.filesToTest,
    effectivePrompt: intentAnalysis.object.effectivePrompt,
    reasoning: intentAnalysis.object.reasoning,
  };
}

export async function resolveUrlActor(context: OrchestratorContext): Promise<string | null> {
  return resolveUrl(
    context.userPrompt,
    context.conversationHistory,
    context.projectPath
  );
}

export async function captureDomActor(context: OrchestratorContext): Promise<DOMContext> {
  const { captureDomTool } = await import('../tools');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  
  if (context.cancelRequested || context.metaIntent === 'stop' || context.metaIntent === 'cancel') {
    throw new Error('Cancelled');
  }
  
  if (!context.appUrl) {
    throw new Error('No URL provided for DOM capture');
  }
  
  // Check cache first
  const cached = checkCachedDom(context.projectPath, context.appUrl);
  if (cached) {
    return cached;
  }
  
  // Try to load storageStatePath from config
  let storageStatePath: string | undefined;
  try {
    const configPath = path.join(context.projectPath, 'raiken.config.json');
    const configContent = await fs.readFile(configPath, 'utf-8');
    const raikenConfig = JSON.parse(configContent);
    storageStatePath = raikenConfig.storageStatePath;
    if (storageStatePath) {
      console.log(`🔐 Using storage state: ${storageStatePath}`);
    }
  } catch {
    // Config file doesn't exist or is invalid
  }
  
  console.log(`🌐 Capturing DOM from: ${context.appUrl}`);
  const result = await captureDomTool(context.appUrl, { storageStatePath });
  
  if (!result.context) {
    throw new Error(result.message);
  }
  
  return result.context;
}

// ============================================================================
// Page Analysis Actor
// ============================================================================

export async function analyzePageActor(context: OrchestratorContext): Promise<PageStateAnalysis> {
  const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
  const { generateObject } = await import('ai');
  const { z } = await import('zod');
  const { buildPageStateAnalysisPrompt } = await import('../prompt-templates');
  
  if (!context.domContext) {
    return {
      matchesIntent: true,
      currentPageType: 'unknown',
      canProceed: true,
      reasoning: 'No DOM context available, proceeding with available context',
    };
  }
  
  const openrouter = createOpenRouter({ apiKey: context.config.apiKey });
  
  // Build a summary of the DOM for analysis
  const domSummary = `
Page Title: ${context.domContext.title}
URL: ${context.domContext.url}

Interactive Elements (${context.domContext.interactiveElements.length}):
${context.domContext.interactiveElements.slice(0, 20).map(el => 
  `- ${el.role || el.tagName}: "${el.name || el.text || 'unnamed'}"`
).join('\n')}

Form Fields (${context.domContext.formFields.length}):
${context.domContext.formFields.map(f => `- ${f.name} (${f.type}${f.required ? ', required' : ''})`).join('\n')}
`;

  const targetFunctionality = context.resolvedFiles.join(', ') || 'requested functionality';
  
  const result = await generateObject({
    model: openrouter.chat(context.config.model),
    schema: z.object({
      matchesIntent: z.boolean().describe('Does this page contain the functionality the user wants to test?'),
      currentPageType: z.string().describe('A factual description of what type of page this is'),
      canProceed: z.boolean().describe('Can we generate meaningful tests for the requested functionality on this page?'),
      reasoning: z.string().describe('Brief factual explanation of what you observed'),
    }),
    prompt: buildPageStateAnalysisPrompt(domSummary, context.userPrompt, targetFunctionality),
    temperature: 0.3,
  });
  
  console.log(`📊 Page analysis: ${result.object.currentPageType}`);
  console.log(`📊 Matches intent: ${result.object.matchesIntent}`);
  
  return result.object;
}
