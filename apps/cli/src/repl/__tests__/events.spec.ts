import { describe, expect, it } from "vitest";
import { createEventStream, nowTs } from "../events";

describe("event stream", () => {
    it("emits NDJSON lines when enabled", () => {
        const lines: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string | Uint8Array) => {
            lines.push(typeof chunk === "string" ? chunk : chunk.toString());
            return true;
        }) as typeof process.stdout.write;

        try {
            const stream = createEventStream(true);
            stream.emit({ type: "start", prompt: "hi", ts: nowTs() });
            stream.emit({ type: "done", ok: true, response: "ok", ts: nowTs() });
            expect(lines).toHaveLength(2);
            const start = JSON.parse(lines[0].trim());
            expect(start.type).toBe("start");
            expect(start.prompt).toBe("hi");
            const done = JSON.parse(lines[1].trim());
            expect(done.type).toBe("done");
            expect(done.ok).toBe(true);
        } finally {
            process.stdout.write = original;
        }
    });

    it("is a no-op when disabled", () => {
        const lines: string[] = [];
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string | Uint8Array) => {
            lines.push(typeof chunk === "string" ? chunk : chunk.toString());
            return true;
        }) as typeof process.stdout.write;

        try {
            createEventStream(false).emit({ type: "start", prompt: "x", ts: 1 });
            expect(lines).toHaveLength(0);
        } finally {
            process.stdout.write = original;
        }
    });
});
