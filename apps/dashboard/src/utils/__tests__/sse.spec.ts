import { describe, expect, it } from "vitest";
import { consumeSseChunk, flushSsePending, readSseJsonStream } from "../sse";

describe("SSE stream parsing", () => {
    it("retains a data line split across network chunks", () => {
        const first = consumeSseChunk("", 'data: {"chunk":"hel');
        expect(first.data).toEqual([]);

        const second = consumeSseChunk(first.pending, 'lo"}\n\ndata: {"done":');
        expect(second.data).toEqual(['{"chunk":"hello"}']);

        const third = consumeSseChunk(second.pending, "true}\n\n");
        expect(third.data).toEqual(['{"done":true}']);
        expect(third.pending).toBe("");
    });

    it("flushes an unterminated final data line", () => {
        expect(flushSsePending('data: {"done":true}')).toEqual(['{"done":true}']);
    });

    it("decodes UTF-8 and JSON across arbitrary byte boundaries", async () => {
        const encoded = new TextEncoder().encode(
            'data: {"chunk":"héllo"}\n\ndata: {"done":true}\n\n',
        );
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoded.slice(0, 16));
                controller.enqueue(encoded.slice(16, 19));
                controller.enqueue(encoded.slice(19));
                controller.close();
            },
        });

        const events: Array<{ chunk?: string; done?: boolean }> = [];
        for await (const event of readSseJsonStream<{ chunk?: string; done?: boolean }>(stream)) {
            events.push(event);
        }

        expect(events).toEqual([{ chunk: "héllo" }, { done: true }]);
    });
});
