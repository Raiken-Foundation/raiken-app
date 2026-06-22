/**
 * Orchestrator - LangGraph Runner
 *
 * The orchestrator manages the AI agent's execution using LangGraph.
 *
 * Key features:
 * - Explicit graph-based flow for exploration and test generation
 * - Interruption handling with optional user pauses (awaitUser)
 * - HITL actions surfaced for save/run steps
 * - Tool calls logged for UI feedback
 */

import { runToolAgent, type ToolAgentOptions, type ToolAgentResult } from "../agent/agent";
import type { HITLAction } from "../agent/hitl-types";

/**
 * Options for running the orchestrator
 */
export interface RunOrchestratorOptions {
    userPrompt: string;
    projectPath: string;
    conversationHistory?: Array<{ role: string; content: string }>;
    /** Callback when HITL confirmation is needed */
    onHITL?: (action: HITLAction) => Promise<boolean>;
    /** Callback for tool call events (for UI feedback) */
    onToolCall?: (toolName: string, args: unknown) => void;
}

/**
 * Result from the orchestrator
 */
export interface OrchestratorResult {
    text: string;
    hitlActions: HITLAction[];
    toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
}

/**
 * Run the orchestrator.
 *
 * Flow:
 * 1. User sends message
 * 2. LangGraph agent executes a deterministic flow (navigate, handle interruptions, explore)
 * 3. Agent uses tools for browser/file actions and respond/awaitUser for communication
 * 4. Summary and results streamed to client
 */
export async function* runOrchestrator(
    options: RunOrchestratorOptions,
): AsyncGenerator<string, OrchestratorResult, unknown> {
    const { userPrompt, projectPath, conversationHistory, onHITL, onToolCall } = options;

    console.log("🚀 Orchestrator: Starting...");
    console.log(`📝 Prompt: "${userPrompt.slice(0, 50)}${userPrompt.length > 50 ? "..." : ""}"`);

    const agentOptions: ToolAgentOptions = {
        userPrompt,
        projectPath,
        conversationHistory,
        onHITL,
        onToolCall,
        onToolResult: (toolName, result) => {
            // Log tool results for debugging
            console.log(`📦 ${toolName}: ${result.message}`);

            // Special logging for control tools
            if (toolName === "done") {
                console.log("🏁 Agent signaled completion");
            } else if (toolName === "respond") {
                console.log("💬 Agent responding to user");
            } else if (toolName === "awaitUser") {
                console.log("⏸️ Agent awaiting user input");
            }
        },
    };

    let agentResult: ToolAgentResult | undefined;

    // Run the ToolLoopAgent and stream results
    const generator = runToolAgent(agentOptions);

    while (true) {
        const { value, done } = await generator.next();
        if (done) {
            agentResult = value as ToolAgentResult;
            break;
        }
        yield value as string;
    }

    console.log("✅ Orchestrator complete");

    return (
        agentResult || {
            text: "",
            hitlActions: [],
            toolCalls: [],
        }
    );
}
