import path from "node:path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { ProjectContext } from "../../../analysis/project-context";
import { authCredentialEnvGuidance } from "../../../config/auth-credentials";
import { resolveAuthStorageStateRelativePath } from "../../../config/auth-state";
import { assessAssertionPolarity } from "../../../cover/draft-quality";
import {
    injectStorageState,
    resolveGotoPathsAgainstBaseUrl,
} from "../../../testing/spec-normalize";
import { validateTestCode } from "../../../testing/test-code-validation";
import { cleanGeneratedTestCode } from "../../../utils";
import {
    LLM_REQUEST_TIMEOUT_MS,
    modelSupportsStructuredOutput,
    resolveAIConfig,
} from "../../ai-providers";
import type { GroundingReport } from "../../grounding";
import {
    collectSourceSelectors,
    describeGroundingViolations,
    formatAssertionPolarityCorrection,
    formatGroundingCorrection,
    formatGroundingRejection,
    validateSelectorGrounding,
} from "../../grounding";
import { AgentMemory } from "../../memory";
import { buildPromptMessages } from "../../prompt-messages";
import type { ContextData } from "../../prompts";
import { NO_CONTEXT_HELP_MESSAGE, NO_EXPLORATION_CONTEXT_MESSAGE } from "../../prompts";
import type { GraphStateType } from "../state";
import type { AuthPrecondition, ContextPlan } from "../utils";
import { normalizeSelector, parseSummaryElements, shouldUseStorageState } from "../utils";
import type { AgentNodeDeps } from "./types";

const PAGE_SUMMARIES_MAX_CHARS = 3000;

/**
 * True when the user's request is about viewing/interacting with a live page
 * rather than code — the signal that answering from the real DOM matters.
 * Requires a browse verb AND a page-ish noun so "explain the auth flow in
 * code" doesn't spin up a browser.
 */
function looksLikeLivePageQuestion(prompt: string): boolean {
    return (
        /\b(open|go to|navigate to|visit|load|browse|look at|check out|open up)\b/i.test(prompt) &&
        /(page|app|site|url|screen|view|home|dashboard|profile|settings|login|sign[- ]?in|landing|route|tab|listing|detail)/i.test(
            prompt,
        )
    );
}

/**
 * Resolve the URL a live-page question should open: an explicit target first,
 * then the Playwright baseURL, then the app origin inferred from discovery.
 */
