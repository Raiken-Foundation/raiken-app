/**
 * `raiken ci` orchestrator.
 *
 *   diff → impact → run → report
 *
 * All I/O lives here; the reporters and git helpers are pure-ish and easy
 * to unit test in isolation. The CLI command is a thin wrapper over this
 * function.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type AffectedTestEvidence, GraphQueryService } from "../analysis/graph-query";
import { parseCiRunReport } from "../testing/report-parser";
import { writeTestRunReport } from "../testing/report-writer";
import { TestRunner, type TestRunResult } from "../testing/runner";
import {
    filterSourceFiles,
    GitError,
    getChangedFiles,
    getStagedFiles,
    resolveRefs,
} from "./git-diff";
import { renderJUnitXml } from "./junit-reporter";
import type {
    CiAffectedTest,
    CiEvent,
    CiImpactReport,
    CiOptions,
    CiResult,
    CiRunReport,
    ResolvedRefs,
} from "./types";

const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
const DEFAULT_TEST_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_DIR = ".raiken/ci";

export async function runCi(options: CiOptions): Promise<CiResult> {
    const projectPath = path.resolve(options.projectPath);
    const format = options.format ?? "both";
    const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    const outputDir = path.resolve(projectPath, options.outputDir ?? DEFAULT_OUTPUT_DIR);
    const timeout = options.testTimeout ?? DEFAULT_TEST_TIMEOUT_MS;
    const emit = options.onEvent ?? (() => {});

    // ---- 1. Resolve refs + diff
    // `--staged` short-circuits the ref resolution: we analyse the index
    // against HEAD and synthesise a refs object with empty SHAs so reports
    // still have a stable shape. This is what `raiken ci --staged` uses in
    // pre-commit hooks, where the "head" commit doesn't exist yet.
    let refs: ResolvedRefs;
    let changedFiles: ReturnType<typeof getChangedFiles>;
    if (options.staged) {
        refs = {
            base: "HEAD",
            baseSha: "",
            head: "STAGED",
            headSha: "",
        };
        emit({ type: "refs_resolved", refs });
        changedFiles = getStagedFiles(projectPath);
    } else {
        refs = resolveRefs(projectPath, options.base, options.head);
        emit({ type: "refs_resolved", refs });
        changedFiles = getChangedFiles(projectPath, refs);
    }
    emit({ type: "diff_complete", changedFiles });

    const consideredSourceFiles = filterSourceFiles(changedFiles);

    // ---- 2. Impact (graph query)
    const query = new GraphQueryService(projectPath);
    const evidence = query.getAffectedTests(consideredSourceFiles);

    // Collapse per-(testFile,sourceFile) evidence into per-testFile rows.
    const byTestFile = new Map<string, AffectedTestEvidence[]>();
    for (const row of evidence) {
        const list = byTestFile.get(row.testFile) ?? [];
        list.push(row);
        byTestFile.set(row.testFile, list);
    }

    const affectedTests: CiAffectedTest[] = [];
    const skippedBelowThreshold: Array<{ testFile: string; confidence: number }> = [];

    for (const [testFile, rows] of byTestFile) {
        const confidence = rows.reduce((acc, r) => Math.max(acc, r.confidence), 0);
        const sourceFiles = Array.from(new Set(rows.map((r) => r.sourceFile)));
        const reasons = rows.flatMap((r) =>
            r.reasons.map((reason) => ({
                reason: reason.reason,
                provenance: reason.provenance as CiAffectedTest["reasons"][number]["provenance"],
                confidence: reason.confidence,
                sourceFile: r.sourceFile,
                sourceSymbol: reason.sourceSymbol,
                targetSymbol: reason.targetSymbol,
                line: reason.line,
                snippet: reason.snippet,
            })),
        );

        if (confidence < threshold) {
            skippedBelowThreshold.push({ testFile, confidence });
            continue;
        }
        affectedTests.push({ testFile, confidence, sourceFiles, reasons });
    }

    // Highest-confidence first, then alphabetical for stable ordering.
    affectedTests.sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return a.testFile.localeCompare(b.testFile);
    });
    skippedBelowThreshold.sort((a, b) => a.testFile.localeCompare(b.testFile));

    const impact: CiImpactReport = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        refs,
        changedFiles,
        consideredSourceFiles,
        affectedTests,
        skippedBelowThreshold,
        confidenceThreshold: threshold,
    };

    emit({ type: "impact_complete", affectedTests });

    // ---- 3. Run tests (unless skipped)
    const run = options.skipRun
        ? emptyRunReport()
        : await runAffectedTests(projectPath, affectedTests, {
              maxTests: options.maxTests,
              timeout,
              emit,
          });

    // ---- 4. Write reports
    const reportFiles = await writeReports(projectPath, outputDir, format, impact, run);
    emit({ type: "reports_written", files: reportFiles });

    // ---- 5. Exit code
    const exitCode: CiResult["exitCode"] =
        run.summary.failed + run.summary.timedOut + run.summary.errored > 0 ? 1 : 0;

    return { impact, run, reportFiles, exitCode };
}

async function runAffectedTests(
    projectPath: string,
    affected: CiAffectedTest[],
    opts: { maxTests?: number; timeout: number; emit: (e: CiEvent) => void },
): Promise<CiRunReport> {
    const capped = opts.maxTests ? affected.slice(0, opts.maxTests) : affected;
    const runner = new TestRunner(projectPath);
    const started = Date.now();
    const startedAt = new Date(started).toISOString();

    const allResults: TestRunResult[] = [];

    for (let i = 0; i < capped.length; i++) {
        const t = capped[i];
        opts.emit({
            type: "test_started",
            testFile: t.testFile,
            index: i + 1,
            total: capped.length,
        });
        try {
            const results = await runner.runTest(t.testFile, { timeout: opts.timeout });
            allResults.push(...results);
            opts.emit({ type: "test_finished", testFile: t.testFile, results });
        } catch (err) {
            const errorResult: TestRunResult = {
                testFile: t.testFile,
                testName: "unknown",
                status: "error",
                duration: 0,
                error: { message: err instanceof Error ? err.message : String(err) },
            };
            allResults.push(errorResult);
            opts.emit({ type: "test_finished", testFile: t.testFile, results: [errorResult] });
        }
    }

    const finished = Date.now();
    return {
        schemaVersion: 1,
        ran: true,
        startedAt,
        finishedAt: new Date(finished).toISOString(),
        durationMs: finished - started,
        tests: allResults,
        summary: summariseResults(allResults),
    };
}

function emptyRunReport(): CiRunReport {
    const now = new Date().toISOString();
    return {
        schemaVersion: 1,
        ran: false,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        tests: [],
        summary: { total: 0, passed: 0, failed: 0, timedOut: 0, errored: 0 },
    };
}

function summariseResults(results: TestRunResult[]): CiRunReport["summary"] {
    const summary = { total: results.length, passed: 0, failed: 0, timedOut: 0, errored: 0 };
    for (const r of results) {
        if (r.status === "passed") summary.passed++;
        // A flaky result is a failure for CI purposes: it did not pass every
        // attempt, so the suite cannot be called green.
        else if (r.status === "failed" || r.status === "flaky") summary.failed++;
        else if (r.status === "timeout") summary.timedOut++;
        else summary.errored++;
    }
    return summary;
}

async function writeReports(
    projectPath: string,
    outputDir: string,
    format: CiOptions["format"],
    impact: CiImpactReport,
    run: CiRunReport,
): Promise<string[]> {
    fs.mkdirSync(outputDir, { recursive: true });
    const written: string[] = [];

    const wantJson = format === "json" || format === "both" || format === undefined;
    const wantJUnit = format === "junit" || format === "both" || format === undefined;

    if (wantJson) {
        const impactPath = path.join(outputDir, "impact.json");
        fs.writeFileSync(impactPath, `${JSON.stringify(impact, null, 2)}\n`, "utf-8");
        written.push(impactPath);

        const resultsPath = path.join(outputDir, "results.json");
        fs.writeFileSync(resultsPath, `${JSON.stringify(run, null, 2)}\n`, "utf-8");
        written.push(resultsPath);
    }

    if (wantJUnit) {
        const junitPath = path.join(outputDir, "results.xml");
        fs.writeFileSync(junitPath, renderJUnitXml(run), "utf-8");
        written.push(junitPath);
    }

    // Give CI runs the same shareable HTML/Markdown report `raiken report`
    // produces — previously CI attachments (screenshots) were captured on
    // `TestRunResult` but never made it into anything a human could open.
    if (run.ran && run.tests.length > 0) {
        try {
            const parsedRun = parseCiRunReport(run);
            const outputDirRel = path.relative(projectPath, outputDir) || ".";
            const htmlWritten = await writeTestRunReport({
                projectPath,
                run: parsedRun,
                title: "Raiken CI Report",
                formats: ["html", "markdown"],
                outputDir: outputDirRel,
            });
            written.push(...htmlWritten.files);
        } catch (err) {
            // Best-effort — a report-writer failure shouldn't fail the whole
            // CI run when JUnit/JSON (the machine-readable, CI-critical
            // outputs) already wrote successfully above.
            console.warn(
                `raiken ci: failed to write HTML/Markdown report: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }

    return written;
}

export { GitError };
