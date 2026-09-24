import { describe, expect, it } from "vitest";
import { assessIntentCoverage } from "../../cover/intent-coverage";
import { changedAssertedValues, missingScenarioExpectations } from "../../cover/repair-setup";
import { buildFlakinessScenario } from "../../evals/scenarios/flakiness";
import { mapReportToTestRunResults, parsePlaywrightJsonReport } from "../playwright-json-report";
import { validateTestCode } from "../test-code-validation";

describe("trust regressions", () => {
    it("retains distinct test identities and counts every failing suite", () => {
        const report = {
            suites: ["a.spec.ts", "b.spec.ts"].map((file) => ({
                title: file,
                specs: [
                    {
                        file,
                        title: "renders",
                        tests: [{ results: [{ status: "failed", error: { message: file } }] }],
                    },
                ],
            })),
        };
        const results = mapReportToTestRunResults(report, "unknown");
        expect(results.map((r) => r.testFile)).toEqual(["a.spec.ts", "b.spec.ts"]);
        expect(results.map((r) => r.error?.message)).toEqual(["a.spec.ts", "b.spec.ts"]);
        expect(parsePlaywrightJsonReport(report).summary.suites).toEqual({
            total: 2,
            failed: 2,
            passed: 0,
        });
    });
    it("rejects expected values present only in the test title", () => {
        const code = `test('cart total is $59.00', async () => { expect(true).toBe(true); });`;
        expect(missingScenarioExpectations(code, "cart total is $59.00")).toContain("$59.00");
        expect(assessIntentCoverage("cart total is $59.00", code).vacuous).toBe(true);
    });
    it.each([
        [`expect(price).toHaveText('$59.00')`, `expect(price).not.toHaveText('$59.00')`],
        [`expect(total).toBe(59)`, `expect(total).toBe(49)`],
        [`expect(price).toHaveText('$59.00')`, `expect(price).toContainText('$59.00')`],
        [`expect(price).toBeVisible()`, `expect(price).toBeHidden()`],
    ])("rejects changed assertion semantics: %s", (before, after) => {
        expect(changedAssertedValues(before, after).length).toBeGreaterThan(0);
    });
    it("rejects a commented test declaration", () => {
        expect(validateTestCode(`// test('pretend', () => {});\nexport const x = 1;`).ok).toBe(
            false,
        );
    });
    it("does not count skipped critical tests as verified coverage", async () => {
        const scenario = buildFlakinessScenario({
            projectPath: "/tmp",
            testFile: "x.spec.ts",
            expectedTests: 2,
        });
        const rows = [
            { testFile: "x.spec.ts", testName: "sanity", status: "passed" as const, duration: 1 },
            {
                testFile: "x.spec.ts",
                testName: "critical",
                status: "skipped" as const,
                duration: 0,
            },
        ];
        const scores = await Promise.all(
            scenario.scorers.map((s) =>
                s.score([rows, rows], { workDir: "/tmp", baseUrl: null, log: () => {} }),
            ),
        );
        expect(scores.every((s) => s.passed)).toBe(false);
    });
});

it("normalizes reporter rootDir for explicit and whole-suite runs", () => {
    const report = {
        config: { rootDir: "/workspace/e2e" },
        suites: [
            {
                title: "login.spec.ts",
                specs: [
                    {
                        file: "login.spec.ts",
                        title: "login",
                        tests: [
                            { projectName: "chromium", results: [{ status: "passed" }] },
                            { projectName: "firefox", results: [{ status: "failed" }] },
                        ],
                    },
                ],
            },
        ],
    };
    for (const target of ["e2e/login.spec.ts", "unknown"]) {
        const results = mapReportToTestRunResults(report, target, 0, "/workspace");
        expect(results.map((r) => r.testFile)).toEqual(["e2e/login.spec.ts", "e2e/login.spec.ts"]);
        expect(results.map((r) => r.projectName)).toEqual(["chromium", "firefox"]);
        expect(results.map((r) => r.status)).toEqual(["passed", "failed"]);
    }
});
