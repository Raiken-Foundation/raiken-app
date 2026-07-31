/**
 * Shared run-outcome vocabulary for agent learning, repair verification,
 * dashboard recording, and CI summaries.
 */

import type { PlaywrightJsonResult, PlaywrightJsonSpec } from "./playwright-json-types";
import type { ParsedPlaywrightRun, ReportTestCase } from "./playwright-report-model";
import type { RunOutcomeStatus, TestRunResult } from "./test-run-result";

export type { RunOutcomeStatus, TestRunResult };

/** A verdict that is neither a pass nor a deliberate skip. */
export function isFailureStatus(status: RunOutcomeStatus): boolean {
    return status !== "passed" && status !== "skipped";
}

/** Map one Playwright attempt status onto our result vocabulary. */
export function mapAttemptStatus(status: string | undefined): RunOutcomeStatus {
    if (status === "passed") return "passed";
    if (status === "timedOut") return "timeout";
    if (status === "skipped") return "skipped";
    // `interrupted` and unknown failure-like statuses are failures, never skips.
    if (status === "interrupted") return "failed";
    return "failed";
}

export interface SpecAttemptSummary {
    status: RunOutcomeStatus;
    duration: number;
    error?: PlaywrightJsonResult["error"];
    attachments?: PlaywrightJsonResult["attachments"];
}

/**
 * Collapse every attempt Playwright recorded for one spec into a single verdict.
 */
export function summarizeSpecAttempts(spec: PlaywrightJsonSpec): SpecAttemptSummary | null {
    const attemptGroups = (spec.tests ?? [])
        .map((test) => test.results ?? [])
        .filter((group) => group.length > 0);
    const attempts = attemptGroups.flat();
    if (attempts.length === 0) return null;
    const last = attempts[attempts.length - 1];

    const perRepetition = attemptGroups.map((group) =>
        mapAttemptStatus(group[group.length - 1].status),
    );
    const passedOnRetry = attemptGroups.some(
        (group) =>
            mapAttemptStatus(group[group.length - 1].status) === "passed" &&
            group.slice(0, -1).some((attempt) => isFailureStatus(mapAttemptStatus(attempt.status))),
    );

    const failing = perRepetition.filter(isFailureStatus);
    const anyPassed = perRepetition.includes("passed");

    let status: RunOutcomeStatus;
    if (failing.length > 0 && (anyPassed || passedOnRetry)) status = "flaky";
    else if (failing.length > 0) status = failing[0];
    else if (passedOnRetry) status = "flaky";
    else if (anyPassed) status = "passed";
    else status = "skipped";

    const failure = attempts.find((attempt) => attempt.error) || last;
    return {
        status,
        duration: last.duration || 0,
        error: isFailureStatus(status) ? failure.error : undefined,
        attachments: last.attachments,
    };
}

/**
 * Collapse repetitions of the same test into one verdict.
 *
 * `--repeat-each` reports each repetition as its own spec entry sharing a
 * title; without merging, callers see "1 passed, 1 failed" for one test.
 */
export function mergeRepetitionResults(results: TestRunResult[]): TestRunResult[] {
    const order: string[] = [];
    const groups = new Map<string, TestRunResult[]>();

    for (const result of results) {
        const key = `${result.testFile}\u0000${result.testName}`;
        const group = groups.get(key);
        if (group) group.push(result);
        else {
            groups.set(key, [result]);
            order.push(key);
        }
    }

    return order.map((key) => {
        const group = groups.get(key) as TestRunResult[];
        if (group.length === 1) return group[0];

        const statuses = group.map((r) => r.status);
        const failing = statuses.filter(isFailureStatus);
        const unstable =
            statuses.includes("flaky") ||
            (failing.length > 0 && statuses.some((s) => s === "passed"));

        let status: RunOutcomeStatus;
        if (unstable) status = "flaky";
        else if (failing.length > 0) status = failing[0];
        else if (statuses.includes("passed")) status = "passed";
        else status = "skipped";

        const duration = group.reduce((total, r) => total + (r.duration || 0), 0);
        const merged: TestRunResult = { ...group[0], status, duration };

        const failure = group.find((r) => r.error);
        if (isFailureStatus(status) && failure?.error) merged.error = failure.error;
        else if (!isFailureStatus(status)) delete merged.error;

        const withAttachments = group.find((r) => r.attachments?.length);
        if (withAttachments?.attachments) merged.attachments = withAttachments.attachments;

        return merged;
    });
}

export interface TestRunCountSummary {
    total: number;
    passed: number;
    failed: number;
    timedOut: number;
    errored: number;
    skipped: number;
    flaky: number;
}

