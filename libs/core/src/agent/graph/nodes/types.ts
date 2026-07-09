import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentClassifierResult, ContextData, MemoryContext } from "../../prompts";
import type { ToolResult } from "../../tools";
import type { AgentIntent } from "../utils";

export type CallTool = (toolName: string, args: unknown) => Promise<ToolResult>;

export interface AgentNodeDeps {
    callTool: CallTool;
    projectPath: string;
    model: BaseChatModel;
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
