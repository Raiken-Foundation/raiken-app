import * as fs from "node:fs";
import * as path from "node:path";
import { fullAstToSearchableText } from "../analysis/ast-parser";
import { EntryPointDetector } from "../analysis/entry-points";
import { describeTemplateSelectors } from "../analysis/markup-selectors";
import { ProjectContext } from "../analysis/project-context";
import { loadAutonomyConfig, loadTestDirectory } from "../config";
import type { AIProviderId } from "../config/schema";
import { CodeGraphDB } from "../database/db";
import { EmbeddingsGenerator } from "../database/embeddings";
import { persistenceError } from "../errors";
import { mergeCorrelationContext } from "../observability";
import type { ParsedFile, TemplateSelector } from "../types";
import { persistHitlPauseWorkflow } from "../workflows";
import { createLangChainModel, getProvider, resolveAIConfig } from "./ai-providers";
import { createAgentGraph } from "./graph/graph";
import { explicitlyRequestsDiscoveryClear } from "./graph/nodes/discovery-management";
import {
    type AgentIntent,
    type AuthPrecondition,
    buildSummary,
    resolveAuthPrecondition,
} from "./graph/utils";
import { AgentMemory } from "./memory";
import {
    buildAgentClassifierPrompt,
    buildExplorationPrompt,
    buildSystemPrompt,
    type ContextData,
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

/** Selectors the indexer distilled from this file's markup, if any. */
function readTemplateSelectors(parsedAstJson: string | null | undefined): TemplateSelector[] {
    if (!parsedAstJson) return [];
    try {
        return (JSON.parse(parsedAstJson) as ParsedFile).templateSelectors ?? [];
    } catch {
        return [];
    }
}

/**
 * Context text for a file with no AST — a server-rendered template, most often.
 *
 * Leads with the distilled selectors and keeps only a short slice of raw markup
 * behind them: the useful part of a 2000-line template is its test ids and
 * labels, not its layout.
 */
function buildFallbackContext(rawContent: string, selectors: TemplateSelector[]): string {
    if (selectors.length === 0) return rawContent.slice(0, 5000);
    return `${describeTemplateSelectors(selectors)}\n---\n${rawContent.slice(0, 2000)}`;
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

    const testDirectory = loadTestDirectory(projectPath);

    const files: ContextData["files"] = [];
    let totalTokens = 0;
    const TOKEN_LIMIT = 15000; // Reserve space for prompt structure

    // Use ProjectContext for cached file discovery (fast, no rescanning)
    let intelligentFiles: string[] = [];
    try {
        const projectContext = ProjectContext.getInstance(projectPath);

        // Validate cache and refresh if needed
        await projectContext.ensureFreshContext(prompt, changedFiles);

        // Use cached context for file discovery
        intelligentFiles = projectContext.findRelevantFiles(prompt, 10);
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
                        ...(parsed.templateSelectors?.length
                            ? { templateSelectors: parsed.templateSelectors }
                            : {}),
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

                        // A template has no AST but may still have indexed
                        // selectors, which are the reason it is worth sending.
                        const templateSelectors = readTemplateSelectors(file?.parsed_ast);
                        files.push({
                            path: filePath,
                            functions: [],
                            classes: [],
                            imports: [],
                            fullContext: buildFallbackContext(rawContent, templateSelectors),
                            relevanceScore: 0.8,
                            ...(templateSelectors.length ? { templateSelectors } : {}),
                        });

                        totalTokens += estimatedTokens;
                    } catch (err) {
                        console.warn(`Failed to read file: ${filePath}`, err);
                    }
                } else {
                    console.warn(`File not found: ${filePath}`);
                }
            }
        }
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
                        ...(parsed.templateSelectors?.length
                            ? { templateSelectors: parsed.templateSelectors }
                            : {}),
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

                        const templateSelectors = readTemplateSelectors(file?.parsed_ast);
                        files.push({
                            path: result.filePath,
                            functions: [],
                            classes: [],
                            imports: [],
                            fullContext: buildFallbackContext(rawContent, templateSelectors),
                            relevanceScore: result.similarity * 0.9, // Slightly lower score for raw content
                            ...(templateSelectors.length ? { templateSelectors } : {}),
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

// ============================================================================
// Tool-Based Agent (New Architecture)
// ============================================================================

import { type AutonomySettings, createAgentTools, type HITLAction, type ToolResult } from "./tools";
import { redactToolArgs } from "./tools/shared/redaction";

/**
 * Load autonomy settings from raiken.config.json, optionally overridden for
 * just this call (e.g. the REPL's `/mode` reflecting the current session
 * without permanently rewriting the project's shared config file).
 *
 * Thin wrapper over {@link loadAutonomyConfig} (the single source of truth
 * for this section, also used directly by graph nodes) kept for backward
 * compatibility with existing callers/imports.
 */
export function loadAutonomySettings(
    projectPath: string,
    override?: Partial<AutonomySettings>,
): AutonomySettings {
    return loadAutonomyConfig(projectPath, override);
}

/**
 * A tiny push-based async channel that bridges synchronous node callbacks
 * (onToolCall / onProgress / streamed tokens) into the async generator that
 * `runToolAgent` yields. Without this, everything the graph produces would only
 * surface *after* `graph.invoke` resolved, so the dashboard sat frozen through
 * the entire navigate -> explore -> generate cycle. Items pushed here are
 * yielded live while the graph is still running.
 */
class StreamChannel<T> {
    private queue: T[] = [];
    private resolvers: Array<(r: IteratorResult<T>) => void> = [];
    private closed = false;

    push(value: T): void {
        if (this.closed) return;
        const resolve = this.resolvers.shift();
        if (resolve) resolve({ value, done: false });
        else this.queue.push(value);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const resolve of this.resolvers.splice(0))
            resolve({ value: undefined as never, done: true });
    }

    next(): Promise<IteratorResult<T>> {
        const queued = this.queue.shift();
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
    }
}

/** Distinct kinds of item flowing through the stream channel. */
type StreamItem = { kind: "text"; text: string } | { kind: "event"; text: string };

/**
 * Build the inline activity marker the dashboard/CLI strip out of the visible
 * message and render as a live "what the agent is doing" trail. Mirrors the
 * existing `<!--HITL:...-->` convention. The payload is base64-encoded so test
 * code or labels containing `-->` can never truncate the marker.
 */
export function buildAgentEventMarker(
    kind: "tool" | "progress",
    label: string,
    detail?: string,
): string {
    const json = JSON.stringify({ kind, label, detail: detail ?? null });
    const encoded = Buffer.from(json, "utf-8").toString("base64");
    return `<!--EVENT:${encoded}-->`;
}

/**
 * Build the `<!--HITL:...-->` marker. The JSON payload is base64-encoded so a
 * generated test's own content (which can legitimately contain `-->`, e.g. in
 * an HTML fixture or comment) can never truncate the marker and lose the
 * save-approval card. Consumers decode base64 first and fall back to raw JSON
 * for markers persisted before this change.
 */
export function buildHITLMarker(payload: unknown): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
    return `<!--HITL:${encoded}-->`;
}

