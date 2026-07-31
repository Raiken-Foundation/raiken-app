/**
 * UI-agnostic Playwright report model shared by parsers, result adapters,
 * report writers, and dashboard-facing application services.
 *
 * Keep this module type-only so the report-processing dependency graph points
 * toward one leaf contract instead of coupling model types back to parsers.
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
    /** Total wall-clock seconds (from walked run duration or reporter stats). */
    timeSeconds: number;
    /**
     * Raw Playwright JSON reporter `stats`, when present. Dashboard counts in
     * {@link ReportSummary.tests} are derived from walked/merged specs and are
     * authoritative for flaky/repeat semantics — they may differ from
     * `reporter.expected` / `reporter.unexpected` when repetitions collapse.
     */
    reporter?: {
        expected: number;
        unexpected: number;
        skipped: number;
        durationMs: number;
    };
}

export interface ParsedPlaywrightRun {
    tests: ReportTestCase[];
    summary: ReportSummary;
}
