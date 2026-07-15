import { describe, expect, it } from "vitest";
import { computeOneShotOutcome } from "../oneshot";

describe("computeOneShotOutcome", () => {
    it("reports ok when nothing was requested to fail", () => {
        expect(computeOneShotOutcome(null, null)).toEqual({ ok: true, exitCode: 0 });
    });

    it("reports ok when a requested run passed", () => {
        const run = { success: true, passed: 3, failed: 0, skipped: 0 };
        expect(computeOneShotOutcome(null, run)).toEqual({ ok: true, exitCode: 0 });
    });

    it("flips ok to false when the save failed, even with no run requested", () => {
        expect(computeOneShotOutcome("disk full", null)).toEqual({ ok: false, exitCode: 1 });
    });

    it("flips ok to false when the requested test run failed, even though the agent itself succeeded", () => {
        const run = { success: false, passed: 1, failed: 1, skipped: 0 };
        expect(computeOneShotOutcome(null, run)).toEqual({ ok: false, exitCode: 1 });
    });

    it("stays false when both save and run failed", () => {
        const run = { success: false, passed: 0, failed: 1, skipped: 0 };
        expect(computeOneShotOutcome("permission denied", run)).toEqual({
            ok: false,
            exitCode: 1,
        });
    });
});
