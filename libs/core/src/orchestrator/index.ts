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
import type { AutonomySettings, ToolResult } from "../agent/tools";
import { RunTraceRecorder } from "../run-traces";

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
    /**
     * Session-scoped autonomy override for just this run — see
     * {@link ToolAgentOptions.autonomyOverride}.
     */
    autonomyOverride?: Partial<AutonomySettings>;
    /** Abort signal to cancel the run when the client disconnects. */
    signal?: AbortSignal;
    /** Callback for tool call events (for UI feedback) */
    onToolCall?: (toolName: string, args: unknown) => void;
    /**
     * Callback for tool result events. Fired synchronously right after a
     * tool's `execute()` resolves, alongside (not instead of) the inline
     * `<!--EVENT:...-->` text markers already embedded in the streamed
     * text — this is the hook a caller (e.g. the CLI server) uses to also
     * emit a structured `{ type: "tool" }` SSE event for richer dashboard UI.
     */
    onToolResult?: (toolName: string, result: ToolResult) => void;
    /**
     * Structured trace recorder for this run. When omitted, a recorder is
     * created automatically iff the `RAIKEN_TRACE` env var is set (writes
     * JSONL under `.raiken/traces/`). Pass one explicitly from harnesses
     * (evals) that always want traces.
     */
    trace?: RunTraceRecorder | null;
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
        autonomyOverride,
        signal,
        onToolCall,
        onToolResult,
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

    const trace =
        options.trace !== undefined
            ? options.trace
            : RunTraceRecorder.fromEnv(projectPath, "agent", userPrompt);

    const agentOptions: ToolAgentOptions = {
        userPrompt,
        projectPath,
        conversationHistory,
        targetTestFile,
        fileContext,
        autonomyOverride,
        signal,
        onToolCall: trace
            ? (toolName, args) => {
                  trace.toolCall(toolName, args);
                  onToolCall?.(toolName, args);
              }
            : onToolCall,
        onToolResult: trace
            ? (toolName, result) => {
                  trace.toolResult(toolName, result, undefined, result?.success);
                  onToolResult?.(toolName, result);
              }
            : onToolResult,
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
        trace?.end(signal?.aborted ? "aborted" : "completed");
    } catch (error) {
        trace?.end("error", error instanceof Error ? error.message : String(error));
        throw error;
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