async function resolveLiveBrowseUrl(
    projectPath: string,
    targetUrl: string | null,
): Promise<string | null> {
    if (targetUrl && /^https?:\/\//i.test(targetUrl)) return targetUrl;
    if (targetUrl) {
        try {
            const { getAppOrigin } = await import("./auth-entry");
            const origin = await getAppOrigin(projectPath);
            if (origin) return new URL(targetUrl, origin).toString();
        } catch {
            /* fall through to baseURL */
        }
    }
    try {
        const { readPlaywrightBaseURL } = await import("../../../testing/playwright-config");
        const baseURL = await readPlaywrightBaseURL(projectPath);
        if (baseURL) return baseURL;
    } catch {
        /* no config */
    }
    try {
        const { getAppOrigin } = await import("./auth-entry");
        return await getAppOrigin(projectPath);
    } catch {
        return null;
    }
}

/**
 * Render a completed goal-directed action (e.g. "sign out") as a prompt block
 * so both the answer and the generated test reflect the exact path taken:
 * which page, which control, and whether it was performed.
 */
function formatActionResult(state: GraphStateType): string | null {
    const result = state.actionResult;
    if (!result || !result.found) return null;
    const lines = [
        "[ACTION PATH]",
        `- Action: ${result.action}`,
        `- Located on page: ${result.page ?? "current page"}`,
    ];
    if (result.selector) lines.push(`- Control selector: ${result.selector}`);
    lines.push(`- How it was reached: ${result.note}`);
    lines.push(`- Performed in browser: ${result.performed ? "yes" : "no"}`);
    return lines.join("\n");
}

/** Render the context plan so the generator knows what was assembled and why. */
function formatContextPlan(plan: ContextPlan | null | undefined): string | null {
    if (!plan) return null;
    const lines = ["[CONTEXT PLAN]", `- Rationale: ${plan.rationale}`];
    if (plan.searchQueries.length > 0) {
        lines.push(`- Code searched for: ${plan.searchQueries.join("; ")}`);
    }
    if (plan.domAspects.length > 0) {
        lines.push(`- Focus the test on these UI aspects: ${plan.domAspects.join("; ")}`);
    }
    return lines.join("\n");
}

/**
 * Surface every action path the agent has previously located (not just
 * logout) — e.g. "add to cart", "delete account" — so the generator reuses the
 * exact page + selector instead of guessing.
 */
function formatKnownActions(projectPath: string): string | null {
    let actions: Array<{ action: string; page: string | null; selector: string | null }> = [];
    try {
        actions = AgentMemory.getInstance(projectPath)
            .getActionPaths()
            .filter((a) => a.selector);
    } catch {
        return null;
    }
    if (actions.length === 0) return null;
    const lines = ["[KNOWN ACTIONS — located live in this app; prefer these selectors]"];
    for (const a of actions.slice(0, 20)) {
        lines.push(`- ${a.action}: ${a.selector}${a.page ? ` (on ${a.page})` : ""}`);
    }
    return lines.join("\n");
}

interface StoredLoginContext {
    url: string | null;
    fields: Array<{ label: string; type: string | null; selector: string | null }>;
    submit: string | null;
}

interface StoredActionPath {
    page: string | null;
    selector: string | null;
    note?: string;
}

/**
 * Path (relative to the project root) of a reusable Playwright storageState, if
 * one exists. Mirrors `resolveAuthStatePath` in tools.ts but returns a RELATIVE
 * path suitable for `test.use({ storageState })` (Playwright resolves it against
 * the config directory, i.e. the project root). Returns null when no captured
 * session is available. This is the signal that the app requires auth AND we
 * already have a signed-in session to reuse — the key to making generated tests
 * run authenticated instead of stalling at a login wall.
 */
function resolveAuthStateRelPath(projectPath: string): string | null {
    return resolveAuthStorageStateRelativePath(projectPath);
}

/**
 * Guidance telling the model to reuse a captured signed-in session via
 * `test.use({ storageState })`. Emitted for EVERY generation (not just auth
 * tasks) when a session exists, because most tests target authenticated pages —
 * without this the model, seeing an app that needs auth but no login flow,
 * invents a `test.skip`/TODO and the test never runs (the exact bug reported).
 */
function formatStorageStateGuidance(relPath: string): string {
    return [
        "[AUTHENTICATION — a reusable signed-in session is available]",
        `- This app requires authentication and a valid Playwright storage state exists at "${relPath}".`,
        "- Reuse it so every test runs as an already-authenticated user. Add this line EXACTLY ONCE, right after the imports and before any test.describe/test:",
        `    test.use({ storageState: ${JSON.stringify(relPath)} });`,
        "- Treat the browser as already signed in. Do NOT navigate to a login page, do NOT implement a login flow, do NOT call test.skip for authentication, and do NOT add TODOs about login.",
        "- Assert authenticated-only UI and behaviour directly (the app will be on its post-login pages).",
    ].join("\n");
}

function formatAuthPreconditionGuidance(precondition: AuthPrecondition): string | null {
    if (precondition === "authenticated") return null;
    if (precondition === "unauthenticated") {
        return [
            "[AUTH PRECONDITION — start logged out]",
            "- Do NOT add test.use({ storageState }) or load any saved authentication state.",
            "- Use a fresh Playwright context and assert the logged-out page, redirect, or access denial requested by the user.",
            "- Do not sign in unless the requested scenario explicitly requires it.",
        ].join("\n");
    }
    return [
        "[AUTH PRECONDITION — exercise the real login flow]",
        "- Start from a fresh logged-out Playwright context.",
        "- Do NOT add test.use({ storageState }) or load any saved authentication state.",
        "- Perform login, MFA, OTP, or logout steps using only the observed routes and selectors below.",
        "- Read secrets from environment variables; never hardcode credentials.",
    ].join("\n");
}

/**
 * Deterministically ensure a generated spec reuses the captured session, so the
 * fix doesn't depend on the model remembering to add the line. Inserts
 * `test.use({ storageState })` right after the import block when the code
 * doesn't already reference a storage state. Idempotent.
 */
/**
 * Build an [AUTH FLOW] block from what the agent actually observed while going
 * through the app: the real login page URL + fields (captured when the login
 * form was on screen), and a logout control if one was found. This is what
 * stops auth specs from being generated against an invented "/login" route and
 * makes them state-aware (log out first if a session exists, then log in).
 *
 * When a reusable session exists (`hasStorageState`), the "no login observed"
 * fallback is suppressed — the storageState guidance handles that case, and a
 * TODO-to-implement-login would directly contradict it.
 */
function formatAuthFlow(
    projectPath: string,
    state: GraphStateType,
    hasStorageState: boolean,
): string | null {
    if (state.authPrecondition !== "login_flow") return null;

    let login: StoredLoginContext | null = null;
    let logout: StoredActionPath | null = null;
    // Guard each parse independently: a single malformed preference must not
    // disable the whole auth block (previously one bad value skipped both).
    const safeParse = <T>(raw: string | null | undefined): T | null => {
        if (!raw) return null;
        try {
            return JSON.parse(raw) as T;
        } catch {
            return null;
        }
    };
    try {
        const memory = AgentMemory.getInstance(projectPath);
        login = safeParse<StoredLoginContext>(memory.getPreference("auth_login"));
        logout =
            safeParse<StoredActionPath>(memory.getPreference("action_path:sign out")) ||
            safeParse<StoredActionPath>(memory.getPreference("action_path:log out")) ||
            safeParse<StoredActionPath>(memory.getPreference("action_path:logout"));
    } catch {
        /* memory unavailable — skip the block */
    }

    // Nothing observed live. Rather than silently letting the model invent a
    // "/login" route, explicitly forbid guessing and point it at the grounded
    // routes/DOM (or a TODO) — this is an auth task, so guidance still helps.
    // BUT if a reusable session exists, defer entirely to the storageState
    // guidance: telling the model to "add a login TODO" here would contradict
    // "reuse the signed-in session" and reproduce the stalls-at-login bug.
    if (!login?.url && !logout?.selector) {
        if (hasStorageState) return null;
        return [
            "[AUTH FLOW]",
            "- No login flow was observed live in this session.",
            '- Do NOT invent a login route such as "/login" or "/signin".',
            "- Use only routes/selectors from the Discovered Routes and live DOM sections above.",
            "- If the real login route/selectors are unknown, add a clear TODO comment in the test instead of guessing.",
            "- Read credentials from environment variables; never hardcode them.",
        ].join("\n");
    }

    const lines = ["[AUTH FLOW — observed live in this app; use verbatim, do not invent routes]"];
    if (login?.url) {
        let pathPart = login.url;
        try {
            pathPart = new URL(login.url).pathname || login.url;
        } catch {
            /* not absolute */
        }
        lines.push(`- Login page URL: ${login.url}  (path: ${pathPart})`);
    }
    if (login?.fields?.length) {
        for (const f of login.fields) {
            if (!f.selector) continue;
            lines.push(
                `- Login field "${f.label}"${f.type ? ` [type=${f.type}]` : ""}: ${f.selector}`,
            );
        }
    }
    if (login?.submit) lines.push(`- Login submit: ${login.submit}`);
    if (logout?.selector) {
        lines.push(
            `- Logout control: ${logout.selector}${logout.page ? ` (on ${logout.page})` : ""}`,
        );
    }

    lines.push("");
    lines.push("Authentication test requirements:");
    lines.push(
        "- Use the observed login page URL above — never guess a route like /login or /signin.",
    );
    lines.push(
        "- Do NOT assume the app starts logged out: a saved session may exist. Establish a known state first (e.g. clear state / start unauthenticated, or if already logged in, log out).",
    );
    lines.push("- Read credentials from environment variables, never hardcode them.");
    if (logout?.selector) {
        lines.push(
            "- Cover the full cycle: if logged in, log out, then log in again; assert both the logged-out and logged-in states.",
        );
    } else {
        lines.push(
            "- Perform login via the observed fields and assert the authenticated result (URL change or an authenticated-only element); also assert an error on invalid credentials.",
        );
    }
    return lines.join("\n");
}

function truncatePageSummaries(summaries: string[]): string {
    const lines: string[] = [];
    let totalChars = 0;
    for (let i = 0; i < summaries.length; i++) {
        const entry = `--- Page ${i + 1} ---\n${summaries[i]}`;
        if (totalChars + entry.length > PAGE_SUMMARIES_MAX_CHARS) {
            lines.push(`... and ${summaries.length - i} more pages (truncated)`);
            break;
        }
        lines.push(entry);
        totalChars += entry.length;
    }
    return lines.join("\n\n");
}

const contextPlanSchema = z.object({
    searchQueries: z
        .array(z.string())
        .describe(
            "2-4 focused code-search queries that would surface the code most relevant to writing this test (e.g. component names, feature keywords, route/handler names). Order by importance.",
        ),
    focusFiles: z
        .array(z.string())
        .describe(
            "Specific file paths you already believe are relevant (from the prompt, @mentions, or explored pages). Empty array if none are known.",
        ),
    domAspects: z
        .array(z.string())
        .describe(
            "Which parts of the live UI matter for this test: e.g. 'login form fields', 'submit button', 'validation errors', 'post-submit navigation', 'async loading states'.",
        ),
    rationale: z.string().describe("One sentence: what should be gathered and why."),
});

const MAX_PLAN_QUERIES = 4;
const MAX_MERGED_FILES = 12;

/**
 * Ask the model what context to assemble before writing the test. Fails open
 * (returns a minimal single-query plan) so a planner error never blocks
 * generation.
 */
async function planTestContext(deps: AgentNodeDeps, state: GraphStateType): Promise<ContextPlan> {
    const basePrompt = state.activeGoal || state.targetFeature || state.userPrompt;
    const fallback: ContextPlan = {
        searchQueries: [basePrompt].filter(Boolean),
        focusFiles: state.fileContext || [],
        domAspects: [],
        rationale: "Default single-query gather (planner unavailable).",
    };
    // Models known to reject response_format (e.g. deepseek-chat) get the
    // fallback directly — the structured-output request would 400 and the
    // provider's raw error would be logged as if something went wrong.
    try {
        const resolved = resolveAIConfig(deps.projectPath);
        if (!modelSupportsStructuredOutput(resolved.provider, resolved.model)) {
            return {
                ...fallback,
                rationale: `Single-query gather (${resolved.model} does not support structured output).`,
            };
        }
    } catch {
        // Config unavailable — attempt the structured call as before.
    }
    try {
        const pagesSeen = (state.pageSummaries || [])
            .map((s, i) => `  ${i + 1}. ${extractPageTitleSafe(s)}`)
            .slice(0, 8)
            .join("\n");
        const planner = deps.model.withStructuredOutput(contextPlanSchema, {
            name: "plan_test_context",
        });
        const system = [
            "You are planning what context to gather before writing an end-to-end (Playwright) test.",
            "Decide the minimal set of code-search queries, known files, and live-DOM aspects needed.",
            "Be specific and concise. Do not invent file paths you have no evidence for.",
        ].join(" ");
        const human = [
            `User request: ${state.userPrompt}`,
            state.activeGoal ? `Goal: ${state.activeGoal}` : "",
            state.targetFeature ? `Feature: ${state.targetFeature}` : "",
            state.targetUrl ? `URL: ${state.targetUrl}` : "",
            state.fileContext && state.fileContext.length > 0
                ? `Files the user referenced: ${state.fileContext.join(", ")}`
                : "",
            pagesSeen ? `Pages explored so far:\n${pagesSeen}` : "",
            state.actionResult?.found
                ? `A UI action was located: ${state.actionResult.action} (selector: ${state.actionResult.selector ?? "n/a"}).`
                : "",
        ]
            .filter(Boolean)
            .join("\n");
        const plan = await planner.invoke([new SystemMessage(system), new HumanMessage(human)], {
            timeout: LLM_REQUEST_TIMEOUT_MS,
        });
        const searchQueries =
            plan.searchQueries && plan.searchQueries.length > 0
                ? plan.searchQueries.slice(0, MAX_PLAN_QUERIES)
                : fallback.searchQueries;
        return {
            searchQueries,
            focusFiles: Array.from(
                new Set([...(state.fileContext || []), ...(plan.focusFiles || [])]),
            ),
            domAspects: plan.domAspects || [],
            rationale: plan.rationale || fallback.rationale,
        };
    } catch (error) {
        console.warn(
            "Context planner failed, using single-query gather:",
            error instanceof Error ? error.message : error,
        );
        return fallback;
    }
}

function extractPageTitleSafe(summary: string): string {
    const match = summary.match(/Page Title:\s*(.+)/i);
    return (match?.[1] || "(untitled)").trim();
}

/** Merge several ContextData results, deduping files by path (highest score wins). */
function mergeContexts(contexts: ContextData[]): ContextData | null {
    const nonEmpty = contexts.filter(Boolean);
    if (nonEmpty.length === 0) return null;
    const base = nonEmpty[0];
    const byPath = new Map<string, ContextData["files"][number]>();
    for (const ctx of nonEmpty) {
        for (const file of ctx.files) {
            const existing = byPath.get(file.path);
            if (!existing || file.relevanceScore > existing.relevanceScore) {
                byPath.set(file.path, file);
            }
        }
    }
    const mergedFiles = Array.from(byPath.values())
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, MAX_MERGED_FILES);
    return {
        ...base,
        files: mergedFiles,
        totalTokens: mergedFiles.reduce((sum, f) => sum + Math.ceil(f.fullContext.length / 4), 0),
    };
}

