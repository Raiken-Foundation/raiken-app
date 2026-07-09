/**
 * Parse Playwright's JSON reporter payload into a typed, UI-agnostic run model.
 *
 * This is the single source of truth shared by the dashboard, the CLI, and the
 * report writer. It intentionally preserves attachments (screenshots, videos,
 * traces) and error snippets/locations so downstream consumers can build a
 * detailed report without re-walking the raw reporter shape.
 */

export interface ReportAttachment {
    name: string;
    contentType: string;
    /** Absolute or project-relative path on disk (Playwright writes to test-results/). */
    path?: string;
    /** Inline base64 body, when Playwright embeds the attachment rather than a path. */
    body?: string;
}

export interface ReportErrorLocation {
    file: string;
    line: number;
    column: number;
}

export interface ReportError {
    message?: string;
    /** Source snippet Playwright captured around the failing line. */
    snippet?: string;
    location?: ReportErrorLocation;
}

export interface ReportTestCase {
    id: string;
    name: string;
    suite: string;
    status: "passed" | "failed" | "skipped";
    /** Milliseconds. */
    duration?: number;
    error?: ReportError;
    attachments?: ReportAttachment[];
}

export interface ReportSummary {
    suites: { passed: number; failed: number; total: number };
    tests: { passed: number; failed: number; total: number };
    /** Total wall-clock seconds. */
    timeSeconds: number;
}

export interface ParsedPlaywrightRun {
    tests: ReportTestCase[];
    summary: ReportSummary;
}

// Narrow structural views of the (untyped) Playwright reporter JSON. We only
// pin the fields we read; everything else is ignored.
interface RawAttachment {
    name?: string;
    contentType?: string;
    path?: string;
    body?: string;
}
interface RawError {
    message?: string;
    snippet?: string;
    location?: ReportErrorLocation;
}
interface RawResult {
    status?: string;
    duration?: number;
    error?: RawError;
    attachments?: RawAttachment[];
}
interface RawTest {
    results?: RawResult[];
}
interface RawSpec {
    id?: string;
    title?: string;
    tests?: RawTest[];
}
interface RawSuite {
    title?: string;
    specs?: RawSpec[];
    suites?: RawSuite[];
}
interface RawReport {
    stats?: { expected?: number; unexpected?: number; skipped?: number; duration?: number };
    suites?: RawSuite[];
    errors?: Array<{ message?: string; snippet?: string; location?: ReportErrorLocation }>;
}

function emptySummary(): ReportSummary {
    return {
        suites: { passed: 0, failed: 0, total: 0 },
        tests: { passed: 0, failed: 0, total: 0 },
        timeSeconds: 0,
    };
}

/**
 * Convert a parsed Playwright JSON report object into a {@link ParsedPlaywrightRun}.
 * Fails soft: on a malformed payload it returns whatever was parsed so far.
 */
export function parsePlaywrightReport(json: unknown): ParsedPlaywrightRun {
    const tests: ReportTestCase[] = [];
    const summary = emptySummary();

    if (!json || typeof json !== "object") return { tests, summary };
    const report = json as RawReport;

    try {
        if (report.stats) {
            summary.tests.passed = report.stats.expected || 0;
            summary.tests.failed = report.stats.unexpected || 0;
            summary.tests.total =
                summary.tests.passed + summary.tests.failed + (report.stats.skipped || 0);
            summary.timeSeconds = (report.stats.duration || 0) / 1000;
        }

        let testId = 0;
        const walk = (suites: RawSuite[], parentTitle = ""): void => {
            for (const suite of suites) {
                const suiteName = parentTitle
                    ? `${parentTitle} > ${suite.title ?? ""}`
                    : (suite.title ?? "");

                for (const spec of suite.specs ?? []) {
                    for (const test of spec.tests ?? []) {
                        // Use the FINAL attempt so a test that fails then passes
                        // on retry reads as passed — matching the runner.
                        const result = test.results?.[test.results.length - 1];
                        if (!result) continue;
                        testId++;

                        const status: ReportTestCase["status"] =
                            result.status === "passed"
                                ? "passed"
                                : result.status === "failed"
                                  ? "failed"
                                  : "skipped";

                        const testCase: ReportTestCase = {
                            id: spec.id || String(testId),
                            name: spec.title ?? `test ${testId}`,
                            suite: suiteName,
                            status,
                            duration: result.duration,
                        };

                        if (result.error) {
                            testCase.error = {
                                message: result.error.message,
                                snippet: result.error.snippet,
                                location: result.error.location,
                            };
                        }

                        if (result.attachments && result.attachments.length > 0) {
                            testCase.attachments = result.attachments.map((att) => ({
                                name: att.name ?? "",
                                contentType: att.contentType ?? "",
                                path: att.path,
                                body: att.body,
                            }));
                        }

                        tests.push(testCase);
                    }
                }

                if (suite.suites) walk(suite.suites, suiteName);
            }
        };

        if (report.suites) walk(report.suites);

        // Top-level errors (compile failures, missing imports) surface as tests.
        if (Array.isArray(report.errors)) {
            for (const err of report.errors) {
                testId++;
                tests.push({
                    id: `error-${testId}`,
                    name: err.location
                        ? `Compilation error in ${err.location.file?.split("/").pop() || "unknown"}`
                        : "Compilation error",
                    suite: "Build errors",
                    status: "failed",
                    error: {
                        message: err.message,
                        snippet: err.snippet,
                        location: err.location,
                    },
                });
                summary.tests.failed++;
                summary.tests.total++;
            }
        }

        const suiteNames = new Set(tests.map((t) => t.suite));
        summary.suites.total = suiteNames.size;
        summary.suites.failed = summary.tests.failed > 0 ? 1 : 0;
        summary.suites.passed = summary.suites.total - summary.suites.failed;
    } catch {
        // Fail soft — return whatever we managed to parse.
    }

    return { tests, summary };
}
