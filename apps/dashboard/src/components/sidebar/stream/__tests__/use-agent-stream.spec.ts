import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";
import { AgentStreamError, parseFailedAgentResponse, useAgentStream } from "../use-agent-stream";

describe("useAgentStream error handling", () => {
    it("surfaces safe.message from structured SSE errors", () => {
        const err = new AgentStreamError({
            message: "Provider rate limited",
            raikenCode: "AI_RATE_LIMIT",
            retryable: true,
            correlationId: "abc",
        });
        expect(err.message).toBe("Provider rate limited");
        expect(err.raikenCode).toBe("AI_RATE_LIMIT");
        expect(err.retryable).toBe(true);
        expect(err.correlationId).toBe("abc");
        expect(String(err)).not.toContain("[object Object]");
    });

    it("supports legacy string SSE errors", () => {
        const err = new AgentStreamError("Generation failed");
        expect(err.message).toBe("Generation failed");
    });

    it("preserves safe structured errors from non-2xx responses", async () => {
        const response = new Response(
            JSON.stringify({
                error: "Authentication required",
                raiken: {
                    message: "Authentication required",
                    code: "AUTH_REQUIRED",
                    retryable: false,
                    correlationId: "corr-1",
                },
            }),
            { status: 401, headers: { "Content-Type": "application/json" } },
        );

        const err = await parseFailedAgentResponse(response);
        expect(err).toBeInstanceOf(AgentStreamError);
        expect(err.message).toBe("Authentication required");
        expect(err.raikenCode).toBe("AUTH_REQUIRED");
        expect(err.correlationId).toBe("corr-1");
    });
});

/** A body that emits one chunk, then stays open until `finish()` is called. */
function controllableSseBody() {
    let release: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
        release = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
        async start(controller) {
            controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify({ chunk: "hello" })}\n\n`),
            );
            await closed;
            controller.close();
        },
    });
    return { body, finish: () => release?.() };
}

describe("useAgentStream concurrent turns", () => {
    it("supersedes an in-flight stream and keeps generating until the newest one ends", async () => {
        const first = controllableSseBody();
        const second = controllableSseBody();
        const bodies = [first, second];
        const signals: AbortSignal[] = [];

        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url: string, init: RequestInit) => {
                if (init.signal) signals.push(init.signal);
                const next = bodies.shift();
                return new Response(next?.body, { status: 200 });
            }),
        );

        const setMessages = vi.fn() as unknown as React.Dispatch<React.SetStateAction<Message[]>>;
        const { result } = renderHook(() => useAgentStream());

        let firstRun: Promise<void> | undefined;
        await act(async () => {
            firstRun = result.current.runStream({ prompt: "one" }, "msg-1", setMessages);
            await Promise.resolve();
        });

        let secondRun: Promise<void> | undefined;
        await act(async () => {
            secondRun = result.current.runStream({ prompt: "two" }, "msg-2", setMessages);
            await Promise.resolve();
        });

        expect(signals[0]?.aborted).toBe(true);

        // The superseded stream settling must not clear state owned by the
        // newer one.
        await act(async () => {
            first.finish();
            await firstRun;
        });
        expect(result.current.isGenerating).toBe(true);
        expect(result.current.handleStop()).toBe(true);

        await act(async () => {
            second.finish();
            await secondRun;
        });

        vi.unstubAllGlobals();
    });
});
