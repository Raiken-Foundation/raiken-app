/**
 * Single walker/parser for Playwright JSON reporter output.
 *
 * Raw tree traversal lives here once; consumer mappers adapt the walked specs
 * into {@link TestRunResult} (agent/repair/CI) or {@link ParsedPlaywrightRun}
 * (dashboard/report writer).
 */

import type {
    PlaywrightJsonReport,
    PlaywrightJsonSuite,
    WalkedPlaywrightSpec,
} from "./playwright-json-types";
import type { ParsedPlaywrightRun, ReportTestCase } from "./playwright-report-model";
import { isFailureStatus, mergeRepetitionResults, summarizeSpecAttempts } from "./run-outcome";
import type { TestRunResult } from "./test-run-result";

export type {
    PlaywrightJsonReport,
    PlaywrightJsonResult,
    PlaywrightJsonSpec,
    PlaywrightJsonSuite,
    WalkedPlaywrightSpec,
} from "./playwright-json-types";

/**
 * Extract the Playwright JSON reporter object from a mixed stdout stream.
 */
export function extractReporterJson(output: string): PlaywrightJsonReport | null {
    try {
        const parsed = JSON.parse(output);
        if (parsed && typeof parsed === "object" && "suites" in parsed) return parsed;
    } catch {
        // fall through to scanning
    }

    for (let i = 0; i < output.length; i++) {
        if (output[i] !== "{") continue;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let j = i; j < output.length; j++) {
            const ch = output[j];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === "\\") escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === "{") depth++;
            else if (ch === "}") {
                depth--;
                if (depth === 0) {
                    const candidate = output.slice(i, j + 1);
                    try {
                        const parsed = JSON.parse(candidate);
                        if (parsed && typeof parsed === "object" && "suites" in parsed) {
                            return parsed;
                        }
                    } catch {
                        // keep scanning
                    }
                    i = j;
                    break;
                }
            }
        }
    }

    return null;
}

/** Walk nested suites/specs once, yielding each spec with its suite breadcrumb. */
export function walkPlaywrightReport(
    report: PlaywrightJsonReport,
    visitor: (entry: WalkedPlaywrightSpec) => void,
): void {
    const walkSuites = (suites: PlaywrightJsonSuite[], parentTitle = ""): void => {
        for (const suite of suites || []) {
            const suiteName = parentTitle
                ? `${parentTitle} > ${suite.title ?? ""}`
                : (suite.title ?? "");

            for (const spec of suite.specs || []) {
                visitor({ suitePath: suiteName, spec });
            }
            if (suite.suites) walkSuites(suite.suites, suiteName);
        }
    };

    walkSuites(report.suites || []);
}

/** One row of `playwright test --list` output: identity only, no run status. */
export interface ListedPlaywrightTest {
    title: string;
    suite: string;
    file?: string;
    line?: number;
}

/**
 * Adapt a `--list` JSON report into flat test rows. A list report has the
 * same suite/spec tree as a run report but no attempt results, so the
 * outcome mapper (which needs results) cannot see it.
 */
export function listTestsFromReport(report: PlaywrightJsonReport): ListedPlaywrightTest[] {
    const listed: ListedPlaywrightTest[] = [];
    walkPlaywrightReport(report, ({ suitePath, spec }) => {
        listed.push({
            title: spec.title,
            suite: suitePath,
            ...(typeof spec.file === "string" && spec.file ? { file: spec.file } : {}),
            ...(typeof spec.line === "number" ? { line: spec.line } : {}),
        });
    });
    return listed;
}

