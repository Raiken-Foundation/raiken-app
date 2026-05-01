import * as fs from "node:fs";
import * as path from "node:path";
import { ChatOpenAI } from "@langchain/openai";
import { streamText } from "ai";
import { fullAstToSearchableText } from "../analysis/ast-parser";
import { EntryPointDetector } from "../analysis/entry-points";
import { ProjectContext } from "../analysis/project-context";
import { type DOMContext, formatDOMContext } from "../browser/dom-capture";
import type { AIProviderId } from "../config/schema";
import { CodeGraphDB } from "../database/db";
import { EmbeddingsGenerator } from "../database/embeddings";
import type { ParsedFile } from "../types";
import { createAIClient, getProvider, resolveAIConfig } from "./ai-providers";
import { createAgentGraph } from "./graph/graph";
import type { AgentIntent } from "./graph/utils";
import { buildSummary } from "./graph/utils";
import { AgentMemory } from "./memory";
import {
    buildAgentClassifierPrompt,
    buildExplorationPrompt,
    buildSystemPrompt,
    type ContextData,
    type MemoryContext,
    NO_CONTEXT_HELP_MESSAGE,
} from "./prompts";

/**
 * Configuration for AI agent
 */
export interface AgentConfig {
    provider?: AIProviderId | string;
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
 * Get configuration from environment and raiken.config.json.
 *
 * Multi-provider aware: defers to {@link resolveAIConfig} which understands
 * every provider in `AI_PROVIDERS` (OpenAI, Anthropic, Google, OpenRouter, …).
 */
export function loadAgentConfig(projectPath: string, override?: AgentConfig): AgentConfig {
    const resolved = resolveAIConfig(projectPath, override);
    return {
        provider: resolved.provider,
        apiKey: resolved.apiKey,
        model: resolved.model,
        baseURL: resolved.baseURL,
        maxTokens: resolved.maxTokens,
        temperature: resolved.temperature,
    };
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
    changedFiles?: string[],
): Promise<ContextData> {
    const db = new CodeGraphDB(projectPath);

    // Load config for test directory
    const configPath = path.join(projectPath, "raiken.config.json");
    let testDirectory = "e2e";
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            testDirectory = config.testDirectory || testDirectory;
        } catch {
            // Config not found, use default
        }
    }

    const files: ContextData["files"] = [];
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
            console.log(
                `⚡ ProjectContext suggests: ${intelligentFiles.slice(0, 3).join(", ")}${intelligentFiles.length > 3 ? "..." : ""}`,
            );
        }
    } catch (err) {
        console.warn("ProjectContext search failed:", err);
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
    const allFileContext = [...(fileContext || []), ...intelligentFiles, ...entryPointFiles];

    // Process explicit file context and intelligent suggestions
    if (allFileContext.length > 0) {
        for (const filePath of allFileContext) {
            // Skip if we already have this file from cache
            if (files.some((f) => f.path === filePath)) continue;
            // Try as relative path first (most common case from orchestrator)
            let file = db.getFileByRelativePath(filePath);
            if (!file) {
                // Fallback to absolute path
                file = db.getFile(filePath);
            }

            if (file?.ast) {
                try {
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
                } catch {
                    console.warn(`Skipping file with corrupt AST data: ${file.relative_path}`);
                }
            } else {
                // Fallback: Try to read raw file content from disk
                const absolutePath = path.isAbsolute(filePath)
                    ? filePath
                    : path.join(projectPath, filePath);

                if (fs.existsSync(absolutePath)) {
                    try {
                        const rawContent = fs.readFileSync(absolutePath, "utf-8");
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
            if (files.some((f) => f.path === result.filePath)) continue;

            const file = db.getFileByRelativePath(result.filePath);

            if (file?.ast) {
                try {
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
                        relevanceScore: result.similarity,
                    });

                    totalTokens += estimatedTokens;
                } catch {
                    console.warn(`Skipping file with corrupt AST data: ${file.relative_path}`);
                }
            } else {
                // Fallback: Try to read raw file content from disk
                const absolutePath = path.join(projectPath, result.filePath);

                if (fs.existsSync(absolutePath)) {
                    try {
                        const rawContent = fs.readFileSync(absolutePath, "utf-8");
                        const estimatedTokens = rawContent.length / 4;

                        if (totalTokens + estimatedTokens > TOKEN_LIMIT) break;

                        console.log(
                            `📄 Using raw file content from search (no AST): ${result.filePath}`,
                        );
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
        console.warn("Semantic search failed:", error);
        // Continue with whatever files we have
    }

    db.close();

    // Detect project type using EntryPointDetector
    const detector = new EntryPointDetector(projectPath);
    const framework = detector.detectFramework();
    const projectType = framework
        ? framework.charAt(0).toUpperCase() + framework.slice(1) // Capitalize
        : "Generic TypeScript/JavaScript";

    // Load site discovery knowledge if available
    let siteKnowledge = null;
    try {
        const { loadSiteKnowledge } = await import("../site-discovery");
        siteKnowledge = await loadSiteKnowledge(projectPath);

        if (siteKnowledge) {
            console.log(
                `🗺️  Site knowledge loaded: ${siteKnowledge.pagesDiscovered} pages discovered`,
            );
        }
    } catch (error) {
        // Site discovery not available or failed - continue without it
        console.debug("Site knowledge not available:", error);
    }

    // Inspect the target project's playwright.config to see if a static
    // baseURL is set. The test-generation prompt branches on this: if a
    // baseURL exists, generated tests use relative paths; if not, they
    // must hardcode the full URL.
    let baseURL: string | null = null;
    try {
        const { readPlaywrightBaseURL } = await import("../testing/playwright-config");
        baseURL = await readPlaywrightBaseURL(projectPath);
        if (baseURL) {
            console.log(`🌐 Playwright baseURL detected: ${baseURL}`);
        }
    } catch (error) {
        console.debug("readPlaywrightBaseURL failed:", error);
    }

    return {
        files,
        projectType,
        testDirectory,
        totalTokens,
        siteKnowledge,
        baseURL,
    };
}

/**
 * Generate test using AI streaming
 * Note: This should be called via the orchestrator for proper routing
 */
export async function* generateTest(
    options: GenerateTestOptions,
): AsyncGenerator<string, void, unknown> {
    try {
        const {
            userPrompt,
            projectPath,
            fileContext,
            conversationHistory,
            domContext,
            config: configOverride,
        } = options;

        // Load configuration
        const config = loadAgentConfig(projectPath, configOverride);

        // Validate API key
        if (!config.apiKey) {
            const provider = getProvider(config.provider);
            const envHint = provider.envVars[0] ?? "AI_API_KEY";
            console.error(`❌ ${envHint} not found`);
            yield "⚠️ **API Key Required**\n\n";
            yield `The ${envHint} environment variable is not configured for **${provider.label}**.\n\n`;
            yield "To fix this:\n";
            if (provider.apiKeyUrl) {
                yield `1. Get an API key from [${provider.label}](${provider.apiKeyUrl})\n`;
            } else {
                yield `1. Get an API key from your ${provider.label} dashboard\n`;
            }
            yield "2. Add it via Settings → AI Provider, or create a `.env` file with:\n";
            yield `   \`\`\`\n   ${envHint}=...\n   \`\`\`\n`;
            yield "3. Restart Raiken\n";
            return;
        }

        console.log("✅ API Key found, length:", config.apiKey.length);

        // Gather context for test generation
        console.log("🔍 Gathering context from code graph...");
        const context = await gatherContext(userPrompt, projectPath, fileContext);

        // If we have no files AND no DOM context, provide helpful guidance
        if (context.files.length === 0 && !domContext) {
            console.log("💡 No file context or DOM context available");
            yield NO_CONTEXT_HELP_MESSAGE;
            return;
        }

        // Log what context we have
        if (context.files.length > 0) {
            console.log(
                `✓ Found ${context.files.length} relevant files (${context.totalTokens} tokens)`,
            );
        } else {
            console.log(
                "📄 No file context, but DOM context available - proceeding with DOM-only test generation",
            );
        }

        // Get memory context for prompt enrichment
        let memoryContext: MemoryContext | undefined;
        try {
            const memory = AgentMemory.getInstance(projectPath);
            if (memory.isInitialized()) {
                memoryContext = memory.buildPromptContext();
                if (
                    memoryContext.successfulSelectors.length > 0 ||
                    memoryContext.selectorStrategy
                ) {
                    console.log(
                        `🧠 Memory context: ${memoryContext.successfulSelectors.length} known selectors, strategy=${memoryContext.selectorStrategy || "default"}`,
                    );
                }
            }
        } catch (err) {
            console.warn("Failed to load memory context:", err);
        }

        // Build system prompt with memory context
        let systemPrompt = buildSystemPrompt(context, userPrompt, "golden-v1", memoryContext);

        // Add DOM context if available
        if (domContext) {
            console.log(
                `🌐 Adding DOM context: ${domContext.interactiveElements.length} elements, ${domContext.formFields.length} form fields`,
            );
            const domContextStr = formatDOMContext(domContext);
            systemPrompt = `${systemPrompt}

${domContextStr}`;
        }

        // Add conversation history context if available
        if (conversationHistory && conversationHistory.length > 0) {
            const historyText = conversationHistory
                .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
                .join("\n\n");

            systemPrompt = `[CONVERSATION HISTORY]
${historyText}

---

${systemPrompt}`;

            console.log("💬 Added conversation history:", conversationHistory.length, "messages");
        }

        console.log("📝 System prompt length:", systemPrompt.length, "characters");

        const resolved = resolveAIConfig(projectPath, config);
        const aiClient = createAIClient(resolved);

        console.log(`🌐 Using ${resolved.provider} → ${resolved.model}`);

        // Stream the response
        console.log("🤖 Generating test with AI...");

        try {
            const result = await streamText({
                model: aiClient.model,
                prompt: systemPrompt,
                temperature: config.temperature,
            });

            console.log("📡 Streaming chunks to client...");
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
            console.error("❌", errorMsg);
            yield errorMsg;
        }
    } catch (error) {
        const errorMsg = `Error: ${error instanceof Error ? error.message : String(error)}`;
        console.error("❌ Unexpected error in generateTest:", errorMsg);
        yield errorMsg;
    }
}

/**
 * Generate test and return complete result (non-streaming)
 */
export async function generateTestComplete(options: GenerateTestOptions): Promise<string> {
    let fullText = "";
    for await (const chunk of generateTest(options)) {
        fullText += chunk;
    }
    return fullText;
}

// ============================================================================
// Tool-Based Agent (New Architecture)
// ============================================================================

import { type AutonomySettings, createAgentTools, type HITLAction, type ToolResult } from "./tools";

/**
 * Load autonomy settings from raiken.config.json
 */
function loadAutonomySettings(projectPath: string): AutonomySettings {
    const defaults: AutonomySettings = {
        autoSaveTests: false,
        autoRunTests: false,
        autoCorrect: "suggest",
        autoLearn: "confirm",
    };

    const configPath = path.join(projectPath, "raiken.config.json");
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
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
    options: ToolAgentOptions,
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
        const provider = getProvider(config.provider);
        const envHint = provider.envVars[0] ?? "AI_API_KEY";
        yield "⚠️ **API Key Required**\n\n";
        yield `Set ${envHint} in your environment, or configure **${provider.label}** in Settings → AI Provider.\n\n`;
        return {
            text: "",
            toolCalls: [],
            hitlActions: [],
        };
    }

    console.log("🤖 Running LangGraph agent...");
    console.log(
        "📝 User prompt:",
        userPrompt.slice(0, 100) + (userPrompt.length > 100 ? "..." : ""),
    );

    const toolCallsLog: Array<{ name: string; args: unknown; result: unknown }> = [];
    const hitlActions: HITLAction[] = [];
    const respondMessages: string[] = [];
    let fullText = "";

    try {
        const autonomy = loadAutonomySettings(projectPath);
        const tools = createAgentTools({ projectPath, autonomy });
        const toolMap = tools as Record<
            string,
            { execute?: (args: unknown) => Promise<ToolResult> }
        >;

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

        const resolved = resolveAIConfig(projectPath, config);
        const model = new ChatOpenAI({
            apiKey: resolved.apiKey,
            model: resolved.model,
            temperature: resolved.temperature,
            maxTokens: resolved.maxTokens,
            configuration: {
                baseURL: resolved.baseURL,
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

        const seedState: Record<string, unknown> = {
            userPrompt,
            conversationHistory: conversationHistory || [],
        };

        // Load paused exploration state and pass it to the graph.
        // The classifyGoal node (LLM) decides whether to restore or discard it.
        try {
            const memory = AgentMemory.getInstance(projectPath);
            const pauseReason = memory.getPreference("paused_reason") || null;

            if (pauseReason) {
                const explorationState = memory.consumeExplorationState();
                memory.setPreference("paused_reason", "");

                seedState["pauseReason"] = pauseReason;
                if (explorationState) {
                    seedState["pendingPagesVisited"] = explorationState.pagesVisited;
                    seedState["pendingCurrentUrl"] = explorationState.currentUrl;
                }
            }
        } catch {
            // Non-critical
        }

        const finalState = await graph.invoke(seedState);

        for (const msg of respondMessages) {
            yield msg + "\n";
            fullText += msg + "\n";
        }

        if (finalState.awaitUserMessage) {
            const userMessage = finalState.awaitUserMessage;

            // If we're paused because saveFile asked for HITL approval, surface
            // the actual test draft + structured action data to the dashboard
            // *before* the await message. Without this the user sees only
            // "Waiting for approval to save e2e/foo.spec.ts." with no preview
            // of what they're about to put on disk — the test content lives in
            // `state.testDraft` and `hitlActions[]`, but neither is streamed.
            //
            // We piggy-back on the existing dashboard <!--HITL:..--> marker so
            // the sidebar can render a rich approval card (code preview,
            // editable path, Approve / Reject / Save-always buttons) instead
            // of a bare prompt.
            const pendingSaveAction = [...hitlActions].reverse().find((a) => a.type === "save");
            if (pendingSaveAction && pendingSaveAction.type === "save") {
                const hitlPayload = {
                    kind: "save_approval" as const,
                    type: "save",
                    title: "Approve test save",
                    message:
                        "Review the generated test below. Approve to save it to disk, edit the path if you want it elsewhere, or reject to discard it.",
                    reasons: [],
                    testCode: pendingSaveAction.testCode,
                    suggestedPath: pendingSaveAction.suggestedPath,
                    testName: pendingSaveAction.testName,
                    options: [
                        {
                            id: "save_approve",
                            label: "Save",
                            description: "Write this test to the suggested path.",
                        },
                        {
                            id: "save_approve_remember",
                            label: "Save & always save",
                            description:
                                "Save now and skip this prompt for future test saves (autoSaveTests = true).",
                        },
                        {
                            id: "save_reject",
                            label: "Reject",
                            description: "Discard the draft without saving.",
                        },
                    ],
                    context: {},
                };
                const marker = `<!--HITL:${JSON.stringify(hitlPayload)}-->`;
                yield marker;
                fullText += marker;
            }

            yield `\n\n${userMessage}`;
            fullText += `\n\n${userMessage}`;
            console.log("⏸️ Agent awaiting user input");

            try {
                const memory = AgentMemory.getInstance(projectPath);
                const reason = finalState.interruption?.type || "user_input";
                memory.setPreference("paused_reason", reason);

                // Persist exploration progress so we can resume where we left off
                memory.setExplorationState({
                    pagesVisited: finalState.pagesVisited || [],
                    currentUrl: finalState.currentUrl || null,
                });
            } catch {
                // Non-critical
            }

            return {
                text: fullText,
                toolCalls: toolCallsLog,
                hitlActions,
            };
        }

        // If a test was generated and saved, stream the test content so the
        // dashboard can detect it as a complete test file and open it in the editor.
        if (finalState.testDraft && finalState.savedTestPath) {
            yield finalState.testDraft;
            fullText += finalState.testDraft;
        }

        const summary = finalState.summary || buildSummary(finalState);
        await callTool("done", {
            summary,
            pagesVisited: finalState.pagesVisited || [],
        });

        if (!finalState.testDraft) {
            yield `\n\n**Summary:**\n${summary}`;
            fullText += `\n\n**Summary:**\n${summary}`;

            if (finalState.pagesVisited && finalState.pagesVisited.length > 0) {
                const pagesText = `\n\n**Pages Visited:**\n${finalState.pagesVisited.map((p) => `- ${p}`).join("\n")}`;
                yield pagesText;
                fullText += pagesText;
            }
        }

        console.log(
            `✅ Agent complete: ${toolCallsLog.length} tool calls, ${hitlActions.length} HITL actions`,
        );

        return {
            text: fullText,
            toolCalls: toolCallsLog,
            hitlActions,
        };
    } catch (error) {
        const errorMsg = `Error: ${error instanceof Error ? error.message : String(error)}`;
        console.error("❌ Tool agent error:", errorMsg);
        yield `\n\n⚠️ ${errorMsg}`;

        return {
            text: fullText + `\n\n⚠️ ${errorMsg}`,
            toolCalls: toolCallsLog,
            hitlActions,
        };
    }
}
