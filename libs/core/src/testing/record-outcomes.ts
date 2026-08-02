/**
 * Best-effort bridge from any test runner to the failure memory.
 *
 * `test_outcomes` used to be written only by the agent's generate→run loop,
 * so `raiken test`, `report`, `ci`, repair verification and one-shot runs
 * left no trace — `raiken context` said "No recent failures recorded" seconds
 * after a red run, and repair prompts couldn't see recent history. Every
 * runner now funnels through here. Recording must never break a run: all
 * failures are swallowed.
 */

import { CodeGraphDB } from "../database/db";

export interface RunOutcomeRecord {
    testFile: string;
    testName: string;
    status: "passed" | "failed" | "error" | "timeout";
    durationMs?: number;
    errorMessage?: string;
    failingSelector?: string;
}

const ERROR_MESSAGE_CAP = 2000;

export function recordRunOutcomes(
    projectPath: string,
    outcomes: readonly RunOutcomeRecord[],
): void {
    const recordable = outcomes.filter((outcome) => outcome.testFile && outcome.testName);
    if (recordable.length === 0) return;
    try {
        const db = new CodeGraphDB(projectPath);
        try {
            for (const outcome of recordable) {
                db.upsertRunOutcome({
                    testFile: outcome.testFile,
                    testName: outcome.testName,
                    status: outcome.status,
                    ...(typeof outcome.durationMs === "number"
                        ? { executionTimeMs: Math.round(outcome.durationMs) }
                        : {}),
                    ...(outcome.errorMessage
                        ? { errorMessage: outcome.errorMessage.slice(0, ERROR_MESSAGE_CAP) }
                        : {}),
                    ...(outcome.failingSelector ? { failingSelector: outcome.failingSelector } : {}),
                });
            }
        } finally {
            db.close();
        }
    } catch {
        // Outcome memory is an enhancement; the run result stands on its own.
    }
}
