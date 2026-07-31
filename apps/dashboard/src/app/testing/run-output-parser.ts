import { emptySummary } from "./constants";
import type {
    DashboardRunResult,
    RunDisposition,
    ServerParsedRun,
    TestResult,
    TestSummary,
} from "./types";

export function classifyRunResult(result: DashboardRunResult): RunDisposition {
    if (result.busy) return "busy";
    if (result.cancelled) return "cancelled";
    return result.success ? "passed" : "failed";
}

export function shouldAutoBuildGraph(
    stats: { totalFiles: number } | null | undefined,
    attempted: boolean,
    isBuilding: boolean,
): boolean {
    if (stats === undefined || attempted || isBuilding) return false;
    return stats === null || stats.totalFiles === 0;
}

// The server-side canonical parser (`parsePlaywrightReport` in
// `libs/core/src/testing/report-parser.ts`, also used by `generateTestReport`
// and `raiken report`) already walks the raw Playwright JSON for us — the
// `runTests` mutation returns its output as `parsedRun`. This is a thin
// reshape from that shape into the dashboard's local render types (just a
// `timeSeconds` → `time` rename; everything else lines up field-for-field),
// so suite-walking/retry-aggregation logic lives in exactly one place instead
// of being duplicated here.
export function fromServerParsedRun(run: ServerParsedRun): {
    results: TestResult[];
    summary: TestSummary;
} {
    return {
        results: run.tests.map((t) => ({
            id: t.id,
            name: t.name,
            suite: t.suite,
            status: t.status,
            duration: t.duration,
            error: t.error,
            attachments: t.attachments,
        })),
        summary: {
            suites: run.summary.suites,
            tests: run.summary.tests,
            time: run.summary.timeSeconds,
        },
    };
}

// Fallback ONLY for when the server couldn't produce a JSON report at all
// (e.g. a crash before the Playwright reporter emitted anything) — scrapes
// Playwright's human-readable console output line-by-line. This is
// intentionally dumb text scraping, not a reimplementation of the JSON
// suite-walker above, so it isn't "the second parser" the unification
// removed.
export function parseTextOutput(output: string): { results: TestResult[]; summary: TestSummary } {
    const results: TestResult[] = [];
    const summary = {
        suites: { ...emptySummary.suites },
        tests: { ...emptySummary.tests },
        time: emptySummary.time,
    };

    const lines = output.split("\n");
    let currentSuite = "Tests";
    let testId = 0;

    for (const line of lines) {
        const suiteMatch = line.match(/^\s*(?:›|>)\s*(.+?)(?:\s*›|$)/);
        if (suiteMatch) {
            currentSuite = suiteMatch[1].trim();
        }

        const passedMatch = line.match(/[✓✔√]\s+(.+?)(?:\s+\((\d+(?:\.\d+)?)\s*m?s\))?$/);
        if (passedMatch) {
            testId++;
            results.push({
                id: String(testId),
                name: passedMatch[1].trim(),
                suite: currentSuite,
                status: "passed",
                duration: passedMatch[2] ? parseInt(passedMatch[2], 10) : undefined,
            });
        }

        const failedMatch = line.match(/[✗✕×]\s+(.+?)(?:\s+\((\d+(?:\.\d+)?)\s*m?s\))?$/);
        if (failedMatch) {
            testId++;
            results.push({
                id: String(testId),
                name: failedMatch[1].trim(),
                suite: currentSuite,
                status: "failed",
                duration: failedMatch[2] ? parseInt(failedMatch[2], 10) : undefined,
            });
        }

        const passedCount = line.match(/(\d+)\s+passed/);
        const failedCount = line.match(/(\d+)\s+failed/);
        const timeMatch = line.match(/(\d+(?:\.\d+)?)\s*s(?:econds?)?/);

        if (passedCount) summary.tests.passed = parseInt(passedCount[1], 10);
        if (failedCount) summary.tests.failed = parseInt(failedCount[1], 10);
        if (timeMatch) summary.time = parseFloat(timeMatch[1]);
    }

    summary.tests.total = results.length;
    summary.suites.total = new Set(results.map((r) => r.suite)).size;
    summary.suites.passed = summary.tests.failed === 0 ? summary.suites.total : 0;
    summary.suites.failed = summary.tests.failed > 0 ? 1 : 0;

    return { results, summary };
}

export function parseRunOutput(result: {
    stdout?: string;
    stderr?: string;
    parsedRun?: ServerParsedRun | null;
}): { results: TestResult[]; summary: TestSummary; output: string } {
    const output = result.stdout || result.stderr || "";
    const parsed = result.parsedRun
        ? fromServerParsedRun(result.parsedRun)
        : parseTextOutput(output);
    return { ...parsed, output };
}
