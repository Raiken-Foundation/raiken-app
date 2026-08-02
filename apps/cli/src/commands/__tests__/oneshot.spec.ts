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

    // Observed: an agent that stopped at a login form to ask for credentials
    // exited 0 having tested nothing, so a CI step went green on a flow that
    // never ran.
    it("fails with config/auth when the agent paused for user input", () => {
        const outcome = computeOneShotOutcome(
            base({
                awaitedUserInput: true,
                awaitUserMessage: "This page is asking for: Username, Password.",
            }),
        );
        expect(outcome.ok).toBe(false);
        expect(outcome.exitCode).toBe(3);
        expect(outcome.reason).toContain("Username, Password");
        expect(outcome.reason).toMatch(/raiken auth|auth\.credentials/);
    });

    // "No tests found" for a spec that exists means testMatch excluded it —
    // reporting "0 passed, 1 failed" sends people debugging the wrong thing.
    it("blames the playwright config when the saved spec is not collected", () => {
        const outcome = computeOneShotOutcome(
            base({
                producedTest: true,
                savedTest: "e2e/new.spec.ts",
                runRequested: true,
                runSummary: { success: false, passed: 0, failed: 1, skipped: 0 },
                uncollectedSpecReason:
                    'Saved e2e/new.spec.ts, but output path is not collected by playwright testMatch ("workflows.spec.ts").',
            }),
        );
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toMatch(/testMatch/);
        expect(outcome.reason).not.toMatch(/0 passed, 1 failed/);
    });

    it("reports the pause even when a test was produced and run first", () => {
        const outcome = computeOneShotOutcome(
            base({
                producedTest: true,
                savedTest: "e2e/login.spec.ts",
                runRequested: true,
                runSummary: { success: true, passed: 1, failed: 0, skipped: 0 },
                awaitedUserInput: true,
                awaitUserMessage: "Enter the verification code.",
            }),
        );
        expect(outcome.ok).toBe(false);
        expect(outcome.exitCode).toBe(3);
    });

    it("fails when the saved draft needs review (cover contract)", () => {
        const outcome = computeOneShotOutcome(
            base({
                producedTest: true,
                savedTest: "e2e/login.spec.ts",
                needsReview: true,
                reviewReasons: ["2 locator(s) match neither captured pages nor source markup"],
            }),
        );
        expect(outcome.ok).toBe(false);
        expect(outcome.exitCode).toBe(1);
        expect(outcome.reason).toMatch(/needs review/i);
        expect(outcome.reason).toMatch(/locator/);
    });

    it("fails when the saved draft is blocked", () => {
        const outcome = computeOneShotOutcome(
            base({
                producedTest: true,
                savedTest: "e2e/login.spec.ts",
                blocked: true,
                needsReview: true,
                reviewReasons: ["draft is not valid Playwright/TS: does not parse"],
            }),
        );
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toMatch(/blocked/i);
    });
});
