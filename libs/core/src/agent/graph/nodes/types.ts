import type { ChatOpenAI } from "@langchain/openai";
import type { ToolResult } from "../../tools";
import type { ContextData, MemoryContext } from "../../prompts";
import type { AgentClassifierResult } from "../../prompts";
import type { AgentIntent } from "../utils";

export type CallTool = (toolName: string, args: unknown) => Promise<ToolResult>;

export interface AgentNodeDeps {
    callTool: CallTool;
    projectPath: string;
    model: ChatOpenAI;
    gatherContext: (prompt: string, projectPath: string, fileContext?: string[]) => Promise<ContextData>;
    buildSystemPrompt: (
        context: ContextData,
        userPrompt: string,
        templateVersion?: string,
        memoryContext?: MemoryContext
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
        }
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
}