/**
 * Decide which (if any) rich HITL marker to surface for the current pause,
 * given every HITL action collected so far this run. We piggy-back on the
 * `<!--HITL:..-->` marker so the dashboard sidebar / CLI REPL can render an
 * actionable approval card (code preview or run summary, Approve / Reject /
 * Always-* buttons) instead of the bare `awaitUserMessage` text — without
 * this the user sees only "Waiting for approval to save/run X." with nothing
 * to click or type.
 *
 * Only the LAST action decides what's actually pending: a "run" pause always
 * comes after its own "save" already resolved (auto-approved or
 * user-approved), so an earlier save in the same turn must never be
 * re-surfaced as if it were still awaiting a decision.
 *
 * Extracted as a pure function (mirrors `computeOneShotOutcome` in
 * `oneshot.ts`) so this branching is unit-testable without spinning up the
 * full graph/LLM stack.
 */
export function buildPendingHitlMarker(
    hitlActions: HITLAction[],
    workflowId?: string,
): string | null {
    const lastPendingAction = hitlActions[hitlActions.length - 1];
    if (!lastPendingAction) return null;

    if (lastPendingAction.type === "save") {
        return buildHITLMarker({
            kind: "save_approval" as const,
            type: "save",
            title: "Approve test save",
            message:
                "Review the generated test below. Approve to save it to disk, edit the path if you want it elsewhere, or reject to discard it.",
            reasons: [],
            testCode: lastPendingAction.testCode,
            suggestedPath: lastPendingAction.suggestedPath,
            testName: lastPendingAction.testName,
            // Carried to the approving surface (CLI one-shot, dashboard) so it
            // knows an existing file is the intended destination.
            overwriteTarget: lastPendingAction.overwriteTarget === true,
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
            context: workflowId ? { workflowId } : {},
        });
    }

    if (lastPendingAction.type === "run") {
        return buildHITLMarker({
            kind: "run_approval" as const,
            type: "run",
            title: "Approve test run",
            message: "The test is saved. Run it now, or skip and run it later yourself.",
            reasons: lastPendingAction.warnings ?? [],
            testFile: lastPendingAction.testFile,
            testName: lastPendingAction.testName,
            options: [
                {
                    id: "run_approve",
                    label: "Run",
                    description: "Execute this test now.",
                },
                {
                    id: "run_approve_remember",
                    label: "Run & always run",
                    description:
                        "Run now and skip this prompt for future test runs (autoRunTests = true).",
                },
                {
                    id: "run_reject",
                    label: "Skip",
                    description: "Don't run it now.",
                },
            ],
            context: workflowId ? { workflowId } : {},
        });
    }

    return null;
}

