/**
 * Project-agnostic outcome-based scenario: run one spec file N times against
 * the *real* project and score stability. No ground truth needed, so this
 * works on any repo — the "not only for the playground" half of the harness.
 */

import type { RunOutcomeStatus } from "../../testing/run-outcome";
import { TestRunner, type TestRunResult } from "../../testing/runner";
import { scorer } from "../scorers";
import type { EvalScenario } from "../types";

/** Statuses only a test Playwright actually ran can carry. */
const EXECUTED_STATUSES = new Set<RunOutcomeStatus>(["passed", "failed", "flaky", "timeout"]);

export interface FlakinessEvalOptions {
    projectPath: string;
    /** Spec file to exercise, relative to the project (as Playwright expects). */
    testFile: string;
    /** Consecutive runs to compare. Defaults to 3. */
    runs?: number;
    /**
     * How many tests the suite is known to contain. Stability alone can't tell
     * a healthy suite from one that silently stopped collecting tests — every
     * run agreeing on "2 passed" is perfectly stable and completely wrong when
     * the file holds ten. Set for a ground-truth suite; omit elsewhere.
     */
    expectedTests?: number;
}

export function buildFlakinessScenario(
    options: FlakinessEvalOptions,
): EvalScenario<TestRunResult[][]> {
    const runs = options.runs ?? 3;
    if (!Number.isInteger(runs) || runs < 2) {
        throw new Error(
            `buildFlakinessScenario: runs must be an integer of 2 or more, got ${options.runs}`,
        );
    }

    return {
        id: "suite-flakiness",
        description: `Run ${options.testFile} ${runs}× and verify results are stable run-to-run.`,
        run: async (ctx) => {
            const runner = new TestRunner(options.projectPath);
            const allRuns: TestRunResult[][] = [];
            for (let i = 1; i <= runs; i++) {
                ctx.log(`run ${i}/${runs}…`);
                // Retries would be measuring the retry, not the test: a spec
                // that only passes on its second attempt is exactly the
                // instability this scenario exists to catch.
                allRuns.push(await runner.runTest(options.testFile, { retries: 0 }));
            }
            return allRuns;
        },
        scorers: [
            // A spawn failure produces a single synthetic `error` row, which is
            // "not skipped" — so this has to check for a status only a test
            // Playwright actually executed can carry.
            scorer("every-run-executed-tests", (allRuns) => ({
                passed: allRuns.every((results) =>
                    results.some((result) => EXECUTED_STATUSES.has(result.status)),
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
            ...(options.expectedTests === undefined
                ? []
                : [
                      scorer<TestRunResult[][]>("runs-the-whole-suite", (allRuns) => {
                          const counts = allRuns.map((results) => results.length);
                          const expected = options.expectedTests;
                          return {
                              passed: counts.every((count) => count === expected),
                              value: counts[0],
                              detail: `expected ${expected} test(s) per run, got ${counts.join(", ")}`,
                          };
                      }),
                  ]),
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
