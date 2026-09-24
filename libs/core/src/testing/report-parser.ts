/**
 * Parse Playwright's JSON reporter payload into a typed, UI-agnostic run model.
 *
 * Raw traversal lives in `playwright-json-report.ts`; this module keeps the
 * dashboard/report-writer types and CI bridge adapters.
 */

import { mapTestRunResultsToParsedRun, parsePlaywrightJsonReport } from "./playwright-json-report";
import type { ParsedPlaywrightRun } from "./playwright-report-model";
import type { TestRunResult } from "./test-run-result";

export type {
    ParsedPlaywrightRun,
    ReportAttachment,
    ReportError,
    ReportErrorLocation,
    ReportSummary,
    ReportTestCase,
} from "./playwright-report-model";

/**
 * Convert a parsed Playwright JSON report object into a {@link ParsedPlaywrightRun}.
 * Fails soft: on a malformed payload it returns whatever was parsed so far.
 */
export function parsePlaywrightReport(json: unknown): ParsedPlaywrightRun {
    return parsePlaywrightJsonReport(json);
}

// ---------------------------------------------------------------------------
// CI run report bridge
// ---------------------------------------------------------------------------

export interface CiRunReportLike {
    tests: TestRunResult[];
    summary: { total: number; passed: number; failed: number; timedOut: number; errored: number };
    durationMs: number;
}

export function isCiRunReportShape(value: unknown): value is CiRunReportLike {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    if ("suites" in v) return false;
    if (!Array.isArray(v["tests"])) return false;
    const summary = v["summary"];
    return (
        typeof summary === "object" &&
        summary !== null &&
        "total" in (summary as Record<string, unknown>)
    );
}

export function parseCiRunReport(report: CiRunReportLike): ParsedPlaywrightRun {
    const parsed = mapTestRunResultsToParsedRun(report.tests);
    return {
        ...parsed,
        summary: {
            ...parsed.summary,
            tests: {
                passed: report.summary.passed,
                failed: report.summary.failed + report.summary.timedOut + report.summary.errored,
                total: report.summary.total,
            },
            timeSeconds: report.durationMs / 1000,
        },
    };
}
