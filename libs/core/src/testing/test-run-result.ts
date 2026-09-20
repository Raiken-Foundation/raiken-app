import type { ReportAttachment } from "./playwright-report-model";

/**
 * Result of running a single test.
 */
export interface TestRunResult {
    testFile: string;
    testName: string;
    /** Playwright project; repetitions retain this identity. */
    projectName?: string;
    /** Nested suite breadcrumb from the Playwright JSON reporter, when available. */
    suite?: string;
    /**
     * `"flaky"` means the same spec both passed and failed within one
     * invocation — across Playwright retries or `--repeat-each` repetitions.
     * It is deliberately NOT `"passed"`: every caller checks
     * `status === "passed"`, so an intermittent test can never be reported as
     * a green run or as a successful repair.
     */
    status: "passed" | "failed" | "error" | "timeout" | "skipped" | "flaky";
    duration: number;
    error?: {
        message: string;
        stack?: string;
        selector?: string;
        snippet?: string;
        location?: { file: string; line: number; column: number };
    };
    /**
     * Screenshots/videos/traces Playwright attached to this attempt. Carried
     * through so `raiken ci` results can feed the same report writer that
     * `raiken report` uses, without CI runs silently losing artifacts.
     */
    attachments?: ReportAttachment[];
}

export type RunOutcomeStatus = TestRunResult["status"];
