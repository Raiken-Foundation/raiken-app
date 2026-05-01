// ============================================================================
// Prompt templates for AI test generation.
// Tight, instruction-only style: no persona, no few-shot, no recap sections.
// ============================================================================

import type { SiteKnowledge } from "../site-discovery";
import type { ParsedClass, ParsedFunction, ParsedImport } from "../types";
import type { AgentIntent } from "./graph/utils";

export interface ContextData {
    files: Array<{
        path: string;
        functions: ParsedFunction[];
        classes: ParsedClass[];
        imports: ParsedImport[];
        fullContext: string;
        relevanceScore: number;
    }>;
    projectType: string;
    testDirectory: string;
    totalTokens: number;
    siteKnowledge?: SiteKnowledge | null;
    /**
     * Static `use.baseURL` extracted from the target project's
     * `playwright.config.{ts,js,mjs}`, when present. Drives whether the
     * generated test should use relative paths (`page.goto('/login')`) or
     * fully-qualified URLs.
     */
    baseURL?: string | null;
}

/**
 * Memory context from AgentMemory for prompt building
 */
export interface MemoryContext {
    /** Preferred selector strategy (e.g., 'data-testid', 'role') */
    selectorStrategy: string | null;
    /** Selectors that have worked in the past */
    successfulSelectors: Array<{ element: string; selector: string; type: string }>;
    /** Recent test failures to avoid */
    recentFailures: Array<{ testName: string; error: string }>;
}

export interface PromptTemplate {
    version: string;
    name: string;
    description: string;
    buildPrompt: (context: ContextData, userPrompt: string) => string;
    formatSiteKnowledgeSection?: (siteKnowledge: SiteKnowledge) => string;
    changelog?: string[];
    performanceMetrics?: {
        successRate?: number;
        avgTokens?: number;
        avgGenerationTime?: number;
    };
}

export interface AgentClassifierResult {
    intent: "explore" | "generateTests" | "explain";
    goal: string | null;
    targetFeature: string | null;
    targetUrl: string | null;
    nextTool: "domCapture" | "codeSearch" | "testGen" | "explain" | "discoveryRead" | "none" | null;
    missingContext: string[];
}

/**
 * Test-generation prompt. Stripped of persona, few-shot, and recap sections;
 * load-bearing rules only.
 */
export const goldenFrameworkTemplate: PromptTemplate = {
    version: "2.0.0",
    name: "tight-v2",
    description: "Instruction-only Playwright test generation prompt.",

    buildPrompt(context: ContextData, userPrompt: string): string {
        // The URL rule has to flip depending on whether the target project
        // has a Playwright `baseURL` configured. With one set, relative paths
        // (`page.goto('/login')`) compose with the baseURL and let the same
        // test run against local / staging / prod just by changing the
        // config. Without one, Playwright treats `'/login'` as a navigation
        // failure, so the test must hardcode the full URL.
        const urlRule = context.baseURL
            ? `- A Playwright \`use.baseURL\` is configured: \`${context.baseURL}\`.
  URLs MUST be relative paths starting with "/" (e.g. \`page.goto('/login')\`).
  Do NOT emit \`http://\` / \`https://\` URLs unless navigating to an external origin.`
            : `- URLs MUST be absolute (no baseURL is configured). Source from user prompt, [SITE DISCOVERY KNOWLEDGE], or DOM context. If none, ask.`;

        return `[ROLE]
Senior Playwright/TypeScript engineer. Target: ${context.projectType}.

[PROJECT]
Test directory: ${context.testDirectory}${context.baseURL ? `\nbaseURL: ${context.baseURL}` : ""}

[SOURCE FILES]
${context.files
    .map(
        (f) => `File: ${f.path}
Functions: ${f.functions.map((fn) => `${fn.name}(${fn.params.join(", ")})`).join(", ") || "none"}
Classes: ${f.classes.map((c) => c.name).join(", ") || "none"}
Imports: ${
            f.imports
                .slice(0, 5)
                .map((i) => i.source)
                .join(", ") || "none"
        }
---
${f.fullContext}`,
    )
    .join("\n\n")}
${context.siteKnowledge && this.formatSiteKnowledgeSection ? this.formatSiteKnowledgeSection(context.siteKnowledge) : ""}

[TASK]
${userPrompt}

[OUTPUT]
Complete .ts test file. No markdown fences. No prose.
Structure: imports → describe → optional beforeEach → test cases (Arrange/Act/Assert).

[RULES]
- Selector priority: getByRole > getByLabel > getByPlaceholder > getByTestId > getByText.
- If a [LIVE DOM CONTEXT] block is present, use ONLY selectors from it. Do not invent.
${urlRule}
- If [LIVE DOM CONTEXT] includes [PREREQUISITES], add beforeEach handling them; use env vars for credentials.
- No fixed sleeps. NEVER emit page.waitForTimeout, setTimeout, or sleep.
  Use expect.toBeVisible/toHaveText with timeout, waitForURL, or waitForResponse.
- No vague assertions (expect(true).toBe(true)).
- No deprecated APIs. No Jest/Vitest syntax.
- Use TypeScript types and async/await correctly.`;
    },

    formatSiteKnowledgeSection(siteKnowledge: SiteKnowledge): string {
        const { formatSiteKnowledge } = require("../site-discovery");
        return "\n" + formatSiteKnowledge(siteKnowledge);
    },

    changelog: [
        "v1.0.0: Initial GOLDEN framework structure.",
        "v2.0.0: Stripped persona, few-shot, and recap sections to cut tokens ~70%.",
    ],

    performanceMetrics: {
        successRate: 0,
        avgTokens: 0,
        avgGenerationTime: 0,
    },
};

