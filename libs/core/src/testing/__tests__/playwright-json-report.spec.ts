import { describe, expect, it } from "vitest";
import {
    extractReporterJson,
    mapReportToTestRunResults,
    mapTestRunResultsToParsedRun,
} from "../playwright-json-report";
import { parsePlaywrightReport } from "../report-parser";
import {
    isTestRunSuccessful,
    mergeRepetitionResults,
    summarizeSpecAttempts,
    summarizeTestRunCounts,
    summarizeTestRunResults,
} from "../run-outcome";
import type { TestRunResult } from "../test-run-result";

const PASS = { status: "passed", duration: 10 };
const FAIL = { status: "failed", duration: 5, error: { message: "modal intercepted" } };

function nestedFlakyReport() {
    return {
        suites: [
            {
                title: "example.spec.ts",
                suites: [
                    {
                        title: "Workspace",
                        specs: [
                            {
                                id: "w1",
                                title: "deletes a workspace",
                                tests: [{ results: [PASS, FAIL] }],
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

function repeatedSpecReport() {
    return {
        suites: [
            {
                title: "example.spec.ts",
                specs: [
                    { title: "deletes a workspace", tests: [{ results: [PASS] }] },
                    { title: "deletes a workspace", tests: [{ results: [FAIL] }] },
                ],
            },
        ],
    };
}

describe("playwright JSON report parser", () => {
    it("extracts JSON from noisy stdout", () => {
        const json = extractReporterJson('npm warn ok\n{"suites":[{"specs":[]}]}');
        expect(json?.suites).toHaveLength(1);
    });

    it("marks pass-on-retry attempts as flaky", () => {
        const summary = summarizeSpecAttempts({
            title: "deletes a workspace",
            tests: [{ results: [FAIL, PASS] }],
        });
        expect(summary?.status).toBe("flaky");
    });

    it("merges separate repeat-each specs into one flaky result", () => {
        const results = mapReportToTestRunResults(repeatedSpecReport(), "e2e/example.spec.ts");
        expect(results).toHaveLength(1);
        expect(results[0].status).toBe("flaky");
        expect(results[0].error?.message).toBe("modal intercepted");
    });

    it("preserves nested suite breadcrumbs for dashboard reports", () => {
        const run = parsePlaywrightReport(nestedFlakyReport());
        expect(run.tests[0]?.suite).toBe("example.spec.ts > Workspace");
    });

    it("maps flaky runs to failed dashboard cases without treating them as passed", () => {
        const runResults = mapReportToTestRunResults(repeatedSpecReport(), "e2e/example.spec.ts");
        const parsed = mapTestRunResultsToParsedRun(runResults);
        expect(parsed.tests[0]?.status).toBe("failed");
        expect(isTestRunSuccessful(runResults)).toBe(false);
    });
});

describe("run-outcome summarization", () => {
    it("never records flaky as passed for learning", () => {
        const results: TestRunResult[] = [
            {
                testFile: "e2e/a.spec.ts",
                testName: "a",
                status: "flaky",
                duration: 12,
                error: { message: "boom" },
            },
        ];
        expect(summarizeTestRunResults(results).status).toBe("failed");
        expect(summarizeTestRunCounts(results).failed).toBe(1);
    });

    it("merges repetitions consistently", () => {
        const merged = mergeRepetitionResults([
            { testFile: "f", testName: "t", status: "passed", duration: 10 },
            { testFile: "f", testName: "t", status: "failed", duration: 5 },
        ]);
        expect(merged[0].status).toBe("flaky");
        expect(merged[0].duration).toBe(15);
    });
});

describe("cross-adapter outcome parity", () => {
    it("agrees on success/failure between runner rows and parsed dashboard runs", () => {
        const runResults = mapReportToTestRunResults(repeatedSpecReport(), "e2e/example.spec.ts");
        const parsed = mapTestRunResultsToParsedRun(runResults);
        const counts = summarizeTestRunCounts(runResults);

        expect(isTestRunSuccessful(runResults)).toBe(false);
        expect(parsed.summary.tests.failed).toBe(counts.failed);
        expect(parsed.summary.tests.passed).toBe(counts.passed);
    });
});
