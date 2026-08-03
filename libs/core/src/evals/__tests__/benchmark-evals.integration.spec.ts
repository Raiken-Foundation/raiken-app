/**
 * Live run of the accuracy-regression benchmark suite against the full
 * `tools/playground-tasks` fixture (real Vite dev server, real Chromium, real
 * crawls). This is the permanent gate for the batch 1–4 fixes: blocker
 * layering, resumed crawls, authenticated route recall, modal grounding, and
 * auth preconditions.
 *
 * Slow by nature. Each scenario is asserted separately so a failure names the
 * behavior that regressed instead of "the suite".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runEvalScenarios } from "../runner";
import { buildBenchmarkScenarios } from "../scenarios/benchmark";
import type { ScenarioReport } from "../types";

const TOOLS_DIR = path.join(__dirname, "..", "..", "..", "..", "..", "tools");
const AUTH_DIR = path.join(TOOLS_DIR, "playground-tasks");
const HAVE_FIXTURE =
    fs.existsSync(path.join(AUTH_DIR, "auth-server.ts")) &&
    fs.existsSync(path.join(AUTH_DIR, "node_modules", "vite", "bin", "vite.js"));

/** Every failing scorer (and any thrown attempt), as readable lines. */
function describeFailures(scenario: ScenarioReport): string[] {
    return scenario.attempts.flatMap((attempt) => {
        const scores = attempt.scores
            .filter((score) => !score.passed)
            .map((score) => `${scenario.id} / ${score.name}: ${score.detail ?? "failed"}`);
        return attempt.error ? [...scores, `${scenario.id} threw: ${attempt.error}`] : scores;
    });
}

describe.skipIf(!HAVE_FIXTURE)("benchmark eval suite (integration)", () => {
    const scenarios = HAVE_FIXTURE ? buildBenchmarkScenarios({ tasksDir: AUTH_DIR }) : [];

    for (const scenario of scenarios) {
        it(scenario.description, { timeout: 300_000 }, async () => {
            const report = await runEvalScenarios([scenario]);
            const [result] = report.scenarios;
            const failures = describeFailures(result);

            expect(failures, failures.join("\n")).toEqual([]);
            expect(report.passed).toBe(true);
        });
    }
});
