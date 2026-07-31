import * as core from "@raiken/core";
import { describe, expect, it, vi } from "vitest";
import { runAgentTurn } from "../agent-turn";
import type { ChatReplContext } from "../types";

vi.mock("@raiken/core", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@raiken/core")>();
    return {
        ...actual,
        runOrchestrator: vi.fn(),
    };
});

describe("runAgentTurn cancellation", () => {
    it("rejects a parsed workflow and never persists the partial assistant stream", async () => {
        vi.mocked(core.runOrchestrator).mockImplementation(
            (options) =>
                (async function* () {
                    yield `partial<!--HITL:${JSON.stringify({
                        kind: "save_approval",
                        testCode: "test('x', () => {})",
                        suggestedPath: "e2e/x.spec.ts",
                        context: { workflowId: "wf-abort" },
                    })}-->`;
                    if (options.signal?.aborted) {
                        throw new DOMException("cancelled", "AbortError");
                    }
                    await new Promise<void>((_resolve, reject) => {
                        options.signal?.addEventListener(
                            "abort",
                            () => reject(new DOMException("cancelled", "AbortError")),
                            { once: true },
                        );
                    });
                })() as ReturnType<typeof core.runOrchestrator>,
        );
        const continueHitl = vi.fn().mockResolvedValue({ workflow: { status: "cancelled" } });
        const persist = vi.fn();
        const state = {
            planMode: false,
            history: [],
            permissionMode: "ask",
            verboseTools: false,
            thinking: null,
            currentAbort: null,
            turnActive: false,
            exitArmedUntil: 0,
        };
        const ctx = {
            projectPath: "/project",
            state,
            app: { hitl: { continue: continueHitl } },
            tools: {
                setVerbose: vi.fn(),
                onToolCall: vi.fn(),
                onProgress: vi.fn(),
                flush: vi.fn(),
            },
            stopThinking: vi.fn(),
            persist,
        } as unknown as ChatReplContext;

        const turn = runAgentTurn(ctx, "generate a test");
        await vi.waitFor(() => expect(state.currentAbort).not.toBeNull());
        state.currentAbort?.abort();
        await turn;

        expect(continueHitl).toHaveBeenCalledWith({
            workflowId: "wf-abort",
            action: "save",
            decision: "reject",
        });
        expect(state.history).toEqual([{ role: "user", content: "generate a test" }]);
        expect(persist).toHaveBeenCalledOnce();
    });
});
