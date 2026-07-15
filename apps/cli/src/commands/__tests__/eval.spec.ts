import { afterEach, describe, expect, it, vi } from "vitest";
import { withThrowExit } from "../../repl/exit";
import { evalCommand } from "../eval";

describe("evalCommand", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("rejects an unknown suite with exit code 2", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const code = await withThrowExit(() => evalCommand("bogus", undefined, {}));
        expect(code).toBe(2);
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('Unknown eval suite "bogus"'),
        );
    });

    it("requires a target spec file for the flakiness suite", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const code = await withThrowExit(() => evalCommand("flakiness", undefined, {}));
        expect(code).toBe(2);
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("usage: raiken eval flakiness <testFile>"),
        );
    });

    it("fails clearly when the playground fixtures aren't present at --dir", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        // No fixtures under this throwaway directory — buildPlaygroundScenarios
        // should reject with a message pointing at the missing fixture, not an
        // opaque ENOENT surfaced straight from fs.
        await expect(
            withThrowExit(() => evalCommand("playground", undefined, { dir: "/tmp" })),
        ).rejects.toThrow(/playground evals/i);
        errorSpy.mockRestore();
    });
});