/**
 * Registry of available prompt templates
 * Allows for A/B testing and version switching
 */
export const promptTemplates: Record<string, PromptTemplate> = {
    "golden-v1": goldenFrameworkTemplate,
    // Future versions can be added here
};

/**
 * Get the active prompt template
 * Can be overridden via configuration
 */
export function getPromptTemplate(version = "golden-v1"): PromptTemplate {
    const template = promptTemplates[version];
    if (!template) {
        throw new Error(`Prompt template version "${version}" not found`);
    }
    return template;
}

/**
 * Build system prompt using the specified template
 */
export function buildSystemPrompt(
    context: ContextData,
    userPrompt: string,
    templateVersion = "golden-v1",
    memoryContext?: MemoryContext,
): string {
    const template = getPromptTemplate(templateVersion);
    let prompt = template.buildPrompt(context, userPrompt);

    // Append memory context if available
    if (memoryContext) {
        prompt += buildMemoryContextSection(memoryContext);
    }

    return prompt;
}

/**
 * Build a prompt for exploratory Q&A and multi-question handling
 */
export function buildExplorationPrompt(
    context: ContextData,
    userPrompt: string,
    memoryContext?: MemoryContext,
    intent: AgentIntent = "explore",
    goalState?: {
        activeGoal?: string | null;
        targetFeature?: string | null;
        targetUrl?: string | null;
        missingContext?: string[];
        nextTool?: string | null;
    },
): string {
    let prompt = `[ROLE]
QA + senior engineer helping a teammate understand and test the product.

[INTENT] ${intent}
[GOAL] ${goalState?.activeGoal ?? "none"} | feature: ${goalState?.targetFeature ?? "none"} | url: ${goalState?.targetUrl ?? "none"} | nextTool: ${goalState?.nextTool ?? "none"}
[MISSING] ${(goalState?.missingContext || []).join(", ") || "none"}

[RULES]
- Treat the request as a task even if not a question. Pick the most likely interpretation; only ask a follow-up if missing input blocks progress.
- Use only the provided context. Do not claim actions you did not take.
- intent=explain → describe flow; intent=explore → map features to files/components.
- Multi-part requests → numbered list under "Answers".

[PROJECT] ${context.projectType} (tests: ${context.testDirectory})

[SOURCE FILES]
${context.files
    .map(
        (f) => `File: ${f.path}
Functions: ${f.functions.map((fn) => `${fn.name}(${fn.params.join(", ")})`).join(", ") || "none"}
Classes: ${f.classes.map((c) => c.name).join(", ") || "none"}
Imports: ${
            f.imports
                .slice(0, 5)
                .map((i) => i.source)
                .join(", ") || "none"
        }
---
${f.fullContext}`,
    )
    .join("\n\n")}

[TASK]
${userPrompt}

[OUTPUT]
Answers:
- Direct answer per question/task. For mapping, use "Feature -> files".
Evidence:
- Cite file paths or DOM observations actually used.
Unknowns / Next checks:
- Uncertainties and what to verify. Write "None" if there are none.`;

    if (memoryContext) {
        prompt += buildMemoryContextSection(memoryContext);
    }

    return prompt;
}

/**
 * Build a prompt section from memory context
 */
function buildMemoryContextSection(memory: MemoryContext): string {
    const sections: string[] = [];

    if (memory.selectorStrategy) {
        sections.push(
            `\n[PREFERRED SELECTOR] ${memory.selectorStrategy} (prioritize when available)`,
        );
    }

    if (memory.successfulSelectors.length > 0) {
        sections.push(`\n[KNOWN-GOOD SELECTORS]
${memory.successfulSelectors.map((s) => `- ${s.element}: ${s.selector} (${s.type})`).join("\n")}`);
    }

    if (memory.recentFailures.length > 0) {
        sections.push(`\n[AVOID — recent failures]
${memory.recentFailures.map((f) => `- ${f.testName}: ${f.error}`).join("\n")}`);
    }

    return sections.join("\n");
}

// ============================================================================
// Standalone Prompt Messages
// ============================================================================

/**
 * Help message when no code context is available
 */
export const NO_CONTEXT_HELP_MESSAGE = `I'd be happy to help generate tests, but I need some code context first! 

Here's how to get started:
1. Make sure your code graph is built (you should see files in the Files panel)
2. Use @ to mention a specific file (e.g., "@src/utils.ts")
3. Or I can search for relevant files based on your description

Try something like: "Generate a test for @src/components/LoginForm.tsx"`;

