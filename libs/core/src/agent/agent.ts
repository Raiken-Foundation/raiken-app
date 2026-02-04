import { streamText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { ChatOpenAI } from '@langchain/openai';
import { createAgentGraph } from './graph/graph';
import { buildSummary } from './graph/utils';
import type { AgentIntent } from './graph/utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { CodeGraphDB } from '../database/db';
import { fullAstToSearchableText } from '../analysis/ast-parser';
import { EmbeddingsGenerator } from '../database/embeddings';
import { EntryPointDetector } from '../analysis/entry-points';
import {
  buildSystemPrompt,
  buildExplorationPrompt,
  buildAgentClassifierPrompt,
  type ContextData,
  type MemoryContext,
  NO_CONTEXT_HELP_MESSAGE
} from './prompts';
import { formatDOMContext, type DOMContext } from '../browser/dom-capture';
import { ProjectContext } from '../analysis/project-context';
import { AgentMemory } from './memory';
import type { ParsedFile } from '../types';

/**
 * Configuration for AI agent
 */
export interface AgentConfig {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Options for test generation
 */
export interface GenerateTestOptions {
  userPrompt: string;
  projectPath: string;
  fileContext?: string[]; // Optional specific files to focus on
  conversationHistory?: Array<{ role: string; content: string }>; // Conversation context
  domContext?: DOMContext; // Live DOM context for accurate selectors
  config?: AgentConfig;
}

/**
 * Get configuration from environment and raiken.config.json
 */
export function loadAgentConfig(projectPath: string, override?: AgentConfig): AgentConfig {
  const defaults: AgentConfig = {
    model: 'anthropic/claude-sonnet-4.5',
    baseURL: 'https://openrouter.ai/api/v1',
    maxTokens: 4000,
    temperature: 0.7,
  };

  // Load from raiken.config.json if exists
  const configPath = path.join(projectPath, 'raiken.config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.ai) {
        defaults.model = config.ai.model || defaults.model;
        defaults.apiKey = config.ai.apiKey;
      }
    } catch (error) {
      console.warn('Failed to load raiken.config.json:', error);
    }
  }

  // Environment variables override config file
  if (process.env['OPENROUTER_API_KEY']) {
    defaults.apiKey = process.env['OPENROUTER_API_KEY'];
  }
  if (process.env['OPENROUTER_MODEL']) {
    defaults.model = process.env['OPENROUTER_MODEL'];
  }
  if (process.env['OPENROUTER_BASE_URL']) {
    defaults.baseURL = process.env['OPENROUTER_BASE_URL'];
  }

  // Apply overrides
  return { ...defaults, ...override };
}

/**
 * Options for gathering context
 */
export interface GatherContextOptions {
  prompt: string;
  projectPath: string;
  fileContext?: string[];
  /** Files that have changed (from orchestrator) */
  changedFiles?: string[];
}

/**
 * Gather context from code graph using semantic search
 * 
 * Uses ProjectContext's cached keyword index for fast file discovery.
 */