/**
 * Human-readable label for a tool call, for the activity trail.
 *
 * Every tool exported by `createAgentTools` (agent/tools.ts) should have an
 * entry here so the dashboard/CLI activity trail never shows a silent gap
 * mid-run. New tools that forget to add a mapping still get a serviceable
 * generic label instead of falling through to `null` (which used to mean
 * "show nothing at all").
 */
export function humanizeToolCall(toolName: string): string {
    const labels: Record<string, string> = {
        searchCodebase: "Searching codebase",
        readFile: "Reading file",
        listDirectory: "Listing directory",
        captureDOM: "Reading page",
        saveFile: "Saving test",
        runTest: "Running test",
        getMemoryContext: "Recalling past runs",
        getProjectOverview: "Analyzing project",
        getDiscoveryOverview: "Reviewing site map",
        listDiscoveredPages: "Listing discovered pages",
        getDiscoveredPageSnapshot: "Loading page snapshot",
        clearDiscoveryData: "Clearing discovery data",
        startDiscovery: "Starting site discovery",
        startBrowser: "Starting browser",
        closeBrowser: "Closing browser",
        navigateTo: "Navigating",
        clickElement: "Clicking",
        fillInput: "Filling input",
        pressKey: "Pressing key",
        captureCurrentPage: "Reading page",
        waitForElement: "Waiting for element",
        typeText: "Typing",
        hoverElement: "Hovering",
        selectOption: "Selecting option",
        toggleCheckbox: "Toggling checkbox",
        getCurrentUrl: "Checking current URL",
        saveAuthState: "Saving login state",
        discoverLinks: "Discovering links",
        done: "Finishing up",
        respond: "Responding",
        awaitUser: "Waiting for your input",
    };
    return labels[toolName] ?? `Running ${toolName}...`;
}

export { redactToolArgs };

/**
 * Options for the tool-based agent
 */
export interface ToolAgentOptions {
    userPrompt: string;
    projectPath: string;
    conversationHistory?: Array<{ role: string; content: string }>;
    /**
     * Path of the test file the user currently has open/highlighted. When set,
     * a newly generated test is written to this file (overwriting it) instead
     * of creating a brand-new file.
     */
    targetTestFile?: string;
    /** Files the user referenced (e.g. @mentions) to focus context gathering on. */
    fileContext?: string[];
    config?: AgentConfig;
    /**
     * Session-scoped autonomy override for just this run — e.g. the CLI
     * REPL's `/mode auto-run`/`/mode yolo` reflecting what the user asked
     * for in *this* session, without permanently rewriting the project's
     * shared `raiken.config.json` (which may be committed and shared with
     * teammates). Merged on top of the on-disk config; omit any field to
     * fall back to it.
     */
    autonomyOverride?: Partial<AutonomySettings>;
    /**
     * Abort signal to cancel the run (e.g. the SSE client disconnected).
     * LangGraph checks it at step boundaries and stops the graph.
     */
    signal?: AbortSignal;
    /** The caller already owns the project-operation lease for this run. */
    operationHeld?: boolean;
    /** Callback for tool call events (for UI feedback) */
    onToolCall?: (toolName: string, args: unknown) => void;
    /** Callback for tool result events */
    onToolResult?: (toolName: string, result: ToolResult) => void;
    /** Caller surface used for a durable manual-HITL continuation. */
    origin?: "agent" | "dashboard" | "repl";
}

