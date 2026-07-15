import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RunTraceEvent, RunTraceOutcome, RunTraceRecorderOptions } from "./types";

/** Keys whose values are never written to disk, wherever they appear. */
const SECRET_KEY_PATTERN = /token|secret|password|api[-_]?key|authorization|cookie|session[-_]?id/i;
const SECRET_VALUE_REPLACEMENTS: Array<[RegExp, string]> = [
    [/\b(Bearer\s+)[^\s"',;]+/gi, "$1[redacted]"],
    [/\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{8,}\b/g, "[redacted]"],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]"],
    [/([?&](?:access_token|api_key|token)=)[^&\s]+/gi, "$1[redacted]"],
];

const DEFAULT_MAX_STRING_LENGTH = 4000;

/**
 * Append-only JSONL trace writer for a single run.
 *
 * Every method is non-throwing by design: tracing is observability, and a
 * full disk or unwritable directory must never take down the agent run it
 * is observing. Events are flushed per line (appendFileSync) so a crashed
 * run keeps everything up to its last event.
 */
export class RunTraceRecorder {
    readonly runId: string;
    readonly filePath: string;
    private readonly startedAt: number;
    private readonly maxStringLength: number;
    private seq = 0;
    private ended = false;
    private broken = false;

    constructor(options: RunTraceRecorderOptions) {
        this.runId = crypto.randomBytes(6).toString("hex");
        this.startedAt = Date.now();
        this.maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;

        const stamp = new Date(this.startedAt).toISOString().replace(/[:.]/g, "-");
        this.filePath = path.join(options.dir, `${stamp}-${options.kind}-${this.runId}.jsonl`);

        try {
            fs.mkdirSync(options.dir, { recursive: true });
        } catch {
            this.broken = true;
        }

        this.append({
            type: "run_start",
            at: this.startedAt,
            runId: this.runId,
            kind: options.kind,
            label: redactAndTruncate(options.label, 500),
            ...(options.meta
                ? { meta: this.sanitize(options.meta) as Record<string, unknown> }
                : {}),
        });
    }

    /**
     * Create a recorder for a normal (non-eval) run only when tracing is
     * enabled via the `RAIKEN_TRACE` environment variable. Returns null when
     * disabled so call sites stay a single optional-chained expression.
     */
    static fromEnv(projectPath: string, kind: string, label: string): RunTraceRecorder | null {
        const flag = process.env["RAIKEN_TRACE"];
        if (!flag || flag === "0" || flag.toLowerCase() === "false") return null;
        try {
            return new RunTraceRecorder({
                dir: path.join(projectPath, ".raiken", "traces"),
                kind,
                label,
            });
        } catch {
            return null;
        }
    }

    /** Next tool-call sequence number; pass the same seq to `toolResult`. */
    toolCall(tool: string, args: unknown): number {
        const seq = ++this.seq;
        this.append({
            type: "tool_call",
            at: Date.now(),
            runId: this.runId,
            seq,
            tool,
            args: this.sanitize(args),
        });
        return seq;
    }

    toolResult(tool: string, result: unknown, seq?: number, success?: boolean): void {
        this.append({
            type: "tool_result",
            at: Date.now(),
            runId: this.runId,
            seq: seq ?? this.seq,
            tool,
            ...(success === undefined ? {} : { success }),
            result: this.sanitize(result),
        });
    }

    note(text: string): void {
        this.append({
            type: "note",
            at: Date.now(),
            runId: this.runId,
            text: redactAndTruncate(text, this.maxStringLength),
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
            ...(error ? { error: redactAndTruncate(error, 1000) } : {}),
        });
    }

    private append(event: RunTraceEvent): void {
        if (this.broken) return;
        try {
            fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);
        } catch {
            // Give up on this trace rather than retry-spamming a broken disk.
            this.broken = true;
        }
    }

    /**
     * JSON-safe deep copy with secret redaction and string truncation.
     * Depth-capped so a cyclic or pathological structure can't recurse away.
     */
    private sanitize(value: unknown, depth = 0): unknown {
        if (depth > 6) return "[max depth]";
        if (value === null || value === undefined) return value;
        if (typeof value === "string") return redactAndTruncate(value, this.maxStringLength);
        if (typeof value === "number" || typeof value === "boolean") return value;
        if (Array.isArray(value)) {
            return value.slice(0, 100).map((item) => this.sanitize(item, depth + 1));
        }
        if (typeof value === "object") {
            const out: Record<string, unknown> = {};
            for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
                out[key] = SECRET_KEY_PATTERN.test(key)
                    ? "[redacted]"
                    : this.sanitize(val, depth + 1);
            }
            return out;
        }
        return String(value);
    }
}

function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}… [+${value.length - max} chars]` : value;
}

function redactAndTruncate(value: string, max: number): string {
    let redacted = value;
    for (const [pattern, replacement] of SECRET_VALUE_REPLACEMENTS) {
        redacted = redacted.replace(pattern, replacement);
    }
    return truncate(redacted, max);
}
