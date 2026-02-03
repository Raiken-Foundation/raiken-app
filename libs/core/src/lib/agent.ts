import { streamText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { CodeGraphDB } from './db';
import { fullAstToSearchableText } from './ast-parser';
import { EmbeddingsGenerator } from './embeddings';
import { EntryPointDetector } from './entry-point-detector';
import { buildSystemPrompt, type ContextData, NO_CONTEXT_HELP_MESSAGE } from './prompt-templates';
import { formatDOMContext, type DOMContext } from './dom-capture';
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
 * Gather context from code graph using semantic search
 */
export async function gatherContext(
  prompt: string,
  projectPath: string,
  fileContext?: string[]
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
      // Use default
    }
  }

  const files: ContextData['files'] = [];
  let totalTokens = 0;
  const TOKEN_LIMIT = 15000; // Reserve space for prompt structure
  
  if (fileContext && fileContext.length > 0) {
    for (const filePath of fileContext) {      
      // Try as relative path first (most common case from orchestrator)
      let file = db.getFileByRelativePath(filePath);      
      if (!file) {
        // Fallback to absolute path
        file = db.getFile(filePath);
      }
      
      if (file?.ast) {
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
        console.warn(`⚠️  File not found in DB or missing AST: ${filePath}`);
        if (file) {
          console.warn(`⚠️  File found but ast is: ${file.ast ? 'present' : 'missing'}`);
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
      if (!file?.ast) continue;

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
      const errorMsg = 'Error: OPENROUTER_API_KEY not found. Please set it in your .env file or raiken.config.json';
      console.error('❌', errorMsg);
      yield errorMsg;
      return;
    }

    console.log('✅ API Key found, length:', config.apiKey.length);

    // Gather context for test generation
    console.log('🔍 Gathering context from code graph...');
    const context = await gatherContext(userPrompt, projectPath, fileContext);

    if (context.files.length === 0) {
      console.log('💡 Providing helpful guidance instead of error');
      yield NO_CONTEXT_HELP_MESSAGE;
      return;
    }

    console.log(`✓ Found ${context.files.length} relevant files (${context.totalTokens} tokens)`);

    // Build system prompt with conversation history
    let systemPrompt = buildSystemPrompt(context, userPrompt);
    
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