export const createGatherContextNode = (deps: AgentNodeDeps) => async (state: GraphStateType) => {
    const { gatherContext, projectPath } = deps;
    const contextPrompt = state.activeGoal || state.targetFeature || state.userPrompt;

    // For test generation, plan the gather first (multiple targeted queries
    // + focus files + DOM aspects) so the prompt is rich and deliberate.
    if (state.intent === "generateTests") {
        try {
            const plan = await planTestContext(deps, state);
            const gathered: ContextData[] = [];
            for (const query of plan.searchQueries) {
                try {
                    gathered.push(await gatherContext(query, projectPath, plan.focusFiles));
                } catch (err) {
                    console.warn(
                        `gatherContext failed for query "${query}":`,
                        err instanceof Error ? err.message : err,
                    );
                }
            }
            if (gathered.length === 0) {
                gathered.push(await gatherContext(contextPrompt, projectPath, plan.focusFiles));
            }
            const merged = mergeContexts(gathered);
            return {
                context: merged,
                testDirectory: merged?.testDirectory,
                contextPlan: plan,
            };
        } catch (error) {
            console.warn(
                "Planned gather failed, falling back:",
                error instanceof Error ? error.message : error,
            );
            // Fall through to the simple single-query gather below.
        }
    }

    try {
        const context = await gatherContext(contextPrompt, projectPath, state.fileContext);
        return {
            context,
            testDirectory: context.testDirectory,
        };
    } catch (error) {
        // DB / embedding failures must not reject graph.invoke. Continue with
        // an empty context so downstream nodes degrade gracefully.
        console.warn("gatherContext failed:", error instanceof Error ? error.message : error);
        return {};
    }
};

