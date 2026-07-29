import { describe, expect, it } from "vitest";
import { computeOneShotOutcome, type OneShotOutcomeInput } from "../oneshot";

/** A run that asked for nothing and produced nothing: a plain question. */
function base(overrides: Partial<OneShotOutcomeInput> = {}): OneShotOutcomeInput {
    return {
        producedTest: false,
        saveRequested: true,
        savedTest: null,
        saveError: null,
        runRequested: false,
        runSummary: null,
        ...overrides,
    };
}

describe("computeOneShotOutcome", () => {
    it("reports ok when nothing was requested to fail", () => {
        expect(computeOneShotOutcome(base())).toEqual({ ok: true, exitCode: 0 });
    });

    it("reports ok when a requested run passed", () => {
        const outcome = computeOneShotOutcome(
            base({
                producedTest: true,
                savedTest: "e2e/login.spec.ts",
                runRequested: true,
                runSummary: { success: true, passed: 3, failed: 0, skipped: 0 },
            }),
        );
        expect(outcome).toEqual({ ok: true, exitCode: 0 });
    });

    it("flips ok to false when the save failed, even with no run requested", () => {
        expect(computeOneShotOutcome(base({ saveError: "disk full" }))).toMatchObject({
            ok: false,
            exitCode: 1,
            reason: "disk full",
        });
    });

    it("flips ok to false when the requested test run failed, even though the agent itself succeeded", () => {
        const outcome = computeOneShotOutcome(
            base({
                producedTest: true,
                savedTest: "e2e/login.spec.ts",
                runRequested: true,
                runSummary: { success: false, passed: 1, failed: 1, skipped: 0 },
            }),
        );
        expect(outcome.ok).toBe(false);
        expect(outcome.exitCode).toBe(1);
        expect(outcome.reason).toMatch(/1 passed, 1 failed/);
    });

    it("stays false when both save and run failed", () => {
        const outcome = computeOneShotOutcome(
            base({
                saveError: "permission denied",
                runRequested: true,
                runSummary: { success: false, passed: 0, failed: 1, skipped: 0 },
            }),
        );
        expect(outcome).toMatchObject({ ok: false, exitCode: 1 });
    });

    // The reported regression: a repair emitted tool tags, so nothing was
    // written and nothing ran, yet the command exited 0 with `ok: true`.
    it("fails when a test was generated but no file exists for it", () => {
        const outcome = computeOneShotOutcome(base({ producedTest: true, savedTest: null }));
        expect(outcome.ok).toBe(false);
        expect(outcome.exitCode).toBe(1);
        expect(outcome.reason).toMatch(/no file exists/i);
    });

    it("fails when a run was requested but never happened", () => {
        const outcome = computeOneShotOutcome(
            base({
                producedTest: true,
                savedTest: "e2e/login.spec.ts",
                runRequested: true,
                runSummary: null,
            }),
        );
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toMatch(/never executed/i);
    });

    // `--no-save` means no artifact was ever wanted, so its absence is not a
    // failure — otherwise every preview-only run would exit 1.
    it("does not demand an artifact when saving was turned off", () => {
        const outcome = computeOneShotOutcome(
            base({ producedTest: true, saveRequested: false, savedTest: null }),
        );
        expect(outcome).toEqual({ ok: true, exitCode: 0 });
    });

    // A question ("which pages need tests?") legitimately produces no test.
    it("does not demand an artifact when the agent produced no test", () => {
        const outcome = computeOneShotOutcome(base({ producedTest: false, runRequested: true }));
        expect(outcome).toEqual({ ok: true, exitCode: 0 });
    });
});
