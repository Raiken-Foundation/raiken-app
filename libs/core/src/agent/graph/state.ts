import { Annotation } from "@langchain/langgraph";
import type { TestRunResult } from "../../testing/runner";
import type { ContextData } from "../prompts";
import type { AgentIntent, InterruptionInfo } from "./utils";

export const GraphState = Annotation.Root({
    userPrompt: Annotation<string>({
        value: (_left, right) => right,
        default: () => "",
    }),
    conversationHistory: Annotation<Array<{ role: string; content: string }>>({
        value: (_left, right) => right,
        default: () => [],
    }),
    intent: Annotation<AgentIntent>({
        value: (_left, right) => right,
        default: () => "explore",
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
    missingContext: Annotation<string[]>({
        value: (_left, right) => right,
        default: () => [],
    }),
    nextTool: Annotation<string | null>({
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
    savedTestPath: Annotation<string | null>({
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
    maxExplorePages: Annotation<number | null>({
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
    pauseReason: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
    pendingPagesVisited: Annotation<string[]>({
        value: (_left, right) => right,
        default: () => [],
    }),
    pendingCurrentUrl: Annotation<string | null>({
        value: (_left, right) => right,
        default: () => null,
    }),
});

export type GraphStateType = typeof GraphState.State;
