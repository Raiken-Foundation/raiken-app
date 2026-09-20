import { Annotation } from "@langchain/langgraph";
import type { TestRunResult } from "../../testing/runner";
import type { SelectorViolation } from "../grounding";
import type { ContextData } from "../prompts";
import type {
    ActionResult,
    AgentIntent,
    AuthPrecondition,
    ContextPlan,
    DiscoveryManagementAction,
    InterruptionInfo,
} from "./utils";

export const GraphState = Annotation.Root({
    userPrompt: Annotation<string>({
        value: (_left, right) => right,
        default: () => "",
    }),
    conversationHistory: Annotation<Array<{ role: string; content: string }>>({
        value: (_left, right) => right,
        default: () => [],
    }),
    /**
     * Files the user explicitly referenced (e.g. via @mentions in chat). These
     * are threaded into context gathering so the agent focuses on what the user
     * pointed at instead of relying on semantic search alone.
     */
    fileContext: Annotation<string[]>({
        value: (_left, right) => right,
        default: () => [],
    }),
    intent: Annotation<AgentIntent>({
        value: (_left, right) => right,
        default: () => "explore",
    }),
    authPrecondition: Annotation<AuthPrecondition>({
        value: (_left, right) => right,
        default: () => "authenticated",
    }),
    activeGoal: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    targetFeature: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    targetUrl: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    /**
     * A concrete control/action the user wants the agent to find and (usually)
     * perform, e.g. "sign out". Drives goal-directed exploration in the explore
     * node: scan every page's links + interactive elements for this action
     * instead of stopping after a few pages.
     */
    targetAction: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    /** True when the user wants the action actually performed (clicked). */
    performAction: Annotation<boolean>({
        value: (_left, right) => right,
        default: () => false,
    }),
    /** Outcome of the action search, surfaced to the user + test generation. */
    actionResult: Annotation<ActionResult | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    missingContext: Annotation<string[]>({
        value: (_left, right) => right,
        default: () => [],
    }),
    nextTool: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    discoveryAction: Annotation<DiscoveryManagementAction | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    shouldRunTests: Annotation<boolean>({
        value: (_left, right) => right,
        default: () => false,
    }),
    currentUrl: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    domSummary: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    pagesVisited: Annotation<string[]>({
        value: (left, right) => left.concat(right),
        default: () => [],
    }),
    pageSummaries: Annotation<string[]>({
        value: (left, right) => {
            const merged = left.concat(right);
            const MAX_PAGE_SUMMARIES = 30;
            return merged.length > MAX_PAGE_SUMMARIES
                ? merged.slice(merged.length - MAX_PAGE_SUMMARIES)
                : merged;
        },
        default: () => [],
    }),
    interruption: Annotation<InterruptionInfo | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    shouldPause: Annotation<boolean>({
        value: (_left, right) => right,
        default: () => false,
    }),
    awaitUserMessage: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    testDraft: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    testDirectory: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    targetTestFile: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    savedTestPath: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    failure: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    summary: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    context: Annotation<ContextData | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    /**
     * LLM-produced plan describing what context to gather before generating a
     * test: which code-search queries to run, which files to focus on, and which
     * live-DOM aspects matter. Surfaced back into the test-gen prompt so the
     * model knows what was assembled for it and why.
     */
    contextPlan: Annotation<ContextPlan | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    maxExplorePages: Annotation<number | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    exploreBudgetMs: Annotation<number | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    testRunResult: Annotation<TestRunResult[] | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    repairAttempts: Annotation<number>({
        value: (_left, right) => right,
        default: () => 0,
    }),
    /**
     * The fixed code produced by the most recent repair attempt. Lets the next
     * attempt detect "no progress" — the AI returning byte-identical code to
     * either the pre-repair file or its own prior attempt — so the repair loop
     * can stop early instead of burning through `maxRetries` on guesses that
     * are provably not changing anything.
     */
    lastRepairedCode: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    pauseReason: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    /**
     * Set by classifyGoal when the incoming message is a direct reply to a
     * previous *browser blocker* pause (auth/otp/captcha/consent/paywall/error).
     * When true, the graph routes straight back to detectInterruption so the
     * agent re-inspects the still-blocked live page and fills the freshly
     * supplied credentials — instead of letting the goal classifier's freshly
     * inferred nextTool (from a bare "password" message) send it elsewhere.
     */
    resumeBlocker: Annotation<boolean>({
        value: (_left, right) => right,
        default: () => false,
    }),
    pendingPagesVisited: Annotation<string[]>({
        value: (_left, right) => right,
        default: () => [],
    }),
    pendingPageSummaries: Annotation<string[]>({
        value: (_left, right) => right,
        default: () => [],
    }),
    pendingCurrentUrl: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    /**
     * True when generateTests was routed through the live browser using an
     * *inferred* base URL (not one the user named). If navigation then fails
     * (app down), the graph falls back to code-only generation instead of
     * blocking the user with a pause.
     */
    groundingOptional: Annotation<boolean>({
        value: (_left, right) => right,
        default: () => false,
    }),
    /** Set by navigate when optional grounding navigation failed. */
    groundingFailed: Annotation<boolean>({
        value: (_left, right) => right,
        default: () => false,
    }),
    /**
     * Locators in the last generated draft that the captured DOM contradicts.
     * Non-empty means generation was rejected rather than saved, so consumers
     * can show *why* instead of a bare failure.
     */
    groundingViolations: Annotation<SelectorViolation[]>({
        value: (_left, right) => right,
        default: () => [],
    }),
});

export type GraphStateType = typeof GraphState.State;
