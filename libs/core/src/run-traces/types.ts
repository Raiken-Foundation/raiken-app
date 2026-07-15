/**
 * Structured trace events for agent runs.
 *
 * One JSONL file per run under `.raiken/traces/` — the raw material for
 * debugging trajectories ("why did the agent pick that selector"), measuring
 * repair-loop behavior, and replay-style evals. Distinct from `src/trace/`,
 * which maps *stack traces* to tests.
 */

export type RunTraceOutcome = "completed" | "error" | "aborted";

export interface RunTraceStartEvent {
    type: "run_start";
    at: number;
    runId: string;
    /** What produced this trace, e.g. "agent", "eval". */
    kind: string;
    /** Human-readable label — typically the user prompt or scenario id. */
    label: string;
    meta?: Record<string, unknown>;
}

export interface RunTraceToolCallEvent {
    type: "tool_call";
    at: number;
    runId: string;
    /** Monotonic per-run sequence number, shared with the matching result. */
    seq: number;
    tool: string;
    args: unknown;
}

export interface RunTraceToolResultEvent {
    type: "tool_result";
    at: number;
    runId: string;
    seq: number;
    tool: string;
    success?: boolean;
    result: unknown;
}

export interface RunTraceNoteEvent {
    type: "note";
    at: number;
    runId: string;
    text: string;
}

export interface RunTraceEndEvent {
    type: "run_end";
    at: number;
    runId: string;
    durationMs: number;
    outcome: RunTraceOutcome;
    error?: string;
}

export type RunTraceEvent =
    | RunTraceStartEvent
    | RunTraceToolCallEvent
    | RunTraceToolResultEvent
    | RunTraceNoteEvent
    | RunTraceEndEvent;

export interface RunTraceRecorderOptions {
    /** Directory the JSONL file is written into (created if missing). */
    dir: string;
    kind: string;
    label: string;
    meta?: Record<string, unknown>;
    /** Cap on any single serialized string value. Default 4000 chars. */
    maxStringLength?: number;
}
