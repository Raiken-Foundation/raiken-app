import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { runEvalScenarios } from "../runner";
import { atLeast, scorer } from "../scorers";
import type { EvalScenario, EvalTarget } from "../types";

function fakeTarget(events: string[]): EvalTarget {
    return {
        name: "fake",
        async start() {
            events.push("start");
            return { baseUrl: "http://127.0.0.1:0" };
        },
        async stop() {
            events.push("stop");
        },
    };
}

describe("runEvalScenarios", () => {
    it("runs attempts, applies scorers, and aggregates pass rate", async () => {
        let calls = 0;
        const scenario: EvalScenario<number> = {
            id: "counting",
            description: "returns the attempt number",
            run: async () => ++calls,
            scorers: [
                // Passes on attempts 2 and 3, fails on 1.
                atLeast("at-least-two", 2, (n) => n),
            ],
        };

        const report = await runEvalScenarios([scenario], { repeat: 3 });
        expect(report.scenarios[0].attempts.map((a) => a.passed)).toEqual([false, true, true]);
        expect(report.scenarios[0].passRate).toBeCloseTo(2 / 3);
        expect(report.passed).toBe(false);
    });

    it("gives each attempt a fresh work directory and cleans it up", async () => {
        const seen: string[] = [];
        const scenario: EvalScenario<string> = {
            id: "workdirs",
            description: "records its work dir",
            run: async (ctx) => {
                seen.push(ctx.workDir);
                expect(fs.existsSync(ctx.workDir)).toBe(true);
                return ctx.workDir;
            },
            scorers: [scorer("ok", () => true)],
        };

        const report = await runEvalScenarios([scenario], { repeat: 2 });
        expect(report.passed).toBe(true);
        expect(new Set(seen).size).toBe(2);
        for (const dir of seen) expect(fs.existsSync(dir)).toBe(false);
    });

    it("always stops the target, even when the run throws", async () => {
        const events: string[] = [];
        const scenario: EvalScenario<void> = {
            id: "explodes",
            description: "throws mid-run",
            createTarget: () => fakeTarget(events),
            run: async () => {
                throw new Error("kaboom");
            },
            scorers: [scorer("unreachable", () => true)],
        };

        const report = await runEvalScenarios([scenario]);
        expect(events).toEqual(["start", "stop"]);
        expect(report.scenarios[0].attempts[0].passed).toBe(false);
        expect(report.scenarios[0].attempts[0].error).toContain("kaboom");
        expect(report.passed).toBe(false);
    });

    it("reports incomplete evaluation when requirements are missing", async () => {
        const scenario: EvalScenario<void> = {
            id: "needs-llm",
            description: "requires an API key",
            requiresEnv: ["RAIKEN_EVAL_SPEC_DEFINITELY_UNSET_VAR"],
            run: async () => {
                throw new Error("should never run");
            },
            scorers: [scorer("unreachable", () => true)],
        };

        const report = await runEvalScenarios([scenario]);
        expect(report.scenarios[0].skipped).toContain("RAIKEN_EVAL_SPEC_DEFINITELY_UNSET_VAR");
        expect(report.scenarios[0].attempts).toHaveLength(0);
        expect(report.passed).toBe(false);
    });

    it("a scorer that throws marks the attempt failed instead of aborting the run", async () => {
        const scenario: EvalScenario<number> = {
            id: "bad-scorer",
            description: "scorer throws",
            run: async () => 1,
            scorers: [
                scorer("throws", () => {
                    throw new Error("scorer bug");
                }),
                scorer("fine", () => true),
            ],
        };

        const report = await runEvalScenarios([scenario]);
        const attempt = report.scenarios[0].attempts[0];
        expect(attempt.passed).toBe(false);
        expect(attempt.scores.find((s) => s.name === "throws")?.detail).toContain("scorer bug");
        expect(attempt.scores.find((s) => s.name === "fine")?.passed).toBe(true);
    });

    it("filters scenarios by id substring", async () => {
        const make = (id: string): EvalScenario<void> => ({
            id,
            description: id,
            run: async () => {},
            scorers: [scorer("ok", () => true)],
        });
        const report = await runEvalScenarios([make("alpha-one"), make("beta-two")], {
            filter: "beta",
        });
        expect(report.scenarios.map((s) => s.id)).toEqual(["beta-two"]);
    });
});

it("does not report success for an empty evaluation selection", async () => {
    expect((await runEvalScenarios([])).passed).toBe(false);
});
it.each([0, -1, 1.5, Number.NaN])("rejects invalid repeat count %s", async (repeat) => {
    await expect(runEvalScenarios([], { repeat })).rejects.toThrow(/positive integer/);
});
