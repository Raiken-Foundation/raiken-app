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
    formatSiteKnowledgeSection?: (siteKnowledge: SiteKnowledge, baseURL?: string | null) => string;
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
    targetAction?: string | null;
    performAction?: boolean;
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
  URLs MUST be relative paths starting with "/". Use the exact path observed in [LIVE DOM CONTEXT] / [SITE DISCOVERY KNOWLEDGE] or given by the user — never guess or assume a route.
  Do NOT emit \`http://\` / \`https://\` URLs unless navigating to an external origin.`
            : `- URLs MUST be absolute (no baseURL is configured). Source from user prompt, [SITE DISCOVERY KNOWLEDGE], or DOM context. Never invent a route. If none is available, ask.`;

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
${context.siteKnowledge && this.formatSiteKnowledgeSection ? this.formatSiteKnowledgeSection(context.siteKnowledge, context.baseURL) : ""}

[TASK]
${userPrompt}

[OUTPUT]
Complete .ts test file. No markdown fences. No prose.
Structure: imports → describe → optional beforeEach → test cases (Arrange/Act/Assert).

[GROUNDING]
- Drive the test from [LIVE DOM CONTEXT]: the flow, steps, and assertions all come from what is actually on the page (roles, labels, text, fields, links). Do not invent pages, routes, fields, or copy.
- Fill each relevant field with a realistic value; assert the outcome the page exposes (validation, success, navigation, new content).
- Assert concrete observable results (visible text, URL, element state, a response) — never restate the test's intent.

[BEHAVIOR & TIMING]
- If a [PAGE BEHAVIOR] block is present, use its HINT/numbers to size timeouts to the observed settle time, not Playwright defaults.
- Navigate with page.goto(url, { waitUntil: "domcontentloaded" }). Do NOT rely on the default "load" event: real apps hold resources open and it times out.
- NEVER wait for "networkidle" — apps with websockets/SSE/polling never go idle, so it always times out. Wait on a concrete signal instead: waitForURL, waitForResponse, or expect(locator).toBeVisible({ timeout }).
- After actions that navigate or load data, assert a specific element/URL/response is present rather than a global load state.
- If the page was slow, add explicit generous timeouts on the elements/URLs you assert; prefer waitForResponse on any listed slow endpoints in the flow.

[RULES]
- Selector priority: getByRole > getByLabel > getByPlaceholder > getByTestId > getByText.
- Every locator you assert/act on MUST resolve to exactly ONE element (Playwright strict mode fails otherwise). The same name often appears twice (a sidebar link AND a breadcrumb, a heading AND a link). Disambiguate by scoping to a landmark — page.getByRole("navigation").getByRole("link", { name: "X" }) or page.getByRole("main")… — or use { exact: true }, or .first() only when any match is truly acceptable.
- If a [LIVE DOM CONTEXT] block is present, use ONLY selectors from it. Do not invent.
${urlRule}
- If [LIVE DOM CONTEXT] includes [PREREQUISITES], add beforeEach handling them; use env vars for credentials.
- No fixed sleeps. NEVER emit page.waitForTimeout, setTimeout, or sleep.
  Use web-first assertions with a timeout, waitForURL, or waitForResponse (never waitForLoadState("networkidle")).
- No vague assertions (expect(true).toBe(true)).
- No deprecated APIs. No Jest/Vitest syntax.
- Use TypeScript types and async/await correctly.`;
    },

    formatSiteKnowledgeSection(siteKnowledge: SiteKnowledge, baseURL?: string | null): string {
        const { formatSiteKnowledge } = require("../site-discovery");
        return `\n${formatSiteKnowledge(siteKnowledge, baseURL)}`;
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

    // Memory is a *hint from past runs*, always subordinate to the live DOM.
    // The LIVE DOM CONTEXT is the source of truth; these only break ties or
    // guide style when the same element genuinely appears on the current page.
    if (memory.selectorStrategy || memory.successfulSelectors.length > 0) {
        sections.push(
            `\n[MEMORY — HINTS ONLY]
- The [LIVE DOM CONTEXT] below is authoritative. Only use a selector if it is present there.
- Treat everything in this section as a preference from past runs, not a fact about this page.`,
        );
    }

    if (memory.selectorStrategy) {
        sections.push(
            `- When the live DOM offers a choice, prefer the ${memory.selectorStrategy} style.`,
        );
    }

    if (memory.successfulSelectors.length > 0) {
        sections.push(`- Selectors that worked before (reuse ONLY if the same element is in the live DOM):
${memory.successfulSelectors.map((s) => `  - ${s.element}: ${s.selector} (${s.type})`).join("\n")}`);
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
- targetAction: the concrete on-page control the user wants located or performed (e.g. "sign out", "add to cart", "delete account"). null when the request is not about a specific UI action.
- performAction=true when the user wants that action actually carried out in the browser now (e.g. "sign out", "log me out", "click delete"); false when they only ask about it or want a test written for it.
- isContinuation=true ONLY when directly replying to the Pause below; false otherwise or when no Pause.

History:
${historyText}

StoredGoal: activeGoal=${storedGoal.activeGoal ?? "null"} | feature=${storedGoal.targetFeature ?? "null"} | url=${storedGoal.targetUrl ?? "null"} | nextTool=${storedGoal.nextTool ?? "null"} | missing=${(storedGoal.missingContext || []).join(", ") || "none"}
${pauseContext}
CurrentPrompt:
${input.userPrompt}

Schema:
{"intent":"explore|generateTests|explain","goal":string|null,"targetFeature":string|null,"targetUrl":string|null,"targetAction":string|null,"performAction":boolean,"nextTool":"domCapture|codeSearch|testGen|explain|discoveryRead|none"|null,"missingContext":string[],"shouldRunTests":boolean,"isContinuation":boolean}`;
}
