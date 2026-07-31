import { tool } from "ai";
import { z } from "zod";
import { AgentMemory } from "../memory";
import type { AgentToolGroupDeps, ToolResult } from "./types";

/** Tool names owned by the memory / terminal / control group. */
export const MEMORY_TERMINAL_CONTROL_TOOL_NAMES = [
    "getMemoryContext",
    "done",
    "respond",
    "awaitUser",
] as const;

export type MemoryTerminalControlToolName = (typeof MEMORY_TERMINAL_CONTROL_TOOL_NAMES)[number];

export function createMemoryTerminalControlTools(deps: AgentToolGroupDeps) {
    const { projectPath } = deps;

    return {
        getMemoryContext: tool({
            description:
                "Get learned preferences and selector history. Use this to understand what has worked in the past.",
            inputSchema: z.object({}),
            execute: async (): Promise<
                ToolResult<{
                    selectorStrategy: string | null;
                    successfulSelectors: Array<{ element: string; selector: string }>;
                    recentFailures: Array<{ testName: string; error: string }>;
                }>
            > => {
                try {
                    const memory = AgentMemory.getInstance(projectPath);
                    const context = memory.buildPromptContext();

                    return {
                        success: true,
                        data: {
                            selectorStrategy: context.selectorStrategy,
                            successfulSelectors: context.successfulSelectors.map((s) => ({
                                element: s.element,
                                selector: s.selector,
                            })),
                            recentFailures: context.recentFailures,
                        },
                        message: `Loaded memory: ${context.successfulSelectors.length} known selectors, ${context.recentFailures.length} recent failures`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to load memory: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        done: tool({
            description:
                "Signal that you have finished the task. Call this when exploration is complete or when you have completed the user's request. This stops the agent loop.",
            inputSchema: z.object({
                summary: z.string().describe("Summary of what you found or did"),
                suggestedTests: z
                    .array(z.string())
                    .optional()
                    .describe("List of suggested test scenarios based on exploration"),
                pagesVisited: z
                    .array(z.string())
                    .optional()
                    .describe("List of pages/URLs that were visited"),
            }),
            // NO execute function - calling this tool stops the agent loop
        }),

        respond: tool({
            description:
                "Send a message to the user. Use this when you need to ask a clarifying question, report progress, or provide information that requires user acknowledgment before continuing.",
            inputSchema: z.object({
                message: z.string().describe("Message to send to the user"),
                needsInput: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Whether you need user input to continue (true = wait for response)"),
                options: z
                    .array(z.string())
                    .optional()
                    .describe("Optional list of choices for the user to pick from"),
            }),
            execute: async (
                params,
            ): Promise<ToolResult<{ messageSent: boolean; awaitingInput: boolean }>> => {
                const {
                    message,
                    needsInput = false,
                    options,
                } = params as {
                    message: string;
                    needsInput?: boolean;
                    options?: string[];
                };
                return {
                    success: true,
                    data: { messageSent: true, awaitingInput: needsInput },
                    message: options ? `${message}\nOptions: ${options.join(", ")}` : message,
                };
            },
        }),

        awaitUser: tool({
            description:
                "Pause and ask the user for input. This stops the agent loop until the user responds.",
            inputSchema: z.object({
                message: z.string().describe("Question or prompt for the user"),
                options: z
                    .array(z.string())
                    .optional()
                    .describe("Optional list of choices for the user to pick from"),
            }),
            // NO execute function - calling this tool pauses the agent loop
        }),
    };
}

export type MemoryTerminalControlTools = ReturnType<typeof createMemoryTerminalControlTools>;
