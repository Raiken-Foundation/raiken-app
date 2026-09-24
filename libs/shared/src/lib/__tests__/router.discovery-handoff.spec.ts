import { describe, expect, it } from "vitest";
import { appRouter } from "../router";

describe("cancelBrowserHandoff router integration", () => {
    it("returns typed failure when no handoff is active", async () => {
        const caller = appRouter.createCaller({ projectPath: process.cwd() });
        const result = await caller.cancelBrowserHandoff({});
        expect(result).toMatchObject({
            success: false,
            message: expect.stringMatching(/no browser handoff/i),
            runtime: expect.objectContaining({ phase: expect.any(String) }),
        });
    });
});
