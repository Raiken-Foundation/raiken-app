import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { correlationFields, mergeCorrelationContext } from "../observability/context";
import { redactString, redactValue } from "../observability/redaction";
import { resolveProjectTraceDir, rotateTraceFiles } from "./rotation";
import type { RunTraceEvent, RunTraceOutcome, RunTraceRecorderOptions } from "./types";

const DEFAULT_MAX_STRING_LENGTH = 4000;

function isContentTracingEnabled(): boolean {
    const flag = process.env["RAIKEN_TRACE"];
    return Boolean(flag && flag !== "0" && flag.toLowerCase() !== "false");
}

/**
 * Append-only JSONL trace writer for a single run.
 *
 * Operational traces (run start/end, failures) are always available.
 * Full content traces (tool args/results, prompts) require `RAIKEN_TRACE`.
 */
export class RunTraceRecorder {
    readonly runId: string;
    readonly filePath: string;
    private readonly startedAt: number;
    private readonly maxStringLength: number;
    private readonly contentTraces: boolean;
    private seq = 0;
    private ended = false;
    private broken = false;

    constructor(options: RunTraceRecorderOptions) {
        this.runId = options.runId ?? crypto.randomBytes(6).toString("hex");
        this.startedAt = Date.now();
        this.maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
        this.contentTraces = options.contentTraces ?? isContentTracingEnabled();

        mergeCorrelationContext({ runId: this.runId, ...options.correlation });

        const stamp = new Date(this.startedAt).toISOString().replace(/[:.]/g, "-");
        const prefix = options.operational ? "ops" : options.kind;
        const traceDir = options.projectPath
            ? resolveProjectTraceDir(options.projectPath)
            : path.resolve(options.dir);
        this.filePath = path.join(traceDir, `${stamp}-${prefix}-${this.runId}.jsonl`);

        try {
            fs.mkdirSync(traceDir, { recursive: true });
            if (options.projectPath) {
                rotateTraceFiles(traceDir, options.rotation, options.projectPath);
            } else {
                rotateTraceFiles(traceDir, options.rotation);
            }
        } catch {
            this.broken = true;
        }

        const label = options.operational
            ? `${options.kind}${options.correlation?.operationId ? `:${options.correlation.operationId}` : ""}`
            : redactString(options.label, 500);

        this.append({
            type: "run_start",
            at: this.startedAt,
            runId: this.runId,
            kind: options.kind,
            label,
            contentTraces: this.contentTraces,
            ...(options.meta
                ? { meta: this.sanitize(options.meta) as Record<string, unknown> }
                : {}),
            ...this.correlationSnapshot(),
        });
    }

    /**
     * Operational recorder — always writes lifecycle/failure events without prompts.
     * Tool content is omitted unless `RAIKEN_TRACE` is enabled.
     */
    static forOperational(
        projectPath: string,
        kind: string,
        correlation?: RunTraceRecorderOptions["correlation"],
        meta?: Record<string, unknown>,
    ): RunTraceRecorder | null {
        const flag = process.env["RAIKEN_OPS_TRACE"];
        if (flag === "0" || flag?.toLowerCase() === "false") return null;

        const resolvedProject = path.resolve(projectPath);
        const raikenDir = path.join(resolvedProject, ".raiken");
        if (!fs.existsSync(raikenDir)) return null;

        const dir = resolveProjectTraceDir(resolvedProject);
        return new RunTraceRecorder({
            dir,
            kind,
            label: kind,
            operational: true,
            correlation,
            meta,
            projectPath: resolvedProject,
        });
    }

    /**
     * Create a recorder for a normal (non-eval) run only when tracing is
     * enabled via the `RAIKEN_TRACE` environment variable. Returns null when
     * disabled so call sites stay a single optional-chained expression.
     */
    static fromEnv(projectPath: string, kind: string, label: string): RunTraceRecorder | null {
        if (!isContentTracingEnabled()) return null;
        try {
            return new RunTraceRecorder({
                dir: resolveProjectTraceDir(projectPath),
                kind,
                label,
                contentTraces: true,
                projectPath: path.resolve(projectPath),
            });
        } catch {
            return null;
        }
    }

    /** Next tool-call sequence number; pass the same seq to `toolResult`. */
    toolCall(tool: string, args: unknown): number {
        if (!this.contentTraces) return ++this.seq;
        const seq = ++this.seq;
        this.append({
            type: "tool_call",
            at: Date.now(),
            runId: this.runId,
            seq,
            tool,
            args: this.sanitize(args),
            ...this.correlationSnapshot(),
        });
        return seq;
    }

    toolResult(tool: string, result: unknown, seq?: number, success?: boolean): void {
        if (!this.contentTraces) return;
        this.append({
            type: "tool_result",
            at: Date.now(),
            runId: this.runId,
            seq: seq ?? this.seq,
            tool,
            ...(success === undefined ? {} : { success }),
            result: this.sanitize(result),
            ...this.correlationSnapshot(),
        });
    }

    note(text: string): void {
        this.append({
            type: "note",
            at: Date.now(),
            runId: this.runId,
            text: redactString(text, this.maxStringLength),
            ...this.correlationSnapshot(),
        });
    }

    /** Idempotent — only the first call writes the run_end event. */
    end(outcome: RunTraceOutcome, error?: string): void {
        if (this.ended) return;
        this.ended = true;
        this.append({
            type: "run_end",
            at: Date.now(),
            runId: this.runId,
            durationMs: Date.now() - this.startedAt,
            outcome,
            ...(error ? { error: redactString(error, 1000) } : {}),
            ...this.correlationSnapshot(),
        });
        this.closeAtomic();
    }

    /** Flush and fsync the trace file — safe to call after end(). */
    closeAtomic(): void {
        if (this.broken) return;
        try {
            const fd = fs.openSync(this.filePath, "a");
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        } catch {
            this.broken = true;
        }
    }

    private correlationSnapshot(): Record<string, string | undefined> {
        const ctx = correlationFields();
        return {
            ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
            ...(ctx.operationId ? { operationId: ctx.operationId } : {}),
            ...(ctx.workflowId ? { workflowId: ctx.workflowId } : {}),
            ...(ctx.discoverySessionId ? { discoverySessionId: ctx.discoverySessionId } : {}),
            ...(ctx.projectRef ? { projectRef: ctx.projectRef } : {}),
        };
    }

    private append(event: RunTraceEvent): void {
        if (this.broken) return;
        try {
            fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);
        } catch {
            this.broken = true;
        }
    }

    private sanitize(value: unknown, depth = 0): unknown {
        return redactValue(value, this.maxStringLength, depth);
    }
}
