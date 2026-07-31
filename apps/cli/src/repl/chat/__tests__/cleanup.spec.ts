import { describe, expect, it, vi } from "vitest";
import { finalizeReplSession, shutdownRepl } from "../cleanup";
import type { ChatReplContext } from "../types";

vi.mock("@raiken/core", () => ({
    BrowserSession: {
        getInstance: vi.fn().mockReturnValue({
            close: vi.fn().mockResolvedValue(undefined),
        }),
    },
}));

describe("REPL cleanup", () => {
    it("shutdown closes browser, persists, and exits once", async () => {
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        const rl = { close: vi.fn() };
        const persist = vi.fn();
        const state = {
            closing: false,
            replFinalized: false,
            replTornDown: false,
            history: [],
            activeSessionName: null,
            permissionMode: "ask" as const,
        };
        const teardown = vi.fn(() => {
            state.replTornDown = true;
        });
        const ctx = {
            projectPath: "/proj",
            state,
            rl,
            persist,
        } as unknown as ChatReplContext;

        await shutdownRepl(ctx, { teardown, exit: true });
        expect(persist).toHaveBeenCalledTimes(1);
        expect(teardown).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(state.replFinalized).toBe(true);

        exitSpy.mockRestore();
    });

    it("finalize is idempotent when already finalized", async () => {
        const { BrowserSession } = await import("@raiken/core");
        const close = vi.fn().mockResolvedValue(undefined);
        vi.mocked(BrowserSession.getInstance).mockReturnValue({ close } as never);
        close.mockClear();

        const persist = vi.fn();
        const ctx = {
            projectPath: "/proj",
            state: {
                replFinalized: true,
                closing: true,
                history: [],
                permissionMode: "ask" as const,
            },
            persist,
        } as unknown as ChatReplContext;

        await finalizeReplSession(ctx);
        expect(persist).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
    });
});
