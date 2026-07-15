/**
 * Project-agnostic outcome-based scenario: run one spec file N times against
 * the *real* project and score stability. No ground truth needed, so this
 * works on any repo — the "not only for the playground" half of the harness.
 */

import { TestRunner, type TestRunResult } from "../../testing/runner";
import { scorer } from "../scorers";
import type { EvalScenario } from "../types";

export interface FlakinessEvalOptions {
    projectPath: string;
    /** Spec file to exercise, relative to the project (as Playwright expects). */
    testFile: string;
    /** Consecutive runs to compare. Defaults to 3. */
    runs?: number;
}

export function buildFlakinessScenario(
    options: FlakinessEvalOptions,
): EvalScenario<TestRunResult[][]> {
    const runs = Math.max(2, options.runs ?? 3);

    return {
        id: "suite-flakiness",
        description: `Run ${options.testFile} ${runs}× and verify results are stable run-to-run.`,
        run: async (ctx) => {
            const runner = new TestRunner(options.projectPath);
            const allRuns: TestRunResult[][] = [];
            for (let i = 1; i <= runs; i++) {
                ctx.log(`run ${i}/${runs}…`);
                allRuns.push(await runner.runTest(options.testFile, {}));
            }
            return allRuns;
        },
        scorers: [
            scorer("every-run-executed-tests", (allRuns) => ({
                passed: allRuns.every((results) =>
                    results.some((result) => result.status !== "skipped"),
                ),
                detail: allRuns.map((results) => `${results.length} result(s)`).join(", "),
            })),
            scorer("stable-across-runs", (allRuns) => {
                const signatures = allRuns.map((results) =>
                    results
                        .map((result) => `${result.testName}=${result.status}`)
                        .sort()
                        .join("|"),
                );
                const unique = new Set(signatures);
                return {
                    passed: unique.size === 1,
                    value: unique.size,
                    detail:
                        unique.size === 1
                            ? signatures[0]
                            : `divergent outcomes: ${[...unique].join("  vs  ")}`,
                };
            }),
            scorer("suite-green", (allRuns) => {
                const failing = allRuns
                    .flat()
                    .filter((result) => result.status !== "passed" && result.status !== "skipped");
                return {
                    passed: failing.length === 0,
                    value: failing.length,
                    detail:
                        failing.length > 0
                            ? `${failing[0]?.testName}: ${failing[0]?.status}`
                            : undefined,
                };
            }),
        ],
    };
}
