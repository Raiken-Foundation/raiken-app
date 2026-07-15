import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunTraceRecorder } from "../recorder";
import type { RunTraceEvent } from "../types";

describe("RunTraceRecorder", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-traces-"));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function readEvents(recorder: RunTraceRecorder): RunTraceEvent[] {
        return fs
            .readFileSync(recorder.filePath, "utf-8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as RunTraceEvent);
    }

    it("writes start, tool call/result pairs, and end as JSONL", () => {
        const recorder = new RunTraceRecorder({ dir, kind: "agent", label: "generate a test" });
        const seq = recorder.toolCall("click", { selector: "#submit" });
        recorder.toolResult("click", { success: true, message: "ok" }, seq, true);
        recorder.end("completed");

        const events = readEvents(recorder);
        expect(events.map((e) => e.type)).toEqual([
            "run_start",
            "tool_call",
            "tool_result",
            "run_end",
        ]);
        const call = events[1] as Extract<RunTraceEvent, { type: "tool_call" }>;
        const result = events[2] as Extract<RunTraceEvent, { type: "tool_result" }>;
        expect(call.seq).toBe(result.seq);
        expect(call.args).toEqual({ selector: "#submit" });
        expect(result.success).toBe(true);
        expect(events.every((e) => e.runId === recorder.runId)).toBe(true);
    });

    it("redacts secret-looking keys and truncates long strings", () => {
        const recorder = new RunTraceRecorder({
            dir,
            kind: "agent",
            label: "x",
            maxStringLength: 20,
        });
        recorder.toolCall("login", {
            apiKey: "sk-super-secret",
            authorization: "Bearer abc",
            nested: { sessionId: "s1", password: "hunter2" },
            opaque: "send Bearer unlabelled-token-value",
            endpoint: "https://example.test/callback?access_token=query-secret",
            note: "a".repeat(50),
        });
        recorder.note("provider returned sk-unlabelled-secret-value");
        recorder.end("completed", "JWT eyJheader.eyJpayload.signature");

        const raw = fs.readFileSync(recorder.filePath, "utf-8");
        expect(raw).not.toContain("sk-super-secret");
        expect(raw).not.toContain("hunter2");
        expect(raw).not.toContain("Bearer abc");
        expect(raw).not.toContain("unlabelled-token-value");
        expect(raw).not.toContain("query-secret");
        expect(raw).not.toContain("sk-unlabelled-secret-value");
        expect(raw).not.toContain("eyJheader.eyJpayload.signature");
        expect(raw).toContain("[redacted]");
        expect(raw).toContain("[+30 chars]");
    });

    it("end() is idempotent and records the outcome", () => {
        const recorder = new RunTraceRecorder({ dir, kind: "eval", label: "scenario" });
        recorder.end("error", "boom");
        recorder.end("completed");

        const events = readEvents(recorder);
        const ends = events.filter((e) => e.type === "run_end");
        expect(ends).toHaveLength(1);
        expect((ends[0] as Extract<RunTraceEvent, { type: "run_end" }>).outcome).toBe("error");
    });

    it("fromEnv returns null unless RAIKEN_TRACE is set", () => {
        const prev = process.env["RAIKEN_TRACE"];
        try {
            delete process.env["RAIKEN_TRACE"];
            expect(RunTraceRecorder.fromEnv(dir, "agent", "x")).toBeNull();
            process.env["RAIKEN_TRACE"] = "0";
            expect(RunTraceRecorder.fromEnv(dir, "agent", "x")).toBeNull();
            process.env["RAIKEN_TRACE"] = "1";
            const recorder = RunTraceRecorder.fromEnv(dir, "agent", "x");
            expect(recorder).not.toBeNull();
            expect(recorder?.filePath).toContain(path.join(dir, ".raiken", "traces"));
        } finally {
            if (prev === undefined) delete process.env["RAIKEN_TRACE"];
            else process.env["RAIKEN_TRACE"] = prev;
        }
    });
});
