export interface TestAttachment {
    name: string;
    contentType: string;
    path?: string;
    body?: string;
}

/** Playwright outcome vocabulary for pure UI adapters (includes transport extensions). */
export type PlaywrightOutcomeStatus = "passed" | "failed" | "skipped" | "flaky" | "timeout";

export interface TestResult {
    id: string;
    name: string;
    suite: string;
    status: "passed" | "failed" | "skipped";
    duration?: number;
    error?: {
        expected?: string;
        received?: string;
        message?: string;
        snippet?: string;
        location?: {
            file: string;
            line: number;
            column: number;
        };
    };
    attachments?: TestAttachment[];
}

export interface TestSummary {
    suites: {
        passed: number;
        failed: number;
        total: number;
    };
    tests: {
        passed: number;
        failed: number;
        total: number;
    };
    time: number;
}

export type TestResultsViewMode = "formatted" | "artifacts" | "raw" | "insights";

export interface TestResultsProps {
    results: TestResult[];
    summary: TestSummary;
    filePath?: string;
    isRunning?: boolean;
    rawOutput?: string;
    /**
     * Snapshot of the test file that was actually run, captured by the
     * parent at run-time. Used only to gate the "Analyze with AI" button
     * (we don't show the analyze button until we have something to send).
     * The parent owns the full request payload — see
     * `handleRequestInterpretation` in `testing-view.tsx` for what
     * additional evidence (rawOutput, attachments, testFilePath) is sent
     * alongside it.
     */
    testCode?: string;
    /**
     * Fired when the user clicks "Analyze with AI". The parent has the
     * full context (snapshotted testCode, rawOutput, attachments) and
     * forwards everything to the interpreter — this component just
     * provides the trigger and the result viewport.
     */
    onRequestInterpretation?: (results: TestResult[]) => void;
    interpretation?: string;
    /**
     * Where the test code in the analysis came from. Surfaced as a small
     * dim banner above the AI output so the user knows whether the
     * diagnosis was grounded in the freshest on-disk file or in a
     * (potentially stale) in-memory snapshot.
     *  - `disk`                     — server read the file at testFilePath
     *  - `client-snapshot`          — no path (e.g. scratch buffer); used the snapshot
     *  - `client-snapshot-fallback` — disk read failed; fell back to the snapshot
     */
    interpretationSource?: "disk" | "client-snapshot" | "client-snapshot-fallback" | null;
    isInterpreting?: boolean;
    /**
     * Fired when the user clicks "Fix test". The parent generates a corrected
     * spec (grounded in the same evidence as the analysis, plus the analysis
     * text itself) and drops it into the editor for review/run/save. This is
     * the actionable other half of "Analyze with AI".
     */
    onRequestFix?: (results: TestResult[]) => void;
    isFixing?: boolean;
    /** Inline error surfaced when a fix request fails (replaces window.alert). */
    fixError?: string | null;
    /**
     * Fired when the user clicks "Export report". The parent writes a detailed
     * report (HTML with embedded screenshots, plus whichever other formats
     * are passed) from the last run and returns the saved path via
     * `exportedReportPath`.
     */
    onExportReport?: (formats: Array<"html" | "markdown" | "json">) => void;
    /**
     * Whether the last run produced a real JSON report to export from. When
     * false (a text-scrape-only fallback happened, e.g. a crash before the
     * Playwright reporter emitted), the Export button is disabled rather
     * than sending a request the server can't fulfill.
     */
    canExportReport?: boolean;
    isExporting?: boolean;
    exportedReportPath?: string | null;
}

export interface SuiteTreeNode {
    name: string;
    path: string;
    children: SuiteTreeNode[];
    tests: TestResult[];
}

export interface CategorizedArtifact extends TestAttachment {
    testName: string;
    testStatus: TestResult["status"];
}

export interface CategorizedArtifacts {
    all: CategorizedArtifact[];
    screenshots: CategorizedArtifact[];
    videos: CategorizedArtifact[];
    traces: CategorizedArtifact[];
    other: CategorizedArtifact[];
}
