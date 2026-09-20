import { z } from "zod";
import { LLM_REQUEST_TIMEOUT_MS } from "../../ai-providers";
import { buildPromptMessages } from "../../prompt-messages";
import type { GraphStateType } from "../state";
import { resolveAuthPrecondition } from "../utils";
import { inferDiscoveryManagementAction } from "./discovery-management";
import type { AgentNodeDeps } from "./types";

const classifierSchema = z.object({
    intent: z
        .enum(["explore", "generateTests", "explain"])
        .describe(
            "The user's intent: 'explore' to navigate/discover a site, 'generateTests' to create E2E tests, 'explain' to answer questions about code or project",
        ),
    goal: z.string().nullable().describe("A short summary of what the user wants to achieve"),
    targetFeature: z
        .string()
        .nullable()
        .describe("The specific feature or component the user is asking about"),
    targetUrl: z.string().nullable().describe("A URL mentioned or implied by the user, if any"),
    targetAction: z
        .string()
        .nullable()
        .describe(
            "The concrete on-page action/control the user wants the agent to find or perform, e.g. 'sign out', 'add to cart', 'delete account'. Null if the request is not about performing a specific UI action.",
        ),
    performAction: z
        .boolean()
        .describe(
            "True when the user wants the action actually carried out in the browser (e.g. 'sign out', 'log me out', 'click delete'), false when they only ask about it or want a test written for it.",
        ),
    nextTool: z
        .enum([
            "domCapture",
            "codeSearch",
            "testGen",
            "explain",
            "discoveryRead",
            "discoveryManage",
            "none",
        ])
        .nullable()
        .describe(
            "The best tool to use next: 'domCapture' for browser/UI work, 'codeSearch' for finding code, 'testGen' for test generation, 'explain' for explanations, 'discoveryRead' for reading site discovery data, 'discoveryManage' for clearing or starting site discovery, 'none' for no specific tool",
        ),
    discoveryAction: z
        .enum(["clear", "start", "clearAndStart"])
        .nullable()
        .describe("The requested site-discovery mutation, or null for read-only requests"),
    missingContext: z
        .array(z.string())
        .describe("List of information still needed to fulfill the request"),
    shouldRunTests: z
        .boolean()
        .describe(
            "True if the user explicitly wants to run/execute/verify the generated tests, not just generate them. Only true when the user says things like 'run the tests', 'execute them', 'verify they pass', 'make sure they work', etc.",
        ),
    isContinuation: z
        .boolean()
        .describe(
            "True ONLY if the user's message is a direct reply to a previous pause/interruption (e.g. providing login credentials, confirming 'login completed', saying 'done' or 'continue'). False if the user is giving a new command, asking a new question, or starting a different task.",
        ),
});

type ClassifierOutput = z.infer<typeof classifierSchema>;

/**
 * Pause reasons that represent a live-page blocker the agent can re-inspect and
 * (for auth/otp/consent) resolve automatically once the user supplies input.
 * "user_input" is deliberately excluded — that's the generic/save-approval
 * pause, which is not a browser blocker and must not be routed through the
 * interruption-resolution path.
 */
const BLOCKER_PAUSE_REASONS = new Set(["auth", "otp", "captcha", "consent", "paywall", "error"]);

/**
 * Heuristic: does this message look like a credential/OTP reply to a blocker
 * rather than a brand-new command? Used as a hard guard so the classifier can't
 * waffle and drop the user back into a fresh crawl mid-login. Credential replies
 * are short and don't start with a new-task verb.
 */
function looksLikeCredentialReply(text: string): boolean {
    const t = text.trim();
    if (!t || t.length > 80) return false;
    // A message that starts a new task is NOT a continuation.
    if (
        /^(test|generate|write|create|explore|go to|open|navigate|find|check|run|show|explain|list|discover)\b/i.test(
            t,
        )
    ) {
        return false;
    }
    // Email, phone, code, or a short single-line secret → treat as a reply.
    const oneLine = !t.includes("\n");
    const looksSecretish =
        /@/.test(t) || /\b\d{3,}\b/.test(t) || /^[^\s]{4,}$/.test(t) || t.split(/\s+/).length <= 4;
    return oneLine && looksSecretish;
}

/**
 * Best-effort host extraction used to decide whether a remembered crawl belongs
 * to the site the user is now targeting. Returns null for empty/relative/unparsable
 * values so callers can treat "unknown host" as non-blocking.
 */
function extractHost(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        return new URL(url).host.toLowerCase();
    } catch {
        return null;
    }
}