/**
 * Help message when exploration context is missing
 */
export const NO_EXPLORATION_CONTEXT_MESSAGE = `I can help answer questions about the app, but I need more context first.

Please:
1. Build the code graph (so I can read project files), or
2. Tell me which page or feature you want analyzed (I will locate the files), or
3. Point me to a specific file with @.`;

/**
 * Build strict JSON classifier prompt for agent intent and goal extraction
 */
export function buildAgentClassifierPrompt(input: {
    userPrompt: string;
    conversationHistory?: Array<{ role: string; content: string }>;
    storedGoal?: {
        activeGoal?: string | null;
        targetFeature?: string | null;
        targetUrl?: string | null;
        missingContext?: string[];
        nextTool?: string | null;
    };
    pauseReason?: string | null;
}): string {
    const historyText =
        input.conversationHistory && input.conversationHistory.length > 0
            ? input.conversationHistory
                  .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
                  .join("\n")
            : "None";
    const storedGoal = input.storedGoal || {};

    const pauseContext = input.pauseReason
        ? `\nPause: agent was paused for "${input.pauseReason}". The new message is either a reply to that pause (credentials, "done", "continue") or an unrelated new command. Set isContinuation accordingly.\n`
        : "";

    return `Classify a QA agent request. Return JSON only.

Rules:
- Valid JSON, double quotes. Unknown → null. missingContext is string[] (use []).
- intent ∈ explore | generateTests | explain.
- nextTool ∈ domCapture | codeSearch | testGen | explain | discoveryRead | none | null.
- discoveryRead when the user asks for persisted discovery data (pages, snapshots, stats, blockers).
- isContinuation=true ONLY when directly replying to the Pause below; false otherwise or when no Pause.

History:
${historyText}

StoredGoal: activeGoal=${storedGoal.activeGoal ?? "null"} | feature=${storedGoal.targetFeature ?? "null"} | url=${storedGoal.targetUrl ?? "null"} | nextTool=${storedGoal.nextTool ?? "null"} | missing=${(storedGoal.missingContext || []).join(", ") || "none"}
${pauseContext}
CurrentPrompt:
${input.userPrompt}

Schema:
{"intent":"explore|generateTests|explain","goal":string|null,"targetFeature":string|null,"targetUrl":string|null,"nextTool":"domCapture|codeSearch|testGen|explain|discoveryRead|none"|null,"missingContext":string[],"shouldRunTests":boolean,"isContinuation":boolean}`;
}

/**
 * Build intent classification prompt for the orchestrator.
 */
export function buildIntentClassificationPrompt(context: string): string {
    return `Classify a Playwright test-gen agent request.

${context}

Output four fields:
1) control: stop | cancel | go | retry | continue | refine | clarify | new
2) intent: test-generation | chat | help
3) nextTool: domCapture | codeSearch | testGen | explain | discoveryRead | none
4) effectivePrompt: for retry/continue, the most recent prior task message (not a control phrase). For refine, the prior task merged with the new request.

Definitions:
- control: stop=halt now; cancel=abandon current; go=proceed; retry=redo last task; continue=resume same flow; refine=modify previous; clarify=ambiguous, ask follow-up; new=fresh request.
- intent: test-generation=user wants test code produced; chat=questions/explanations about the code; help=questions about Raiken itself.
- nextTool: domCapture=need live DOM selectors; codeSearch=need files; testGen=enough context, generate now; explain=Q&A; discoveryRead=read persisted discovery data; none=no tool (help/simple reply).

Use the conversation context to disambiguate. Respond with reasoning then the four fields.`;
}

/**
 * Build page state analysis prompt.
 */
export function buildPageStateAnalysisPrompt(
    domSummary: string,
    userIntent: string,
    targetFunctionality: string,
): string {
    return `Decide if this page contains what the user wants to test. Be factual; only describe what is visible.

User wants to test: ${userIntent}
Target: ${targetFunctionality}

Page:
${domSummary}

Answer:
1. What kind of page is this (login, dashboard, form, error, etc.)?
2. Does it contain the requested functionality? yes/no.
3. If no, name the mismatch concretely (e.g. "wants counter, this is login").`;
}

/**
 * Build conversational chat prompt for Raiken.
 */
export function buildChatPrompt(
    userPrompt: string,
    resolvedFiles: string[],
    fileContextSummary: string,
): string {
    return `You are Raiken, an assistant for web development and testing. Be concise, accurate, and honest about uncertainty.

Request: ${userPrompt}

Context:
${
    resolvedFiles.length > 0
        ? `Files: ${resolvedFiles.join(", ")}\n\n${fileContextSummary}`
        : "No files in context. Suggest @ mentions if you need them."
}

Guidance:
- Answer directly. If explaining code, ground in the provided context.
- For architecture questions, name tradeoffs.
- For tests, point at the next concrete step.
- Be brief but complete.`;
}

// ============================================================================
// Tool-Based Agent System Prompt
// ============================================================================

/**
 * Build the system prompt for the tool-based agent.
 * This prompt instructs the LLM on how to use tools effectively.
 */