/** Count statuses consistently across adapters. */
export function countTestRunOutcomes(results: TestRunResult[]): TestRunCountSummary {
    const summary: TestRunCountSummary = {
        total: results.length,
        passed: 0,
        failed: 0,
        timedOut: 0,
        errored: 0,
        skipped: 0,
        flaky: 0,
    };
    for (const r of results) {
        if (r.status === "passed") summary.passed++;
        else if (r.status === "failed") summary.failed++;
        else if (r.status === "flaky") summary.flaky++;
        else if (r.status === "timeout") summary.timedOut++;
        else if (r.status === "skipped") summary.skipped++;
        else summary.errored++;
    }
    return summary;
}

/** CI-style summary: flaky counts as failed; skipped excluded from pass/fail buckets. */
export function summarizeTestRunCounts(
    results: TestRunResult[],
): Omit<TestRunCountSummary, "skipped" | "flaky"> {
    const counts = countTestRunOutcomes(results);
    return {
        total: counts.total,
        passed: counts.passed,
        failed: counts.failed + counts.flaky,
        timedOut: counts.timedOut,
        errored: counts.errored,
    };
}

const MEMORY_STATUS_RANK: Record<string, number> = {
    error: 3,
    timeout: 2,
    failed: 1,
    flaky: 1,
    skipped: 0,
    passed: 0,
};

/**
 * Collapse a multi-test run into the single-outcome shape `test_outcomes` tracks.
 * `flaky` is recorded as `failed` — it must never be remembered as passed.
 */
export function summarizeTestRunResults(results: TestRunResult[]): {
    status: "passed" | "failed" | "error" | "timeout";
    durationMs: number;
    errorMessage?: string;
    failingSelector?: string;
} {
    const durationMs = results.reduce((sum, r) => sum + (r.duration || 0), 0);
    let worst: TestRunResult | undefined;
    for (const r of results) {
        if (
            !worst ||
            (MEMORY_STATUS_RANK[r.status] ?? 0) > (MEMORY_STATUS_RANK[worst.status] ?? 0)
        ) {
            worst = r;
        }
    }
    const status: "passed" | "failed" | "error" | "timeout" = !worst
        ? "passed"
        : worst.status === "error" || worst.status === "timeout"
          ? worst.status
          : worst.status === "failed" || worst.status === "flaky"
            ? "failed"
            : "passed";
    return {
        status,
        durationMs,
        errorMessage: worst?.error?.message,
        failingSelector: worst?.error?.selector,
    };
}

/** Whether every non-skipped test passed without flaky/timeout/error. */
export function isTestRunSuccessful(results: TestRunResult[]): boolean {
    if (results.length === 0) return false;
    return results.every((r) => r.status === "passed" || r.status === "skipped");
}

/**
 * Summarize a parsed dashboard run the same way agent learning does.
 *
 * `inconclusive` marks a run that executed nothing (empty report, or every test
 * skipped). Such a run is not evidence that the spec passes, so callers that
 * report a verdict to the user must not treat it as one.
 */
export function summarizeParsedPlaywrightRun(run: ParsedPlaywrightRun): {
    passed: boolean;
    inconclusive: boolean;
    failureCount: number;
    memoryStatus: "passed" | "failed";
    durationMs: number;
    errorMessage?: string;
} {
    const actionable = run.tests.filter((t) => t.status !== "skipped");
    if (actionable.length === 0) {
        return {
            passed: false,
            inconclusive: true,
            failureCount: 0,
            memoryStatus: "passed",
            durationMs: 0,
        };
    }

    const failureCount = actionable.filter((t: ReportTestCase) => t.status === "failed").length;
    const passed = failureCount === 0;
    const failure = actionable.find((t) => t.status === "failed");
    const durationMs = run.tests.reduce((sum, test) => sum + (test.duration || 0), 0);

    return {
        passed,
        inconclusive: false,
        failureCount,
        memoryStatus: passed ? "passed" : "failed",
        durationMs,
        errorMessage: failure?.error?.message,
    };
}

/** Map parsed run tests back to {@link TestRunResult} for shared summarization. */
export function parsedRunToTestRunResults(
    run: ParsedPlaywrightRun,
    testFile: string,
): TestRunResult[] {
    return run.tests.map((test) => ({
        testFile,
        testName: test.name,
        status:
            test.status === "passed" ? "passed" : test.status === "skipped" ? "skipped" : "failed",
        duration: test.duration ?? 0,
        error: test.error?.message
            ? { message: test.error.message, stack: test.error.snippet }
            : undefined,
        attachments: test.attachments,
    }));
}