export const createClassifyGoalNode = (deps: AgentNodeDeps) => async (state: GraphStateType) => {
    const prompt = deps.buildAgentClassifierPrompt({
        userPrompt: state.userPrompt,
        conversationHistory: state.conversationHistory,
        storedGoal: deps.getGoalState?.(),
        pauseReason: state.pauseReason || null,
    });

    const instructions = deps.buildAgentClassifierPrompt({
        userPrompt: "",
        conversationHistory: [],
    });

    try {
        const structuredModel = deps.model.withStructuredOutput(classifierSchema, {
            name: "classify_user_intent",
        });

        let result: ClassifierOutput;
        try {
            const response = await structuredModel.invoke(
                buildPromptMessages(
                    instructions,
                    prompt,
                    state.userPrompt,
                    state.conversationHistory,
                ),
                { timeout: LLM_REQUEST_TIMEOUT_MS },
            );
            result = response;
        } catch {
            // Structured output failed (model doesn't support it, or schema mismatch).
            // Fall back to raw JSON parsing.
            result = await fallbackClassify(deps, instructions, state.userPrompt, prompt);
        }

        const inferredDiscoveryAction = inferDiscoveryManagementAction(state.userPrompt);
        const discoveryAction = inferredDiscoveryAction ?? result.discoveryAction ?? null;

        deps.setActiveIntent?.(result.intent);
        deps.setGoalState?.({
            goal: result.goal,
            targetFeature: result.targetFeature,
            targetUrl: result.targetUrl,
            missingContext: result.missingContext,
            nextTool: discoveryAction
                ? "discoveryManage"
                : result.targetAction
                  ? "domCapture"
                  : result.nextTool,
        });

        // A concrete UI action ("sign out") must reach the live browser/explore
        // path, so force domCapture — otherwise the classifier may pick
        // codeSearch/none and never open the page to find/perform the action.
        const nextTool = discoveryAction
            ? "discoveryManage"
            : result.targetAction
              ? "domCapture"
              : result.nextTool;

        const stateUpdates: Record<string, unknown> = {
            intent: result.intent,
            activeGoal: result.goal,
            targetFeature: result.targetFeature,
            targetUrl: result.targetUrl,
            targetAction: result.targetAction,
            performAction: result.performAction,
            missingContext: result.missingContext,
            nextTool,
            discoveryAction,
            shouldRunTests: result.shouldRunTests,
            pauseReason: null,
        };

        // Ground live-page requests: a test generation with no named URL
        // reuses the remembered base URL (or the Playwright baseURL) so we
        // explore the real DOM instead of guessing routes/selectors. Same for
        // a browse request ("open the dashboard") — with no target URL the
        // browser opens about:blank and the agent answers from an empty page.
        const needsLiveTarget =
            (result.intent === "generateTests" && nextTool !== "domCapture") ||
            result.intent === "explore";
        if (needsLiveTarget && !result.targetUrl) {
            try {
                const { AgentMemory } = await import("../../memory");
                const base = AgentMemory.getInstance(deps.projectPath).getPreference(
                    "project_base_url",
                );
                if (base) {
                    stateUpdates["targetUrl"] = base;
                    if (result.intent === "generateTests") {
                        stateUpdates["groundingOptional"] = true;
                    }
                }
            } catch {
                /* memory unavailable — generate from code only */
            }
            // No remembered base (cold project, no auth.baseUrl)? Mirror cover:
            // the Playwright config's baseURL is the project's best-known app
            // origin — a live-page prompt should open it, not about:blank.
            if (!stateUpdates["targetUrl"]) {
                try {
                    const { readPlaywrightBaseURL } = await import(
                        "../../../testing/playwright-config"
                    );
                    const baseURL = await readPlaywrightBaseURL(deps.projectPath);
                    if (baseURL) {
                        stateUpdates["targetUrl"] = baseURL;
                        if (result.intent === "generateTests") {
                            stateUpdates["groundingOptional"] = true;
                        }
                    }
                } catch {
                    /* no playwright config — generate from code only */
                }
            }
        }

        const hasRememberedExploration =
            (state.pendingPagesVisited && state.pendingPagesVisited.length > 0) ||
            (state.pendingPageSummaries && state.pendingPageSummaries.length > 0);

        // Hard guard: a short credential-shaped reply to a live blocker is a
        // continuation even if the classifier labeled it a new command.
        const forcedContinuation =
            !!state.pauseReason &&
            BLOCKER_PAUSE_REASONS.has(state.pauseReason) &&
            looksLikeCredentialReply(state.userPrompt);
        const isContinuation = result.isContinuation || forcedContinuation;
        const authPrecondition =
            isContinuation && (state.pauseReason === "auth" || state.pauseReason === "otp")
                ? state.authPrecondition
                : resolveAuthPrecondition({
                      userPrompt: state.userPrompt,
                      activeGoal: result.goal,
                      targetFeature: result.targetFeature,
                      targetAction: result.targetAction,
                  });
        stateUpdates["authPrecondition"] = authPrecondition;
        deps.setAuthPrecondition?.(authPrecondition);

        if (state.pauseReason) {
            if (isContinuation) {
                stateUpdates["pagesVisited"] = state.pendingPagesVisited || [];
                stateUpdates["pageSummaries"] = state.pendingPageSummaries || [];
                stateUpdates["currentUrl"] = state.pendingCurrentUrl || null;

                // Resuming a live-page blocker (e.g. the user just sent their
                // password). Route back into detectInterruption to re-inspect
                // the still-blocked page and fill what they provided, rather
                // than letting nextTool (inferred from a bare credential
                // message) send us to gatherContext/navigate. Null out
                // targetUrl so detectInterruption captures the CURRENT page
                // (still on the login screen) instead of navigating away.
                if (BLOCKER_PAUSE_REASONS.has(state.pauseReason)) {
                    stateUpdates["resumeBlocker"] = true;
                    stateUpdates["targetUrl"] = null;
                }
            } else {
                // A genuinely new command after a pause: drop the remembered
                // crawl in the DB too, so the next turn doesn't reload it.
                try {
                    const { AgentMemory } = await import("../../memory");
                    AgentMemory.getInstance(deps.projectPath).clearLastExploration();
                } catch {
                    /* memory unavailable — non-critical */
                }
            }
            stateUpdates["pendingPagesVisited"] = [];
            stateUpdates["pendingPageSummaries"] = [];
            stateUpdates["pendingCurrentUrl"] = null;
        } else if (hasRememberedExploration && result.intent !== "explain") {
            // Non-pause follow-up on a site-related task. Only restore the
            // remembered crawl when it belongs to the SAME site the user is now
            // targeting — otherwise a brand-new task against a different app
            // (within the 30-min recency window) would inherit the previous
            // site's pages/DOM and generate against the wrong app. When the new
            // request names no URL, treat it as a genuine follow-up ("now write
            // the test") and restore.
            const rememberedHost = extractHost(state.pendingCurrentUrl);
            const requestedHost = extractHost(result.targetUrl);
            const sameSite = !requestedHost || !rememberedHost || requestedHost === rememberedHost;

            if (sameSite) {
                const pendingSummaries = state.pendingPageSummaries || [];
                stateUpdates["pagesVisited"] = state.pendingPagesVisited || [];
                stateUpdates["pageSummaries"] = pendingSummaries;
                // Restore live grounding too: "now generate the test" needs the
                // last DOM + URL, not just the page list. Without this the
                // generate step saw no domSummary and fell back to guessing.
                stateUpdates["currentUrl"] = state.pendingCurrentUrl || null;
                if (pendingSummaries.length > 0) {
                    stateUpdates["domSummary"] = pendingSummaries[pendingSummaries.length - 1];
                }
            } else {
                // Different site: discard the stale crawl so it can't leak into
                // this task, and clear it from the DB so later turns don't reload
                // it either.
                try {
                    const { AgentMemory } = await import("../../memory");
                    AgentMemory.getInstance(deps.projectPath).clearLastExploration();
                } catch {
                    /* memory unavailable — non-critical */
                }
            }
            stateUpdates["pendingPagesVisited"] = [];
            stateUpdates["pendingPageSummaries"] = [];
            stateUpdates["pendingCurrentUrl"] = null;
        }

        return stateUpdates;
    } catch (error) {
        console.warn("Classifier failed:", error instanceof Error ? error.message : error);

        // On failure, discard stale state (safe default)
        return {
            shouldPause: true,
            awaitUserMessage:
                "I could not classify your request. Please restate the goal in one sentence (what you want and what to focus on).",
            pauseReason: null,
            pendingPagesVisited: [],
            pendingPageSummaries: [],
            pendingCurrentUrl: null,
        };
    }
};