export const createGenerateTestsNode =
    ({
        gatherContext,
        projectPath,
        model,
        buildSystemPrompt,
        getMemoryContext,
        onProgress,
        onToken,
        signal,
    }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        const context =
            state.context ||
            (await gatherContext(state.userPrompt, projectPath, state.fileContext));
        // Generation needs *some* grounding: code files, a live DOM snapshot, or
        // explored/discovered page summaries. Previously we only accepted code
        // files or domSummary, so a purely site-knowledge run (discovery data,
        // no matching source files) fell through to the "no context" help.
        const hasGrounding =
            context.files.length > 0 ||
            !!state.domSummary ||
            (state.pageSummaries?.length ?? 0) > 0;
        if (!hasGrounding) {
            return {
                failure: NO_CONTEXT_HELP_MESSAGE,
                summary: NO_CONTEXT_HELP_MESSAGE,
            };
        }

        const memoryContext = getMemoryContext();
        let systemPrompt = buildSystemPrompt(context, state.userPrompt, "golden-v1", memoryContext);

        const planBlock = formatContextPlan(state.contextPlan);
        if (planBlock) {
            systemPrompt = `${systemPrompt}\n\n${planBlock}`;
        }

        // A reusable signed-in session (captured storageState) turns "this app
        // needs auth" from a blocker into a one-liner. Surface it FIRST so the
        // model writes authenticated tests instead of login TODOs/skips.
        //
        // BUT never inject it when the goal is to test the UNAUTHENTICATED / login
        // experience: loading a signed-in storageState there would skip the very
        // login page under test (and a stale one would just add noise). Keep the
        // test genuinely logged-out.
        const authStateRel = shouldUseStorageState(state.authPrecondition)
            ? resolveAuthStateRelPath(projectPath)
            : null;
        if (authStateRel) {
            systemPrompt = `${systemPrompt}\n\n${formatStorageStateGuidance(authStateRel)}`;
        }

        const authPreconditionBlock = formatAuthPreconditionGuidance(state.authPrecondition);
        if (authPreconditionBlock) {
            systemPrompt = `${systemPrompt}\n\n${authPreconditionBlock}`;
        }
        if (state.authPrecondition === "login_flow") {
            const credentialGuidance = authCredentialEnvGuidance(projectPath);
            if (credentialGuidance) {
                systemPrompt = `${systemPrompt}\n\n[CONFIGURED AUTH ENVIRONMENT VARIABLES]\n${credentialGuidance}\n- Fail clearly when a required variable is missing; never hardcode or print its value.`;
            }
        }

        const authBlock = formatAuthFlow(projectPath, state, !!authStateRel);
        if (authBlock) {
            systemPrompt = `${systemPrompt}\n\n${authBlock}`;
        }

        const knownActionsBlock = formatKnownActions(projectPath);
        if (knownActionsBlock) {
            systemPrompt = `${systemPrompt}\n\n${knownActionsBlock}`;
        }

        if (state.pageSummaries && state.pageSummaries.length > 1) {
            const truncated = truncatePageSummaries(state.pageSummaries);
            systemPrompt = `${systemPrompt}\n\n[PAGES EXPLORED]\n${truncated}`;
        }

        if (state.domSummary) {
            systemPrompt = `${systemPrompt}\n\n${state.domSummary}`;
        }

        const actionBlock = formatActionResult(state);
        if (actionBlock) {
            systemPrompt = `${systemPrompt}\n\n${actionBlock}`;
        }

        const groundingSummaries = [state.domSummary, ...(state.pageSummaries || [])].filter(
            (s): s is string => typeof s === "string" && s.length > 0,
        );

        /**
         * One full generation pass. `correction` carries grounding violations
         * from the previous pass; `allowStreaming` is false for retries because
         * `onToken` appends to the live editor buffer, so streaming a second
         * draft would show both concatenated.
         */
        const generateDraft = async (
            correction: string | undefined,
            allowStreaming: boolean,
        ): Promise<string> => {
            const prompt = correction ? `${systemPrompt}\n\n${correction}` : systemPrompt;
            const messages = buildPromptMessages(
                buildSystemPrompt({ ...context, files: [], siteKnowledge: null }, "", "golden-v1"),
                prompt,
                state.userPrompt,
                state.conversationHistory,
            );

            // Stream tokens live when the model supports it so the dashboard
            // shows the test being written instead of a long silent wait. Fall
            // back to a single invoke() when streaming isn't available.
            let content = "";
            if (allowStreaming && onToken && typeof model.stream === "function") {
                try {
                    const stream = await model.stream(messages, {
                        timeout: LLM_REQUEST_TIMEOUT_MS,
                        signal,
                    });
                    for await (const chunk of stream) {
                        const part = Array.isArray(chunk.content)
                            ? chunk.content
                                  .map((p) => (typeof p === "string" ? p : p?.text || ""))
                                  .join("")
                            : (chunk.content as string);
                        if (part) {
                            content += part;
                            onToken(part);
                        }
                    }
                } catch (streamError) {
                    // Streaming failed. If nothing streamed yet, fall back to a
                    // plain invoke below. If we already streamed a partial draft,
                    // keep it (re-invoking would duplicate the streamed tokens).
                    if (signal?.aborted) throw streamError;
                    console.warn(
                        "Test generation streaming failed:",
                        streamError instanceof Error ? streamError.message : streamError,
                    );
                }
            }

            if (!content) {
                const response = await model.invoke(messages, {
                    timeout: LLM_REQUEST_TIMEOUT_MS,
                    signal,
                });
                content = Array.isArray(response.content)
                    ? response.content
                          .map((part) => (typeof part === "string" ? part : part?.text || ""))
                          .join("")
                    : (response.content as string);
            }

            // Clean at generation time (strip code fences / normalize) so the
            // draft equals what lands on disk — the editor buffer must match the
            // saved file, and malformed fences must never reach save.
            let cleaned = content ? cleanGeneratedTestCode(content) : "";

            // Safety net: deterministically wire in the captured session so the
            // spec runs authenticated even if the model omitted the line. Without
            // this, a fresh `playwright test` browser is logged out and the test
            // stalls at the login wall.
            if (cleaned && authStateRel) {
                cleaned = injectStorageState(cleaned, authStateRel);
            }
            // A baseURL served from a sub-path makes a root-absolute goto
            // resolve to the origin instead of the app, so every later
            // locator times out on a page the test never opened.
            if (cleaned) {
                cleaned = resolveGotoPathsAgainstBaseUrl(cleaned, context.baseURL ?? null);
            }
            return cleaned;
        };

        onProgress?.("Generating test");
        try {
            // Grounding gates generation because nothing downstream re-checks it:
            // `hitlSave` writes any truthy draft and `hitlRun` runs it.
            //
            // A locator the capture *contradicts* (right element, wrong role) is
            // proof the draft is broken, so it never reaches save. A locator the
            // capture simply doesn't contain is reported, not blocked — a
            // validation error, a modal, or a later page exists only in a state
            // we never captured, and refusing those would refuse most
            // negative-path tests. Either way the model gets one corrective pass
            // with the specific locators named.
            const MAX_GROUNDING_PASSES = 2;
            let previous: GroundingReport | null = null;
            // Selector facts from indexed markup. State-gated UI (a filled
            // cart, a validation error) never shows up in a crawl of resting
            // pages, so a draft that targets it correctly must not be pushed
            // through a corrective pass that can only make it guessier.
            const sourceSelectors = collectSourceSelectors(context.files);
            // A regeneration pass is not guaranteed to improve the draft — the
            // model can replace flagged-but-correct locators with different
            // guesses. Keep every pass and ship the one with the fewest
            // violations, not the most recent one.
            const violationScore = (report: GroundingReport, invertedAssertions = false): number =>
                report.contradictions.length * 10 +
                report.unverified.length +
                (invertedAssertions ? 5 : 0);
            let best: { draft: string; grounding: GroundingReport; score: number } | null = null;
            // Carries the polarity complaint into the next pass's correction.
            let previousPolarityReason: string | null = null;

            for (let pass = 1; pass <= MAX_GROUNDING_PASSES; pass++) {
                const correction =
                    [
                        previous ? formatGroundingCorrection(previous) : "",
                        previousPolarityReason
                            ? formatAssertionPolarityCorrection(
                                  state.userPrompt,
                                  previousPolarityReason,
                              )
                            : "",
                    ]
                        .filter(Boolean)
                        .join("\n\n") || undefined;
                const cleaned = await generateDraft(correction, pass === 1);

                const validation = validateTestCode(cleaned);
                if (!validation.ok) {
                    console.warn(`Generated test draft rejected: ${validation.reason}`);
                    return {
                        testDraft: "",
                        failure: `Test generation produced output that wasn't usable (${validation.reason}). This can happen when a streamed response gets interrupted — try again.`,
                        summary: `Test generation produced output that wasn't usable (${validation.reason}). This can happen when a streamed response gets interrupted — try again.`,
                        context,
                        testDirectory: context.testDirectory,
                    };
                }

                const grounding = validateSelectorGrounding(
                    cleaned,
                    groundingSummaries,
                    sourceSelectors,
                );
                // A draft whose every assertion checks for absence is the shape
                // an inverted request takes — and it passes on a blank page, so
                // nothing downstream would catch it. Worth one corrective pass;
                // never a hard block, because "the deleted row is gone" is a
                // legitimate all-negative test.
                const polarity = assessAssertionPolarity(cleaned);
                if (!best || violationScore(grounding, polarity.allNegative) < best.score) {
                    best = {
                        draft: cleaned,
                        grounding,
                        score: violationScore(grounding, polarity.allNegative),
                    };
                }
                const lastPass = pass === MAX_GROUNDING_PASSES;
                const clean =
                    (!grounding.enforceable ||
                        (grounding.contradictions.length === 0 &&
                            grounding.unverified.length === 0)) &&
                    !polarity.allNegative;

                if (clean || lastPass) {
                    // On the last pass, fall back to the best draft seen — the
                    // final regeneration may have scored worse than an earlier
                    // attempt it was supposed to improve on.
                    const chosen = clean ? { draft: cleaned, grounding } : best;

                    if (
                        chosen.grounding.enforceable &&
                        chosen.grounding.contradictions.length > 0
                    ) {
                        for (const line of describeGroundingViolations(
                            chosen.grounding.contradictions,
                        )) {
                            console.warn(`Ungrounded selector: ${line}`);
                        }
                        return {
                            testDraft: "",
                            groundingViolations: chosen.grounding.contradictions,
                            failure: formatGroundingRejection(chosen.grounding.contradictions),
                            summary: formatGroundingRejection(chosen.grounding.contradictions),
                            context,
                            testDirectory: context.testDirectory,
                        };
                    }

                    for (const line of describeGroundingViolations([
                        ...chosen.grounding.unverified,
                        ...chosen.grounding.warnings,
                    ])) {
                        console.warn(`Selector not seen in any captured page: ${line}`);
                    }
                    if (chosen.grounding.sourceGrounded.length > 0) {
                        onProgress?.(
                            `${chosen.grounding.sourceGrounded.length} selector(s) grounded in source markup (state not yet captured live)`,
                        );
                    }
                    return {
                        testDraft: chosen.draft,
                        // Surfaced in the run summary so an unverifiable locator
                        // is visible to the user, not just to the log.
                        groundingViolations: chosen.grounding.unverified,
                        context,
                        testDirectory: context.testDirectory,
                    };
                }

                previous =
                    grounding.contradictions.length > 0 || grounding.unverified.length > 0
                        ? grounding
                        : null;
                previousPolarityReason = polarity.allNegative ? (polarity.reason ?? null) : null;
                onProgress?.(
                    previous
                        ? `Regenerating: ${
                              grounding.contradictions.length + grounding.unverified.length
                          } selector(s) don't match the captured DOM`
                        : "Regenerating: every assertion checks for absence — the requested check may have been inverted",
                );
            }

            // Unreachable: the loop always returns on its last pass.
            return { context, testDirectory: context.testDirectory };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("Test generation LLM call failed:", message);
            return {
                testDraft: "",
                failure: `Test generation failed: ${message}. Check your API key and network connection.`,
                summary: `Test generation failed: ${message}. Check your API key and network connection.`,
                context,
                testDirectory: context.testDirectory,
            };
        }
    };