export async function gatherContext(
  prompt: string,
  projectPath: string,
  fileContext?: string[],
  changedFiles?: string[]
): Promise<ContextData> {
  const db = new CodeGraphDB(projectPath);

  // Load config for test directory
  const configPath = path.join(projectPath, 'raiken.config.json');
  let testDirectory = 'e2e';
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      testDirectory = config.testDirectory || testDirectory;
    } catch {
      // Config not found, use default
    }
  }

  const files: ContextData['files'] = [];
  let totalTokens = 0;
  const TOKEN_LIMIT = 15000; // Reserve space for prompt structure
  
  // Use ProjectContext for cached file discovery (fast, no rescanning)
  let intelligentFiles: string[] = [];
  try {
    const projectContext = ProjectContext.getInstance(projectPath);
    
    // Validate cache and refresh if needed
    const validation = await projectContext.ensureFreshContext(prompt, changedFiles);
    if (!validation.isValid) {
      console.log(`🔄 Cache refreshed: ${validation.reason}`);
    }
    
    // Use cached context for file discovery
    intelligentFiles = projectContext.findRelevantFiles(prompt, 10);
    if (intelligentFiles.length > 0) {
      console.log(`⚡ ProjectContext suggests: ${intelligentFiles.slice(0, 3).join(', ')}${intelligentFiles.length > 3 ? '...' : ''}`);
    }
  } catch (err) {
    console.warn('ProjectContext search failed:', err);
  }
  
  // Add entry points for baseline context
  let entryPointFiles: string[] = [];
  try {
    const entryPoints = db.getEntryPoints();
    entryPointFiles = entryPoints.map((ep) => path.relative(projectPath, ep.file_path));
  } catch {
    // Entry points unavailable
  }

  // Fallback baseline entry files
  const baselineFiles = ["src/main.tsx", "src/App.tsx"];
  for (const candidate of baselineFiles) {
    const absolute = path.join(projectPath, candidate);
    if (fs.existsSync(absolute)) {
      entryPointFiles.push(candidate);
    }
  }

  // Merge intelligent suggestions with explicit file context
  const allFileContext = [
    ...(fileContext || []),
    ...intelligentFiles,
    ...entryPointFiles
  ];
  
  // Process explicit file context and intelligent suggestions
  if (allFileContext.length > 0) {
    for (const filePath of allFileContext) {
      // Skip if we already have this file from cache
      if (files.some(f => f.path === filePath)) continue;      
      // Try as relative path first (most common case from orchestrator)
      let file = db.getFileByRelativePath(filePath);      
      if (!file) {
        // Fallback to absolute path
        file = db.getFile(filePath);
      }
      
      if (file?.ast) {
        // Use parsed AST for rich context
        const ast = JSON.parse(file.ast);
        const searchableText = fullAstToSearchableText(ast, file.relative_path);
        const estimatedTokens = searchableText.length / 4;

        if (totalTokens + estimatedTokens > TOKEN_LIMIT) break;

        const parsed: ParsedFile = JSON.parse(file.parsed_ast);
        files.push({
          path: file.relative_path,
          functions: parsed.functions || [],
          classes: parsed.classes || [],
          imports: parsed.imports || [],
          fullContext: searchableText.slice(0, 3000),
          relevanceScore: 1.0,
        });

        totalTokens += estimatedTokens;
      } else {
        // Fallback: Try to read raw file content from disk
        const absolutePath = path.isAbsolute(filePath) 
          ? filePath 
          : path.join(projectPath, filePath);
        
        if (fs.existsSync(absolutePath)) {
          try {
            const rawContent = fs.readFileSync(absolutePath, 'utf-8');
            const estimatedTokens = rawContent.length / 4;
            
            if (totalTokens + estimatedTokens > TOKEN_LIMIT) break;
            
            console.log(`📄 Using raw file content (no AST): ${filePath}`);
            files.push({
              path: filePath,
              functions: [],
              classes: [],
              imports: [],
              fullContext: rawContent.slice(0, 5000), // Larger slice for raw content
              relevanceScore: 0.8,
            });
            
            totalTokens += estimatedTokens;
          } catch (err) {
            console.warn(`⚠️  Failed to read file: ${filePath}`, err);
          }
        } else {
          console.warn(`⚠️  File not found: ${filePath}`);
        }
      }
    }
  } else {
    console.log(`📁 No fileContext provided, will use semantic search only`);
  }

  // Use semantic search to find relevant files
  try {
    // Generate embedding for the prompt
    const embGen = EmbeddingsGenerator.getInstance();
    await embGen.initialize();
    const queryEmbedding = await embGen.generateEmbedding(prompt);

    const results = db.searchSimilar(queryEmbedding, 10);

    for (const result of results) {
      // Skip if we already have this file
      if (files.some(f => f.path === result.filePath)) continue;

      const file = db.getFileByRelativePath(result.filePath);
      
      if (file?.ast) {
        // Parse full AST for rich context
        const ast = JSON.parse(file.ast);
        const searchableText = fullAstToSearchableText(ast, file.relative_path);

        // Estimate tokens (rough: 1 token ≈ 4 characters)
        const estimatedTokens = searchableText.length / 4;

        // Stop if we exceed budget
        if (totalTokens + estimatedTokens > TOKEN_LIMIT) break;

        const parsed: ParsedFile = JSON.parse(file.parsed_ast);
        files.push({
          path: file.relative_path,
          functions: parsed.functions || [],
          classes: parsed.classes || [],
          imports: parsed.imports || [],
          fullContext: searchableText.slice(0, 3000), // Max per file
          relevanceScore: result.similarity,
        });

        totalTokens += estimatedTokens;
      } else {
        // Fallback: Try to read raw file content from disk
        const absolutePath = path.join(projectPath, result.filePath);
        
        if (fs.existsSync(absolutePath)) {
          try {
            const rawContent = fs.readFileSync(absolutePath, 'utf-8');
            const estimatedTokens = rawContent.length / 4;
            
            if (totalTokens + estimatedTokens > TOKEN_LIMIT) break;
            
            console.log(`📄 Using raw file content from search (no AST): ${result.filePath}`);
            files.push({
              path: result.filePath,
              functions: [],
              classes: [],
              imports: [],
              fullContext: rawContent.slice(0, 5000),
              relevanceScore: result.similarity * 0.9, // Slightly lower score for raw content
            });
            
            totalTokens += estimatedTokens;
          } catch {
            // File unreadable
          }
        }
      }
    }
  } catch (error) {
    console.warn('Semantic search failed:', error);
    // Continue with whatever files we have
  }

  db.close();

  // Detect project type using EntryPointDetector
  const detector = new EntryPointDetector(projectPath);
  const framework = detector.detectFramework();
  const projectType = framework 
    ? framework.charAt(0).toUpperCase() + framework.slice(1) // Capitalize
    : 'Generic TypeScript/JavaScript';

  return {
    files,
    projectType,
    testDirectory,
    totalTokens,
  };
}