/**
 * Result of a tool-based agent run
 */
export interface ToolAgentResult {
    text: string;
    toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
    hitlActions: HITLAction[];
    workflowId?: string;
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
        targetTestFile,
        fileContext,
        config: configOverride,
        autonomyOverride,
        signal,
        operationHeld,
        onToolCall,
        onToolResult,
        origin = "agent",
    } = options;

    // Load configuration
    const config = loadAgentConfig(projectPath, configOverride);

    // Validate API key — skip entirely for providers that don't need one
    // (e.g. Ollama), which previously hit this same "missing key" gate even
    // though there's nothing to configure.
    const configuredProvider = getProvider(config.provider);
    if (configuredProvider.envVars.length > 0 && !config.apiKey) {
        const provider = configuredProvider;
        const envHint = provider.envVars[0] ?? "AI_API_KEY";
        yield "**API Key Required**\n\n";
        // Deliberately points at the interactive wizard rather than
        // `raiken config <key>`: keys on the command line land in shell
        // history, which the README explicitly warns against.
        yield `No key found for **${provider.label}**. Fastest fix: run \`raiken config\` ` +
            "(or `/config` in this session) to pick a provider and save a key — same settings as " +
            "the dashboard's Settings → AI Provider panel, so it only needs to be set once.\n\n" +
            `You can also set ${envHint} in your environment.\n\n`;
        return {
            text: "",
            toolCalls: [],
            hitlActions: [],
        };
    }

    const toolCallsLog: Array<{ name: string; args: unknown; result: unknown }> = [];
    const hitlActions: HITLAction[] = [];
    const respondMessages: string[] = [];
    let fullText = "";

    // Bridges live node activity (tool calls, phase progress, streamed test
    // tokens) into this generator so the UI updates *during* the run.
    const channel = new StreamChannel<StreamItem>();
    // Set to true once the generate step streams its tokens live, so we don't
    // re-yield the whole draft afterward and duplicate it.
    let draftStreamed = false;

    try {
        const autonomy = loadAutonomySettings(projectPath, autonomyOverride);
        let initialAuthPrecondition = resolveAuthPrecondition({ userPrompt });
        try {
            const pausedReason =
                AgentMemory.getInstance(projectPath).getPreference("paused_reason");
            if (pausedReason === "auth" || pausedReason === "otp") {
                initialAuthPrecondition = "login_flow";
            }
        } catch {
            // Memory is optional; prompt classification remains a safe fallback.
        }
        const authPreconditionRef: { current: AuthPrecondition } = {
            current: initialAuthPrecondition,
        };
        const tools = createAgentTools({
            projectPath,
            autonomy,
            signal,
            operationHeld,
            isActionAuthorized: (action) =>
                action === "clearDiscoveryData" && explicitlyRequestsDiscoveryClear(userPrompt),
            getAuthPrecondition: () => authPreconditionRef.current,
        });
        const toolMap = tools as Record<
            string,
            { execute?: (args: unknown) => Promise<ToolResult> }
        >;

        const callTool = async (toolName: string, args: unknown): Promise<ToolResult> => {
            const safeArgs = redactToolArgs(toolName, args);
            onToolCall?.(toolName, safeArgs);
            const activityLabel = humanizeToolCall(toolName);
            if (activityLabel) {
                channel.push({ kind: "event", text: buildAgentEventMarker("tool", activityLabel) });
            }
            let result: ToolResult;
            const tool = toolMap[toolName];
            if (tool?.execute) {
                result = await tool.execute(args);
            } else {
                result = { success: true, message: `${toolName} invoked` };
            }
            toolCallsLog.push({ name: toolName, args: safeArgs, result });
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
        const model = createLangChainModel(resolved);

        const getMemoryContext = () => {
            try {
                // buildPromptContext lazily initializes memory, so learned
                // selectors/failures reach the prompt regardless of whether the
                // CLI server called initialize() first.
                return AgentMemory.getInstance(projectPath).buildPromptContext();
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

        // Emit a phase-progress marker (e.g. "Exploring 3/8 pages") live.
        const onProgress = (label: string, detail?: string) => {
            channel.push({ kind: "event", text: buildAgentEventMarker("progress", label, detail) });
        };
        // Stream a token of the test being generated live.
        const onToken = (token: string) => {
            if (!token) return;
            draftStreamed = true;
            channel.push({ kind: "text", text: token });
        };

        const graph = createAgentGraph({
            callTool,
            projectPath,
            autonomy,
            onProgress,
            onToken,
            signal,
            model,
            gatherContext,
            buildSystemPrompt,
            buildExplorationPrompt,
            buildAgentClassifierPrompt,
            getMemoryContext,
            getActiveIntent,
            setActiveIntent,
            setAuthPrecondition: (precondition) => {
                authPreconditionRef.current = precondition;
            },
            getGoalState,
            setGoalState,
        });

        const seedState: Record<string, unknown> = {
            userPrompt,
            conversationHistory: conversationHistory || [],
            authPrecondition: initialAuthPrecondition,
        };

        if (fileContext && fileContext.length > 0) {
            seedState["fileContext"] = fileContext;
        }

        // When the user has a test file open, target it so a newly generated
        // test overwrites that file instead of creating a new one.
        if (targetTestFile) {
            seedState["targetTestFile"] = targetTestFile;
        }

        // Load remembered exploration state and pass it to the graph as
        // "pending" fields. The classifyGoal node (LLM) decides whether to
        // restore it into the active session. We always load the last
        // exploration snapshot (not just on pause) so the agent remembers the
        // pages it has seen across turns and avoids re-crawling them.
        try {
            const memory = AgentMemory.getInstance(projectPath);
            const pauseReason = memory.getPreference("paused_reason") || null;

            if (pauseReason) {
                memory.setPreference("paused_reason", "");
                seedState["pauseReason"] = pauseReason;
            }

            // Only carry forward a *recent* exploration. A crawl from an old,
            // unrelated task shouldn't be dragged into a fresh session — that's
            // what made the agent "remember" the wrong pages.
            const EXPLORATION_MAX_AGE_MS = 30 * 60 * 1000;
            const lastExploration = memory.getLastExploration();
            if (lastExploration && memory.getLastExplorationAgeMs() < EXPLORATION_MAX_AGE_MS) {
                seedState["pendingPagesVisited"] = lastExploration.pagesVisited;
                seedState["pendingPageSummaries"] = lastExploration.pageSummaries;
                seedState["pendingCurrentUrl"] = lastExploration.currentUrl;
            }
        } catch {
            // Non-critical
        }

        // Kick off the graph but DON'T await it yet — drain the live channel
        // (tool/progress events + streamed tokens) as the graph runs, then
        // await the final state once the channel closes.
        // Cap graph iterations so a pathological navigate↔interruption loop
        // can't spin forever; LangGraph throws a GraphRecursionError when hit,
        // which the catch below surfaces as a clear message instead of hanging.
        const invokeConfig = {
            recursionLimit: 60,
            ...(signal ? { signal } : {}),
        };
        const invokePromise = graph.invoke(seedState, invokeConfig).then(
            (result) => {
                channel.close();
                return result;
            },
            (error) => {
                channel.close();
                throw error;
            },
        );

        while (true) {
            const { value, done } = await channel.next();
            if (done) break;
            yield value.text;
            if (value.kind === "text") fullText += value.text;
        }

        const finalState = await invokePromise;

        for (const msg of respondMessages) {
            yield `${msg}\n`;
            fullText += `${msg}\n`;
        }

        if (finalState.awaitUserMessage) {
            const userMessage = finalState.awaitUserMessage;
            const pendingAction = hitlActions.at(-1);
            const requiresDurableWorkflow =
                pendingAction?.type === "save" || pendingAction?.type === "run";
            let workflowId: string | undefined;
            try {
                workflowId = (
                    await persistHitlPauseWorkflow({
                        projectPath,
                        hitlActions,
                        origin,
                        repairAttempts: finalState.repairAttempts,
                        shouldRunTests: finalState.shouldRunTests,
                        autonomy,
                    })
                )?.id;
            } catch (error) {
                if (requiresDurableWorkflow) {
                    throw persistenceError(
                        "Unable to persist the approval workflow. No save or run action was exposed.",
                        { cause: error },
                    );
                }
                console.warn(
                    "Failed to persist HITL continuation:",
                    error instanceof Error ? error.message : error,
                );
            }
            if (requiresDurableWorkflow && !workflowId) {
                throw persistenceError(
                    "Unable to persist the approval workflow. No save or run action was exposed.",
                );
            }
            if (workflowId) {
                mergeCorrelationContext({ workflowId });
            }

            // If we're paused because saveFile/runTest asked for HITL approval,
            // surface the actual pending action + structured data to the
            // dashboard/CLI *before* the await message. Without this the user
            // sees only a bare "Waiting for approval to save/run X." with
            // nothing actionable — the content lives in `hitlActions[]` but is
            // never streamed on its own.
            const marker = buildPendingHitlMarker(hitlActions, workflowId);
            if (marker) {
                yield marker;
                fullText += marker;
            }

            yield `\n\n${userMessage}`;
            fullText += `\n\n${userMessage}`;
            // One-shot (-p) resolves this pause itself via auto-approval, so
            // the "awaiting user input" line would misreport a stuck agent.
            if (process.env["RAIKEN_ONESHOT"] !== "1") {
                console.log("⏸️ Agent awaiting user input");
            }

            try {
                const memory = AgentMemory.getInstance(projectPath);
                const reason = finalState.interruption?.type || "user_input";
                memory.setPreference("paused_reason", reason);

                // Persist exploration progress so we can resume where we left off.
                // Only overwrite when this pause actually has pages (e.g. an
                // auth/consent blocker mid-crawl) — a save-approval or other
                // non-exploration pause with an empty pagesVisited would
                // otherwise wipe out a previously remembered crawl.
                if (finalState.pagesVisited && finalState.pagesVisited.length > 0) {
                    memory.setLastExploration({
                        pagesVisited: finalState.pagesVisited,
                        currentUrl: finalState.currentUrl || null,
                        pageSummaries: finalState.pageSummaries || [],
                    });
                }
            } catch {
                // Non-critical
            }

            return {
                text: fullText,
                toolCalls: toolCallsLog,
                hitlActions,
                workflowId,
            };
        }

        // If a test was generated and saved, stream the test content so the
        // dashboard can detect it as a complete test file and open it in the
        // editor. Skip when the draft was already streamed token-by-token during
        // the generate step (otherwise it would appear twice).
        if (finalState.testDraft && finalState.savedTestPath && !draftStreamed) {
            yield finalState.testDraft;
            fullText += finalState.testDraft;
        }

        const summary = finalState.summary || buildSummary(finalState);
        await callTool("done", {
            summary,
            pagesVisited: finalState.pagesVisited || [],
        });

        // Task completed (not paused). Persist exploration only when there is
        // something to remember, and clear the goal + pause markers so the NEXT
        // (potentially unrelated) task starts clean instead of inheriting this
        // one's goal/URL.
        try {
            const memory = AgentMemory.getInstance(projectPath);
            if (finalState.pagesVisited && finalState.pagesVisited.length > 0) {
                memory.setLastExploration({
                    pagesVisited: finalState.pagesVisited,
                    currentUrl: finalState.currentUrl || null,
                    pageSummaries: finalState.pageSummaries || [],
                });
            }
            memory.clearGoalState();
            memory.setPreference("paused_reason", "");
        } catch {
            // Non-critical
        }

        if (!finalState.testDraft) {
            yield `\n\n**Summary:**\n${summary}`;
            fullText += `\n\n**Summary:**\n${summary}`;

            if (finalState.pagesVisited && finalState.pagesVisited.length > 0) {
                const pagesText = `\n\n**Pages Visited:**\n${finalState.pagesVisited.map((p) => `- ${p}`).join("\n")}`;
                yield pagesText;
                fullText += pagesText;
            }
        }

        return {
            text: fullText,
            toolCalls: toolCallsLog,
            hitlActions,
        };
    } catch (error) {
        const rawMsg = error instanceof Error ? error.message : String(error);
        // LangGraph throws a GraphRecursionError when the recursion limit is
        // hit — turn that into an actionable message rather than a stack trace.
        const isRecursion =
            (error instanceof Error && error.name === "GraphRecursionError") ||
            /recursion limit/i.test(rawMsg);
        const errorMsg = isRecursion
            ? "The agent hit its step limit without finishing (likely a navigation/interruption loop). Try a more specific instruction, or a concrete URL to test."
            : `Error: ${rawMsg}`;
        console.error("Tool agent error:", rawMsg);
        yield `\n\n${errorMsg}`;

        return {
            text: `${fullText}\n\n${errorMsg}`,
            toolCalls: toolCallsLog,
            hitlActions,
        };
    }
}
