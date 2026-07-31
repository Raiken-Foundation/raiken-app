import { describe, expect, it, vi } from "vitest";
import { clearConversation } from "../../sessions";
import { handleClear } from "../slash/handlers/session";
import type { ChatReplContext } from "../types";

vi.mock("../../sessions", () => ({
    clearConversation: vi.fn().mockResolvedValue(undefined),
}));

describe("session slash handlers", () => {
    it("clear wipes history, queue, and active session name", async () => {
        const state = {
            history: [{ role: "user" as const, content: "hi" }],
            activeSessionName: "demo",
        };
        const inputQueue = { clear: vi.fn() };
        const ctx = {
            projectPath: "/proj",
            app: { chat: {} },
            state,
            inputQueue,
            persist: vi.fn(),
        } as unknown as ChatReplContext;

        await handleClear(ctx, { positionals: [], flags: new Map() }, "");

        expect(clearConversation).toHaveBeenCalledWith("/proj", ctx.app.chat);
        expect(state.history).toHaveLength(0);
        expect(inputQueue.clear).toHaveBeenCalled();
        expect(state.activeSessionName).toBeNull();
    });
});