function extractSelectorFromError(errorText: string): string | undefined {
    const patterns = [
        /locator\(['"](.+?)['"]\)/,
        /selector ['"](.+?)['"]/,
        /element ['"](.+?)['"]/,
        /getByRole\(['"](.+?)['"]/,
        /getByTestId\(['"](.+?)['"]/,
        /getByText\(['"](.+?)['"]/,
        /\[data-testid=['"](.+?)['"]\]/,
    ];
    for (const pattern of patterns) {
        const match = errorText.match(pattern);
        if (match) return match[1];
    }
    return undefined;
}

/** Map one walked spec into a {@link TestRunResult}, or null when no attempts exist. */
export function mapSpecToTestRunResult(
    entry: WalkedPlaywrightSpec,
    testFile: string,
    fallbackDuration: number,
): TestRunResult | null {
    const summary = summarizeSpecAttempts(entry.spec);
    if (!summary) return null;

    const testResult: TestRunResult = {
        testFile,
        testName: entry.spec.title,
        suite: entry.suitePath || testFile,
        status: summary.status,
        duration: summary.duration || fallbackDuration,
    };

    if (isFailureStatus(summary.status) && summary.error) {
        testResult.error = {
            message: summary.error.message || "Unknown error",
            stack: summary.error.stack,
            snippet: summary.error.snippet,
            location: summary.error.location,
            selector: extractSelectorFromError(summary.error.message || "") || undefined,
        };
    }

    if (summary.attachments?.length) {
        testResult.attachments = summary.attachments.map((att) => ({
            name: att.name ?? "",
            contentType: att.contentType ?? "",
            path: att.path,
            body: att.body,
        }));
    }

    return testResult;
}

/** Suite label for reporter-level failures that never became a spec. */
export const BUILD_ERROR_SUITE = "Build errors";

function reportErrorLocation(
    location: PlaywrightJsonReport["errors"] extends Array<infer E>
        ? E extends { location?: infer L }
            ? L
            : never
        : never,
): { file: string; line: number; column: number } | undefined {
    if (
        location &&
        typeof (location as { file?: unknown }).file === "string" &&
        typeof (location as { line?: unknown }).line === "number" &&
        typeof (location as { column?: unknown }).column === "number"
    ) {
        return location as { file: string; line: number; column: number };
    }
    return undefined;
}

/**
 * Reporter-level failures (compile errors, global setup crashes) as result rows.
 *
 * Playwright reports these in `errors` rather than under `suites`, so a walker
 * that only visits specs reports a run that never compiled as a clean pass.
 */
function mapReportErrorsToTestRunResults(
    report: PlaywrightJsonReport,
    testFile: string,
): TestRunResult[] {
    return (report.errors ?? []).map((err) => {
        const location = reportErrorLocation(err.location as never);
        const fileName = location?.file.split(/[\\/]/).pop();
        return {
            testFile,
            testName: fileName ? `Compilation error in ${fileName}` : "Compilation error",
            suite: BUILD_ERROR_SUITE,
            status: "error" as const,
            duration: 0,
            error: {
                message: err.message || "Unknown error",
                snippet: err.snippet,
                location,
            },
        };
    });
}

/** Parse stdout/json into merged {@link TestRunResult} rows with flaky semantics. */
export function mapReportToTestRunResults(
    report: PlaywrightJsonReport,
    testFile: string,
    fallbackDuration = 0,
): TestRunResult[] {
    const results: TestRunResult[] = [];
    walkPlaywrightReport(report, (entry) => {
        const mapped = mapSpecToTestRunResult(entry, testFile, fallbackDuration);
        if (mapped) results.push(mapped);
    });
    // Appended after merging so two identical build errors stay two rows.
    return [
        ...mergeRepetitionResults(results),
        ...mapReportErrorsToTestRunResults(report, testFile),
    ];
}

/** Adapt flat {@link TestRunResult} rows into {@link ParsedPlaywrightRun}. */
export function mapTestRunResultsToParsedRun(
    results: TestRunResult[],
    report?: PlaywrightJsonReport,
): ParsedPlaywrightRun {
    const tests: ReportTestCase[] = results.map((t, index) => {
        const status: ReportTestCase["status"] =
            t.status === "passed" ? "passed" : t.status === "skipped" ? "skipped" : "failed";
        const testCase: ReportTestCase = {
            id: `${t.testFile}#${index}`,
            name: t.testName,
            suite: t.suite ?? t.testFile,
            status,
            duration: t.duration,
        };
        if (t.error) {
            testCase.error = {
                message: t.error.selector
                    ? `${t.error.message}\n\nFailing selector: ${t.error.selector}`
                    : t.error.message,
                snippet: t.error.snippet,
                location: t.error.location,
            };
        }
        if (t.attachments?.length) {
            testCase.attachments = t.attachments;
        }
        return testCase;
    });

    const suiteNames = new Set(tests.map((t) => t.suite));
    const passed = tests.filter((t) => t.status === "passed").length;
    const failed = tests.filter((t) => t.status === "failed").length;

    const summary: ParsedPlaywrightRun["summary"] = {
        suites: {
            total: suiteNames.size,
            failed: failed > 0 ? 1 : 0,
            passed: failed > 0 ? Math.max(0, suiteNames.size - 1) : suiteNames.size,
        },
        tests: {
            passed,
            failed,
            total: tests.length,
        },
        timeSeconds: (report?.stats?.duration ?? 0) / 1000,
    };

    if (report?.stats) {
        summary.reporter = {
            expected: report.stats.expected ?? 0,
            unexpected: report.stats.unexpected ?? 0,
            skipped: report.stats.skipped ?? 0,
            durationMs: report.stats.duration ?? 0,
        };
    }

    return {
        tests,
        summary,
    };
}

/** Parse a Playwright JSON report object into {@link ParsedPlaywrightRun}. */
export function parsePlaywrightJsonReport(
    json: unknown,
    testFile = "unknown",
): ParsedPlaywrightRun {
    if (!json || typeof json !== "object") {
        return {
            tests: [],
            summary: {
                suites: { passed: 0, failed: 0, total: 0 },
                tests: { passed: 0, failed: 0, total: 0 },
                timeSeconds: 0,
            },
        };
    }

    const report = json as PlaywrightJsonReport;
    try {
        const runResults = mapReportToTestRunResults(report, testFile);
        return mapTestRunResultsToParsedRun(runResults, report);
    } catch {
        return {
            tests: [],
            summary: {
                suites: { passed: 0, failed: 0, total: 0 },
                tests: { passed: 0, failed: 0, total: 0 },
                timeSeconds: 0,
            },
        };
    }
}