/**
 * Generate test using AI streaming
 * Note: This should be called via the orchestrator for proper routing
 */
export async function* generateTest(
  options: GenerateTestOptions
): AsyncGenerator<string, void, unknown> {
  try {
    const { userPrompt, projectPath, fileContext, conversationHistory, domContext, config: configOverride } = options;

    // Load configuration
    const config = loadAgentConfig(projectPath, configOverride);

    // Validate API key
    if (!config.apiKey) {
      console.error('❌ OPENROUTER_API_KEY not found');
      yield '⚠️ **API Key Required**\n\n';
      yield 'The OPENROUTER_API_KEY environment variable is not configured.\n\n';
      yield 'To fix this:\n';
      yield '1. Get an API key from [OpenRouter](https://openrouter.ai/keys)\n';
      yield '2. Create a `.env` file in your project root with:\n';
      yield '   ```\n   OPENROUTER_API_KEY=sk-or-v1-your-key-here\n   ```\n';
      yield '3. Restart Raiken\n';
      return;
    }

    console.log('✅ API Key found, length:', config.apiKey.length);

    // Gather context for test generation
    console.log('🔍 Gathering context from code graph...');
    const context = await gatherContext(userPrompt, projectPath, fileContext);

    // If we have no files AND no DOM context, provide helpful guidance
    if (context.files.length === 0 && !domContext) {
      console.log('💡 No file context or DOM context available');
      yield NO_CONTEXT_HELP_MESSAGE;
      return;
    }

    // Log what context we have
    if (context.files.length > 0) {
      console.log(`✓ Found ${context.files.length} relevant files (${context.totalTokens} tokens)`);
    } else {
      console.log('📄 No file context, but DOM context available - proceeding with DOM-only test generation');
    }

    // Get memory context for prompt enrichment
    let memoryContext: MemoryContext | undefined;
    try {
      const memory = AgentMemory.getInstance(projectPath);
      if (memory.isInitialized()) {
        memoryContext = memory.buildPromptContext();
        if (memoryContext.successfulSelectors.length > 0 || memoryContext.selectorStrategy) {
          console.log(`🧠 Memory context: ${memoryContext.successfulSelectors.length} known selectors, strategy=${memoryContext.selectorStrategy || 'default'}`);
        }
      }
    } catch (err) {
      console.warn('Failed to load memory context:', err);
    }

    // Build system prompt with memory context
    let systemPrompt = buildSystemPrompt(context, userPrompt, 'golden-v1', memoryContext);
    
    // Add DOM context if available
    if (domContext) {
      console.log(`🌐 Adding DOM context: ${domContext.interactiveElements.length} elements, ${domContext.formFields.length} form fields`);
      const domContextStr = formatDOMContext(domContext);
      systemPrompt = `${systemPrompt}

${domContextStr}`;
    }
    
    // Add conversation history context if available
    if (conversationHistory && conversationHistory.length > 0) {
      const historyText = conversationHistory
        .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
        .join('\n\n');
      
      systemPrompt = `[CONVERSATION CONTEXT]
The following is the conversation history for context:

${historyText}

---

${systemPrompt}

Note: The user's current request may reference files or concepts discussed earlier in the conversation. Use this context to provide relevant responses.`;
      
      console.log('💬 Added conversation history:', conversationHistory.length, 'messages');
    }
    
    console.log('📝 System prompt length:', systemPrompt.length, 'characters');

    // Initialize OpenRouter client
    const openrouter = createOpenRouter({
      apiKey: config.apiKey,
    });

    console.log('🌐 Using model:', config.model || 'anthropic/claude-sonnet-4.5');

    // Stream the response
    console.log('🤖 Generating test with AI...');

    try {
      const result = await streamText({
        model: openrouter.chat(config.model || 'anthropic/claude-sonnet-4.5'),
        prompt: systemPrompt,
        temperature: config.temperature,
      });

      console.log('📡 Streaming chunks to client...');
      let chunkCount = 0;

      // Stream chunks as they arrive
      for await (const chunk of result.textStream) {
        chunkCount++;
        if (chunkCount <= 3 || chunkCount % 10 === 0) {
          console.log(`📦 Chunk ${chunkCount}: ${chunk.slice(0, 50)}...`);
        }
        yield chunk;
      }

      console.log(`✓ Test generation complete (${chunkCount} chunks)`);
    } catch (error) {
      const errorMsg = `Error: AI generation failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error('❌', errorMsg);
      yield errorMsg;
    }
  } catch (error) {
    const errorMsg = `Error: ${error instanceof Error ? error.message : String(error)}`;
    console.error('❌ Unexpected error in generateTest:', errorMsg);
    yield errorMsg;
  }
}

/**
 * Generate test and return complete result (non-streaming)
 */
export async function generateTestComplete(
  options: GenerateTestOptions
): Promise<string> {
  let fullText = '';
  for await (const chunk of generateTest(options)) {
    fullText += chunk;
  }
  return fullText;
}

// ============================================================================
// Tool-Based Agent (New Architecture)
// ============================================================================

import { createAgentTools, type ToolResult, type HITLAction, type AutonomySettings } from './tools';

/**
 * Load autonomy settings from raiken.config.json
 */
function loadAutonomySettings(projectPath: string): AutonomySettings {
  const defaults: AutonomySettings = {
    autoSaveTests: false,
    autoRunTests: false,
    autoCorrect: 'suggest',
    autoLearn: 'confirm',
  };

  const configPath = path.join(projectPath, 'raiken.config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.autonomy) {
        return { ...defaults, ...config.autonomy };
      }
    } catch {
      // Config parse failed
    }
  }

  return defaults;
}

/**
 * Options for the tool-based agent
 */
export interface ToolAgentOptions {
  userPrompt: string;
  projectPath: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  config?: AgentConfig;
  /** Callback when a tool requires HITL confirmation */
  onHITL?: (action: HITLAction) => Promise<boolean>;
  /** Callback for tool call events (for UI feedback) */
  onToolCall?: (toolName: string, args: unknown) => void;
  /** Callback for tool result events */
  onToolResult?: (toolName: string, result: ToolResult) => void;
}

/**
 * Result of a tool-based agent run
 */
export interface ToolAgentResult {
  text: string;
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
  hitlActions: HITLAction[];
}

/**
 * Run the tool-based agent using LangGraph.
 */
export async function* runToolAgent(
  options: ToolAgentOptions
): AsyncGenerator<string, ToolAgentResult, unknown> {
  const { 
    userPrompt, 
    projectPath, 
    conversationHistory, 
    config: configOverride,
    onToolCall,
    onToolResult,
  } = options;

  // Load configuration
  const config = loadAgentConfig(projectPath, configOverride);

  // Validate API key
  if (!config.apiKey) {
    yield '⚠️ **API Key Required**\n\n';
    yield 'The OPENROUTER_API_KEY environment variable is not configured.\n\n';
    return {
      text: '',
      toolCalls: [],
      hitlActions: [],
    };
  }

  console.log('🤖 Running LangGraph agent...');
  console.log('📝 User prompt:', userPrompt.slice(0, 100) + (userPrompt.length > 100 ? '...' : ''));

  const toolCallsLog: Array<{ name: string; args: unknown; result: unknown }> = [];
  const hitlActions: HITLAction[] = [];
  const respondMessages: string[] = [];
  let fullText = '';

  try {
    const autonomy = loadAutonomySettings(projectPath);
    const tools = createAgentTools({ projectPath, autonomy });
    const toolMap = tools as Record<string, { execute?: (args: unknown) => Promise<ToolResult> }>;

    const callTool = async (toolName: string, args: unknown): Promise<ToolResult> => {
      onToolCall?.(toolName, args);
      let result: ToolResult;
      if (toolMap[toolName]?.execute) {
        result = await toolMap[toolName]!.execute!(args);
      } else {
        result = { success: true, message: `${toolName} invoked` };
      }
      toolCallsLog.push({ name: toolName, args, result });
      if (result?.hitlRequired && result.hitlAction) {
        hitlActions.push(result.hitlAction);
      }
      if (toolName === "respond" && result?.message) {
        respondMessages.push(result.message);
      }
      onToolResult?.(toolName, result);
      return result;
    };

    const model = new ChatOpenAI({
      apiKey: config.apiKey,
      model: config.model || "anthropic/claude-sonnet-4.5",
      temperature: config.temperature ?? 0.7,
      configuration: {
        baseURL: config.baseURL || "https://openrouter.ai/api/v1",
      },
    });

    const getMemoryContext = () => {
      try {
        const memory = AgentMemory.getInstance(projectPath);
        if (memory.isInitialized()) {
          return memory.buildPromptContext();
        }
      } catch {
        // Memory load failed
      }
      return undefined;
    };

    const getActiveIntent = (): AgentIntent | null => {
      try {
        const memory = AgentMemory.getInstance(projectPath);
        return memory.getActiveIntent();
      } catch {
        return null;
      }
    };

    const setActiveIntent = (intent: AgentIntent) => {
      try {
        const memory = AgentMemory.getInstance(projectPath);
        memory.setActiveIntent(intent);
      } catch {
        // Ignore memory failures
      }
    };

    const getGoalState = () => {
      try {
        const memory = AgentMemory.getInstance(projectPath);
        return memory.getGoalState();
      } catch {
        return {
          activeGoal: null,
          targetFeature: null,
          targetUrl: null,
          missingContext: [],
          nextTool: null,
        };
      }
    };

    const setGoalState = (state: {
      goal?: string | null;
      targetFeature?: string | null;
      targetUrl?: string | null;
      missingContext?: string[];
      nextTool?: string | null;
    }) => {
      try {
        const memory = AgentMemory.getInstance(projectPath);
        memory.setGoalState({
          activeGoal: state.goal,
          targetFeature: state.targetFeature,
          targetUrl: state.targetUrl,
          missingContext: state.missingContext,
          nextTool: state.nextTool,
        });
      } catch {
        // Ignore memory failures
      }
    };

    const graph = createAgentGraph({
      callTool,
      projectPath,
      model,
      gatherContext,
      buildSystemPrompt,
      buildExplorationPrompt,
      buildAgentClassifierPrompt,
      getMemoryContext,
      getActiveIntent,
      setActiveIntent,
      getGoalState,
      setGoalState,
    });

    const finalState = await graph.invoke({
      userPrompt,
      conversationHistory: conversationHistory || [],
    });

    for (const msg of respondMessages) {
      yield msg + "\n";
      fullText += msg + "\n";
    }

    if (finalState.awaitUserMessage) {
      const userMessage = finalState.awaitUserMessage;
      yield `\n\n${userMessage}`;
      fullText += `\n\n${userMessage}`;
      console.log("⏸️ Agent awaiting user input");
      return {
        text: fullText,
        toolCalls: toolCallsLog,
        hitlActions,
      };
    }

    const summary = finalState.summary || buildSummary(finalState);
    await callTool("done", {
      summary,
      pagesVisited: finalState.pagesVisited || [],
    });

    yield `\n\n**Summary:**\n${summary}`;
    fullText += `\n\n**Summary:**\n${summary}`;

    if (finalState.pagesVisited && finalState.pagesVisited.length > 0) {
      const pagesText = `\n\n**Pages Visited:**\n${finalState.pagesVisited.map((p) => `- ${p}`).join("\n")}`;
      yield pagesText;
      fullText += pagesText;
    }

    console.log(`✅ Agent complete: ${toolCallsLog.length} tool calls, ${hitlActions.length} HITL actions`);

    return {
      text: fullText,
      toolCalls: toolCallsLog,
      hitlActions,
    };

  } catch (error) {
    const errorMsg = `Error: ${error instanceof Error ? error.message : String(error)}`;
    console.error('❌ Tool agent error:', errorMsg);
    yield `\n\n⚠️ ${errorMsg}`;
    
    return {
      text: fullText + `\n\n⚠️ ${errorMsg}`,
      toolCalls: toolCallsLog,
      hitlActions,
    };
  }
}