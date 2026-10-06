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
import { recordRunOutcomes } from "../testing/record-outcomes";
import { parseCiRunReport } from "../testing/report-parser";
import { writeTestRunReport } from "../testing/report-writer";
import { summarizeTestRunCounts } from "../testing/run-outcome";
import { TestRunner, type TestRunResult } from "../testing/runner";
import {
    filterSourceFiles,
    GitError,
    getChangedFiles,
    getStagedFiles,
    resolveRefs,
} from "./git-diff";
import { renderJUnitXml } from "./junit-reporter";
import { directlyChangedTests, selectAffectedTests } from "./select-tests";
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

    // ---- 2. Impact: evidence-backed selection that fails safe to the full suite
    const { affectedTests, skippedBelowThreshold, selection } = await selectAffectedTests({
        projectPath,
        changedFiles,
        confidenceThreshold: threshold,
        fallback: options.fallback,
    });

    const impact: CiImpactReport = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        refs,
        changedFiles,
        consideredSourceFiles,
        affectedTests,
        skippedBelowThreshold,
        confidenceThreshold: threshold,
        selection,
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
            recordRunOutcomes(
                projectPath,
                results.flatMap((result) => {
                    if (result.status === "skipped") return [];
                    const status =
                        result.status === "flaky" || result.status === "passed"
                            ? ("passed" as const)
                            : result.status;
                    return [
                        {
                            testFile: result.testFile,
                            testName: result.testName,
                            status,
                            ...(typeof result.duration === "number"
                                ? { durationMs: result.duration }
                                : {}),
                            ...(result.error?.message
                                ? { errorMessage: result.error.message }
                                : {}),
                        },
                    ];
                }),
            );
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
        summary: summarizeTestRunCounts(allResults),
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

/** @deprecated kept for callers of the old name; see `directlyChangedTests`. */
export const directlyChangedTestEntries = directlyChangedTests;
