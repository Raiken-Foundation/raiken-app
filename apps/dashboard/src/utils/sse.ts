export interface ConsumedSseChunk {
    data: string[];
    pending: string;
}

function dataPayload(line: string): string | null {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!normalized.startsWith("data:")) return null;
    const payload = normalized.slice(5);
    return payload.startsWith(" ") ? payload.slice(1) : payload;
}

/**
 * Consumes complete SSE lines while preserving the trailing partial line for
 * the next network chunk. ReadableStream chunk boundaries are unrelated to
 * SSE event boundaries, so callers must retain `pending` between reads.
 */
export function consumeSseChunk(pending: string, chunk: string): ConsumedSseChunk {
    const lines = `${pending}${chunk}`.split("\n");
    const nextPending = lines.pop() ?? "";
    const data: string[] = [];

    for (const line of lines) {
        const payload = dataPayload(line);
        if (payload !== null) data.push(payload);
    }

    return { data, pending: nextPending };
}

/**
 * Flushes a final unterminated `data:` line when the response body closes.
 */
export function flushSsePending(pending: string): string[] {
    const payload = dataPayload(pending);
    return payload === null ? [] : [payload];
}

/**
 * Decodes a byte stream into JSON SSE events without assuming that network
 * chunks align with UTF-8 characters or SSE lines.
 */
export async function* readSseJsonStream<T>(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<T, void, void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";

    const parse = (payloads: string[]): T[] =>
        payloads.filter((payload) => payload.length > 0).map((payload) => JSON.parse(payload) as T);

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const consumed = consumeSseChunk(pending, decoder.decode(value, { stream: true }));
            pending = consumed.pending;
            for (const event of parse(consumed.data)) yield event;
        }

        const consumed = consumeSseChunk(pending, decoder.decode());
        for (const event of parse([...consumed.data, ...flushSsePending(consumed.pending)])) {
            yield event;
        }
    } finally {
        reader.releaseLock();
    }
}
