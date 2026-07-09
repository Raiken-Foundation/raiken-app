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

import path from "node:path";
import { runToolAgent, type ToolAgentOptions, type ToolAgentResult } from "../agent/agent";
import type { HITLAction } from "../agent/hitl-types";

/**
 * Projects with an agent run in flight. Concurrent runs for the same project
 * share a single BrowserSession (keyed by projectPath), so two overlapping runs
 * would drive the same browser tab into an inconsistent state (one navigating
 * while the other clicks). We serialize per project and return a friendly
 * "busy" message for the second caller, mirroring `runTests`' lock.
 */
const activeAgentRuns = new Set<string>();

/**
 * Options for running the orchestrator
 */
export interface RunOrchestratorOptions {
    userPrompt: string;
    projectPath: string;
    conversationHistory?: Array<{ role: string; content: string }>;
    /**
     * Path of the test file the user currently has open/highlighted. When set,
     * a newly generated test overwrites this file instead of creating a new one.
     */
    targetTestFile?: string;
    /** Files the user referenced (e.g. @mentions) to focus context gathering on. */
    fileContext?: string[];
    /** Abort signal to cancel the run when the client disconnects. */
    signal?: AbortSignal;
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
    const {
        userPrompt,
        projectPath,
        conversationHistory,
        targetTestFile,
        fileContext,
        signal,
        onToolCall,
    } = options;

    const runKey = path.resolve(projectPath);
    if (activeAgentRuns.has(runKey)) {
        const busyMessage =
            "\n\nAnother agent run is already in progress for this project. " +
            "Please wait for it to finish (or stop it) before sending a new request.";
        yield busyMessage;
        return { text: busyMessage.trim(), hitlActions: [], toolCalls: [] };
    }
    activeAgentRuns.add(runKey);

    const agentOptions: ToolAgentOptions = {
        userPrompt,
        projectPath,
        conversationHistory,
        targetTestFile,
        fileContext,
        signal,
        onToolCall,
    };

    let agentResult: ToolAgentResult | undefined;

    try {
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
    } finally {
        activeAgentRuns.delete(runKey);
    }

    return (
        agentResult || {
            text: "",
            hitlActions: [],
            toolCalls: [],
        }
    );
}