export const createAnswerQuestionsNode =
    ({
        callTool,
        gatherContext,
        projectPath,
        model,
        buildExplorationPrompt,
        getMemoryContext,
        signal,
    }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        if (state.nextTool === "discoveryRead") {
            const formatDate = (value: number | null | undefined): string => {
                if (typeof value !== "number" || !Number.isFinite(value)) {
                    return "n/a";
                }
                return new Date(value).toISOString();
            };
            const requestedUrl = state.targetUrl;
            const shouldListPages = !requestedUrl;
            const shouldFetchSnapshot = Boolean(requestedUrl);

            const overviewResult = await callTool("getDiscoveryOverview", {});
            if (!overviewResult.success || !overviewResult.data) {
                return {
                    summary:
                        "Answers:\n- I could not load discovery data right now.\n\nEvidence:\n- getDiscoveryOverview returned an error.\n\nUnknowns / Next checks:\n- Verify discovery DB access and try again.",
                };
            }

            const overview = overviewResult.data as {
                stats: {
                    pagesCount: number;
                    linksCount: number;
                    verifiedLinksCount: number;
                    brokenLinksCount: number;
                    unresolvedBlockersCount: number;
                };
                latestSession: {
                    startUrl: string;
                    status: string;
                    startedAt: number;
                    completedAt: number | null;
                    blockedAtUrl: string | null;
                } | null;
            };

            if (overview.stats.pagesCount === 0) {
                return {
                    summary:
                        "Answers:\n- There are no discovered pages persisted yet.\n- Run site discovery first, then I can fetch pages and snapshots in chat.\n\nEvidence:\n- getDiscoveryOverview reports pagesCount = 0.\n\nUnknowns / Next checks:\n- Start a discovery run (for example `raiken discover <url>`), then ask me to list pages or show a snapshot URL.",
                };
            }

            const lines: string[] = [];
            lines.push("Answers:");
            lines.push(
                `- Discovery data is available: ${overview.stats.pagesCount} pages, ${overview.stats.linksCount} links, ${overview.stats.verifiedLinksCount} verified links.`,
            );
            if (overview.latestSession) {
                lines.push(
                    `- Latest session is ${overview.latestSession.status} (start: ${overview.latestSession.startUrl}).`,
                );
            }
            if (overview.stats.unresolvedBlockersCount > 0) {
                lines.push(
                    `- There are ${overview.stats.unresolvedBlockersCount} unresolved auth blockers.`,
                );
            }

            if (shouldListPages) {
                const pagesResult = await callTool("listDiscoveredPages", {
                    limit: 15,
                    offset: 0,
                });
                if (pagesResult.success && pagesResult.data) {
                    const pagesData = pagesResult.data as {
                        pages: Array<{
                            url: string;
                            title: string | null;
                            depth: number;
                            visitCount: number;
                        }>;
                        total: number;
                        hasMore: boolean;
                    };
                    const listed = pagesData.pages.slice(0, 8);
                    if (listed.length > 0) {
                        lines.push(
                            `- Top discovered pages (${listed.length}/${pagesData.total} shown):`,
                        );
                        for (const page of listed) {
                            lines.push(
                                `  - ${page.url} (depth ${page.depth}, visits ${page.visitCount}, title: ${page.title || "Untitled"})`,
                            );
                        }
                        if (pagesData.hasMore) {
                            lines.push(
                                "- More pages are available; ask for the next batch if needed.",
                            );
                        }
                    }
                }
            }

            if (shouldFetchSnapshot) {
                if (!requestedUrl) {
                    return {
                        summary:
                            "Answers:\n- I can fetch a discovered snapshot, but I need the exact page URL.\n\nEvidence:\n- nextTool was set to discoveryRead without a targetUrl.\n\nUnknowns / Next checks:\n- Provide the full page URL from discovery and ask again.",
                    };
                }
                const snapshotResult = await callTool("getDiscoveredPageSnapshot", {
                    url: requestedUrl,
                });
                if (snapshotResult.success) {
                    const snapshot = snapshotResult.data as {
                        url: string;
                        title: string | null;
                        depth: number;
                        snapshotJson: string | null;
                    } | null;
                    if (!snapshot) {
                        lines.push(`- No persisted snapshot was found for ${requestedUrl}.`);
                    } else if (!snapshot.snapshotJson) {
                        lines.push(
                            `- Snapshot exists for ${requestedUrl}, but the stored payload is empty.`,
                        );
                    } else {
                        const preview =
                            snapshot.snapshotJson.length > 700
                                ? `${snapshot.snapshotJson.slice(0, 700)}...`
                                : snapshot.snapshotJson;
                        lines.push(
                            `- Snapshot preview for ${snapshot.url} (depth ${snapshot.depth}, title: ${snapshot.title || "Untitled"}):`,
                        );
                        lines.push(`  ${preview}`);
                    }
                }
            }

            lines.push("");
            lines.push("Evidence:");
            lines.push("- Tool: getDiscoveryOverview");
            if (shouldListPages) {
                lines.push("- Tool: listDiscoveredPages");
            }
            if (shouldFetchSnapshot && requestedUrl) {
                lines.push("- Tool: getDiscoveredPageSnapshot");
            }
            if (overview.latestSession) {
                lines.push(
                    `- Session timestamps: started ${formatDate(overview.latestSession.startedAt)}, completed ${formatDate(overview.latestSession.completedAt)}`,
                );
            }

            lines.push("");
            lines.push("Unknowns / Next checks:");
            lines.push("- None.");

            return {
                summary: lines.join("\n"),
            };
        }

        // Live-page questions ("open the about page and tell me the heading")
        // should answer from the real DOM, not from code files alone. The
        // classifier can label such requests explain/none (leaving the browser
        // unopened), so heal here: best-effort navigate + capture when the
        // prompt implies browsing and no live DOM was captured yet. Failure
        // degrades to today's code/discovery-only answer.
        let liveDomSummary: string | null = null;
        if (!state.domSummary && looksLikeLivePageQuestion(state.userPrompt)) {
            try {
                const resolved = await resolveLiveBrowseUrl(projectPath, state.targetUrl);
                if (resolved) {
                    const nav = await callTool("navigateTo", { url: resolved });
                    if (nav.success) {
                        const captured = await callTool("captureCurrentPage", {});
                        const summary =
                            (captured.success &&
                                (captured.data as { summary?: string } | undefined)?.summary) ||
                            null;
                        if (summary) liveDomSummary = summary;
                    }
                }
            } catch {
                /* live browse is best-effort */
            }
        }

        const context =
            state.context ||
            (await gatherContext(state.userPrompt, projectPath, state.fileContext));
        if (context.files.length === 0 && !state.domSummary && !liveDomSummary) {
            return {
                summary: NO_EXPLORATION_CONTEXT_MESSAGE,
            };
        }

        const memoryContext = getMemoryContext();
        let systemPrompt = buildExplorationPrompt(
            context,
            state.userPrompt,
            memoryContext,
            state.intent,
            {
                activeGoal: state.activeGoal,

                targetFeature: state.targetFeature,
                targetUrl: state.targetUrl,
                missingContext: state.missingContext,
                nextTool: state.nextTool,
            },
        );

        if (state.pageSummaries && state.pageSummaries.length > 1) {
            const truncated = truncatePageSummaries(state.pageSummaries);
            systemPrompt = `${systemPrompt}\n\n[PAGES EXPLORED]\n${truncated}`;
        }

        if (state.domSummary) {
            systemPrompt = `${systemPrompt}\n\n[DOM SUMMARY]\n${state.domSummary}`;
        } else if (liveDomSummary) {
            systemPrompt = `${systemPrompt}\n\n[DOM SUMMARY]\n${liveDomSummary}`;
        }

        const actionBlock = formatActionResult(state);
        if (actionBlock) {
            systemPrompt = `${systemPrompt}\n\n${actionBlock}\nWhen the user asked to perform this action, report exactly where it was found and whether it was carried out.`;
        }

        const extractEvidenceInfo = (
            text: string,
        ): {
            hasEvidence: boolean;
            filePaths: string[];
            selectors: string[];
        } => {
            const lines = text.split("\n");
            let inEvidence = false;
            const evidenceLines: string[] = [];
            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (/^#{0,6}\s*Evidence\s*:?\s*$/i.test(line)) {
                    inEvidence = true;
                    continue;
                }
                if (inEvidence && /^#{0,6}\s*Unknowns/i.test(line)) {
                    break;
                }
                if (inEvidence) {
                    evidenceLines.push(line);
                }
            }
            if (evidenceLines.length === 0) {
                return { hasEvidence: false, filePaths: [], selectors: [] };
            }
            const filePathPattern =
                /\b[\w./-]+\.(ts|tsx|js|jsx|md|json|yaml|yml|css|scss|html|txt)\b/i;
            const domPattern = /\bDOM\b|selector|getByRole|getByTestId|data-testid|aria/i;
            const filePaths = evidenceLines.flatMap((line) => {
                const matches = line.match(filePathPattern);
                return matches ? matches : [];
            });
            const selectors = new Set<string>();
            for (const line of evidenceLines) {
                const selectorMatch = line.match(/^Selector:\s+(.+)$/i);
                if (selectorMatch?.[1]) {
                    selectors.add(selectorMatch[1].trim());
                }
                const locatorMatches = line.match(
                    /getBy(Role|TestId|Text|Label|Placeholder|AltText|Title)\([^)]+\)/g,
                );
                if (locatorMatches) {
                    for (const match of locatorMatches) {
                        selectors.add(match);
                    }
                }
                const dataTestIdMatches = line.match(/\[data-testid=["'][^"']+["']\]/g);
                if (dataTestIdMatches) {
                    for (const match of dataTestIdMatches) {
                        selectors.add(match);
                    }
                }
                const labelMatches = line.match(/label=("[^"]+"|'[^']+'|[^\s]+)/g);
                if (labelMatches) {
                    for (const match of labelMatches) {
                        selectors.add(match);
                    }
                }
                const placeholderMatches = line.match(/placeholder=("[^"]+"|'[^']+'|[^\s]+)/g);
                if (placeholderMatches) {
                    for (const match of placeholderMatches) {
                        selectors.add(match);
                    }
                }
                const altMatches = line.match(/alt=("[^"]+"|'[^']+'|[^\s]+)/g);
                if (altMatches) {
                    for (const match of altMatches) {
                        selectors.add(match);
                    }
                }
                const titleMatches = line.match(/title=("[^"]+"|'[^']+'|[^\s]+)/g);
                if (titleMatches) {
                    for (const match of titleMatches) {
                        selectors.add(match);
                    }
                }
                const cssMatches = line.match(/css=("[^"]+"|'[^']+'|[^\s]+)/g);
                if (cssMatches) {
                    for (const match of cssMatches) {
                        selectors.add(match);
                    }
                }
                const xpathMatches = line.match(/xpath=("[^"]+"|'[^']+'|[^\s]+)/g);
                if (xpathMatches) {
                    for (const match of xpathMatches) {
                        selectors.add(match);
                    }
                }
                const roleMatches = line.match(/role=[^\s\]]+(?:\[name="[^"]+"\])?/g);
                if (roleMatches) {
                    for (const match of roleMatches) {
                        selectors.add(match);
                    }
                }
                const textMatches = line.match(/text=("[^"]+"|'[^']+'|[^\s]+)/g);
                if (textMatches) {
                    for (const match of textMatches) {
                        selectors.add(match);
                    }
                }
            }
            const hasEvidence = evidenceLines.some(
                (line) => filePathPattern.test(line) || domPattern.test(line),
            );
            return { hasEvidence, filePaths, selectors: Array.from(selectors) };
        };

        const invokeWithPrompt = async (prompt: string): Promise<string> => {
            const response = await model.invoke(
                buildPromptMessages(
                    buildExplorationPrompt({ ...context, files: [], siteKnowledge: null }, ""),
                    prompt,
                    state.userPrompt,
                    state.conversationHistory,
                ),
                { timeout: LLM_REQUEST_TIMEOUT_MS, signal },
            );
            return Array.isArray(response.content)
                ? response.content
                      .map((part) => (typeof part === "string" ? part : part?.text || ""))
                      .join("")
                : response.content;
        };

        const normalizeEvidencePath = (value: string): string => {
            const cleaned = value.replace(/^[`"'[(]+|[`"')\],.:;]+$/g, "");
            if (path.isAbsolute(cleaned)) {
                return path.relative(projectPath, cleaned);
            }
            return cleaned;
        };

        let content: string;
        try {
            content = await invokeWithPrompt(systemPrompt);
        } catch (error) {
            // A provider timeout / rate-limit / network error here must not
            // reject graph.invoke and kill the whole run. Surface it as the
            // answer so the user gets a clear message instead of a crash.
            const message = error instanceof Error ? error.message : String(error);
            return {
                failure: `I couldn't complete the analysis due to an AI provider error: ${message}`,
                summary: `I couldn't complete the analysis due to an AI provider error: ${message}`,
                context,
            };
        }
        if (typeof content === "string") {
            try {
                const evidence = extractEvidenceInfo(content);
                if (!evidence.hasEvidence) {
                    content = `${content}\n\nNote: Evidence section lacks file paths or DOM references.`;
                } else if (evidence.filePaths.length > 0) {
                    const projectContext = ProjectContext.getInstance(projectPath);
                    if (!projectContext.isInitialized()) {
                        await projectContext.initialize();
                    }
                    const repoFileSet = new Set(projectContext.getAllFilePaths());
                    const contextFileSet = new Set(context.files.map((file) => file.path));
                    const normalized = evidence.filePaths.map(normalizeEvidencePath);
                    const missingInRepo = normalized.filter(
                        (filePath) => !repoFileSet.has(filePath),
                    );
                    const missingInContext = normalized.filter(
                        (filePath) => !contextFileSet.has(filePath),
                    );
                    if (missingInRepo.length > 0) {
                        content = `${content}\n\nNote: Evidence references files not found in the repo index: ${missingInRepo.join(
                            ", ",
                        )}.`;
                    } else if (missingInContext.length > 0) {
                        content = `${content}\n\nNote: Evidence references files not in retrieved context: ${missingInContext.join(
                            ", ",
                        )}.`;
                    }
                }
                if (state.domSummary && evidence.selectors.length > 0) {
                    const elements = parseSummaryElements(state.domSummary);
                    const domSelectors = new Set<string>();
                    for (const el of elements) {
                        for (const sel of el.selectors) {
                            domSelectors.add(sel);
                            const normalized = normalizeSelector(sel);
                            if (normalized) {
                                domSelectors.add(normalized);
                            }
                        }
                    }
                    if (domSelectors.size > 0) {
                        const missingSelectors = evidence.selectors.filter((selector) => {
                            const normalized = normalizeSelector(selector) || selector;
                            return !domSelectors.has(selector) && !domSelectors.has(normalized);
                        });
                        if (missingSelectors.length > 0) {
                            content = `${content}\n\nNote: Evidence references selectors not found in the DOM summary: ${missingSelectors.join(
                                ", ",
                            )}.`;
                        }
                    }
                }
            } catch {
                // Evidence validation is best-effort — never let it block the answer.
            }
        }

        return {
            summary: content || "",
            context,
        };
    };
