import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentClassifierResult, ContextData, MemoryContext } from "../../prompts";
import type { AutonomySettings, ToolResult } from "../../tools";
import type { AgentIntent } from "../utils";

export type CallTool = (toolName: string, args: unknown) => Promise<ToolResult>;

export interface AgentNodeDeps {
    callTool: CallTool;
    projectPath: string;
    model: BaseChatModel;
    /**
     * Resolved autonomy settings for this run (raiken.config.json merged with
     * any session-scoped override, e.g. the REPL's `/mode`). Optional so
     * existing callers/tests that don't care about autonomy keep working —
     * nodes that need it fall back to reading `raiken.config.json` directly
     * via `loadAutonomyConfig(projectPath)` when it's absent.
     */
    autonomy?: AutonomySettings;
    gatherContext: (
        prompt: string,
        projectPath: string,
        fileContext?: string[],
    ) => Promise<ContextData>;
    buildSystemPrompt: (
        context: ContextData,
        userPrompt: string,
        templateVersion?: string,
        memoryContext?: MemoryContext,
    ) => string;
    buildExplorationPrompt: (
        context: ContextData,
        userPrompt: string,
        memoryContext?: MemoryContext,
        intent?: AgentIntent,
        goalState?: {
            activeGoal?: string | null;
            targetFeature?: string | null;
            targetUrl?: string | null;
            missingContext?: string[];
            nextTool?: string | null;
        },
    ) => string;
    buildAgentClassifierPrompt: (input: {
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
    }) => string;
    getMemoryContext: () => MemoryContext | undefined;
    getActiveIntent?: () => "explore" | "generateTests" | "explain" | null;
    setActiveIntent?: (intent: "explore" | "generateTests" | "explain") => void;
    getGoalState?: () => {
        activeGoal: string | null;
        targetFeature: string | null;
        targetUrl: string | null;
        missingContext: string[];
        nextTool: string | null;
    };
    setGoalState?: (state: Partial<AgentClassifierResult>) => void;
    /** Emit a live phase-progress update (e.g. "Exploring 3/8 pages"). */
    onProgress?: (label: string, detail?: string) => void;
    /** Stream a token of the test being generated, for live UI updates. */
    onToken?: (token: string) => void;
    /**
     * Abort signal for the run. LangGraph only checks abort at step boundaries,
     * so long-running nodes (explore crawl, interruption resolution) check this
     * directly to stop promptly when the user hits Stop.
     */
    signal?: AbortSignal;
}