/**
 * Fallback: invoke the model raw and parse JSON from its text output.
 * Used when withStructuredOutput is not supported by the provider.
 */
async function fallbackClassify(
    deps: AgentNodeDeps,
    systemPrompt: string,
    userPrompt: string,
    evidence: string,
): Promise<ClassifierOutput> {
    const strictPrompt = `${systemPrompt}\n\nReturn JSON only, no fences:\n${JSON.stringify(classifierSchema.shape)}`;

    const response = await deps.model.invoke(
        buildPromptMessages(strictPrompt, evidence, userPrompt),
        { timeout: LLM_REQUEST_TIMEOUT_MS },
    );

    const content = Array.isArray(response.content)
        ? response.content
              .map((part) => (typeof part === "string" ? part : part?.text || ""))
              .join("")
        : response.content;

    if (!content || typeof content !== "string") {
        throw new Error("Classifier returned empty output.");
    }

    let cleaned = content.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch?.[1]) {
        cleaned = fenceMatch[1].trim();
    }
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
    }

    const parsed = JSON.parse(cleaned);
    return classifierSchema.parse({
        intent: parsed.intent,
        goal: parsed.goal ?? null,
        targetFeature: parsed.targetFeature ?? null,
        targetUrl: parsed.targetUrl ?? null,
        targetAction: parsed.targetAction ?? null,
        performAction: parsed.performAction ?? false,
        nextTool: parsed.nextTool ?? null,
        discoveryAction: parsed.discoveryAction ?? null,
        missingContext: Array.isArray(parsed.missingContext)
            ? parsed.missingContext.filter((item: unknown) => typeof item === "string")
            : [],
        shouldRunTests: parsed.shouldRunTests ?? false,
        isContinuation: parsed.isContinuation ?? false,
    });
}
