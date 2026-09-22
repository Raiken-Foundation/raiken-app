/**
 * `raiken ci` command — P0-1a.
 *
 * Headless entry point used locally and on CI. Resolves a base/head diff,
 * asks the core graph which tests are affected, runs them via Playwright,
 * and emits JUnit XML + JSON reports.
 *
 * Intended to be called by the upcoming GitHub Action (P0-1b), but works
 * standalone from any shell.
 */

import { type CiEvent, type CiResult, GitError, runCi } from "@raiken/core";
import chalk from "chalk";
import { CLI_EXIT, mapErrorToCliExitCode, safeCliErrorMessage } from "../errors";
import { cliExit } from "../cli/exit";

interface CiCommandOptions {
    base?: string;
    head?: string;
    outputDir?: string;
    format?: string;
    confidence?: string;
    maxTests?: string;
    timeout?: string;
    skipRun?: boolean;
    staged?: boolean;
    json?: boolean;
}

const parsePositiveInt = (
    value: string | undefined,
    fallback: number | undefined,
): number | undefined => {
    if (value === undefined) return fallback;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const parseConfidence = (value: string | undefined, fallback: number): number => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
};

const parseFormat = (value: string | undefined): "junit" | "json" | "both" => {
    const normalised = (value ?? "both").toLowerCase();
    if (normalised === "junit" || normalised === "json" || normalised === "both") {
        return normalised;
    }
    console.warn(chalk.yellow(`Unknown --format "${value}", falling back to "both".`));
    return "both";
};

export async function ciCommand(options: CiCommandOptions): Promise<void> {
    const projectPath = process.cwd();

    const format = parseFormat(options.format);
    const confidenceThreshold = parseConfidence(options.confidence, 0.5);
    const maxTests = parsePositiveInt(options.maxTests, undefined);
    const testTimeout = parsePositiveInt(options.timeout, 60_000) ?? 60_000;
    const jsonOutput = options.json === true;

    if (!jsonOutput) {
        console.log(chalk.cyan("\nraiken ci\n"));
    }

    let result: CiResult;
    try {
        result = await runCi({
            projectPath,
            base: options.base,
            head: options.head,
            outputDir: options.outputDir,
            format,
            confidenceThreshold,
            maxTests,
            testTimeout,
            skipRun: options.skipRun === true,
            staged: options.staged === true,
            onEvent: jsonOutput ? undefined : (event) => logEvent(event),
        });
    } catch (err) {
        // A GitError means the supplied --base/--head refs are unusable, which
        // is a usage problem. Anything else is a genuine run failure and must
        // map through the shared policy (timeout → 124, cancelled → 130, …)
        // instead of masquerading as bad arguments.
        if (err instanceof GitError) {
            console.error(chalk.red(`\n✗ ${safeCliErrorMessage(err)}`));
            cliExit(CLI_EXIT.USAGE);
        }
        console.error(chalk.red("\n✗ raiken ci failed:"), safeCliErrorMessage(err));
        cliExit(mapErrorToCliExitCode(err));
    }

    if (jsonOutput) {
        process.stdout.write(`${JSON.stringify(toMachineSummary(result), null, 2)}\n`);
    } else {
        printHumanSummary(result);
    }

    cliExit(result.exitCode);
}

// =========================================================================
// Event logging (human-readable)
// =========================================================================

function logEvent(event: CiEvent): void {
    switch (event.type) {
        case "refs_resolved": {
            const { base, baseSha, head, headSha } = event.refs;
            if (head === "STAGED") {
                console.log(chalk.dim("  mode: staged index (HEAD → STAGED)"));
            } else {
                console.log(
                    chalk.dim(
                        `  refs: ${base} (${baseSha.slice(0, 7)}) → ${head} (${headSha.slice(0, 7)})`,
                    ),
                );
            }
            break;
        }
        case "diff_complete":
            console.log(chalk.dim(`  diff: ${event.changedFiles.length} changed file(s)`));
            break;
        case "impact_complete":
            if (event.affectedTests.length === 0) {
                console.log(chalk.dim("  impact: no affected tests"));
            } else {
                console.log(
                    chalk.dim(`  impact: ${event.affectedTests.length} affected test file(s)`),
                );
            }
            break;
        case "test_started":
            console.log(
                chalk.dim(`  [${event.index}/${event.total}] running ${event.testFile}...`),
            );
            break;
        case "test_finished": {
            const fails = event.results.filter(
                (r) => r.status === "failed" || r.status === "timeout" || r.status === "error",
            ).length;
            const mark = fails === 0 ? chalk.green("✓") : chalk.red("✗");
            console.log(
                chalk.dim(
                    `    ${mark} ${event.testFile} — ${event.results.length} test(s), ${fails} failure(s)`,
                ),
            );
            break;
        }
        case "reports_written":
            for (const file of event.files) {
                console.log(chalk.dim(`  wrote ${file}`));
            }
            break;
    }
}

// =========================================================================
// Summaries
// =========================================================================

function printHumanSummary(result: CiResult): void {
    const { impact, run } = result;
    console.log();
    console.log(chalk.cyan("Summary"));
    console.log(chalk.dim("─".repeat(50)));

    console.log(`  ${chalk.bold("Changed files:")}     ${impact.changedFiles.length}`);
    console.log(
        `  ${chalk.bold("Affected tests:")}    ${impact.affectedTests.length}` +
            (impact.skippedBelowThreshold.length > 0
                ? chalk.dim(
                      `  (${impact.skippedBelowThreshold.length} below ${impact.confidenceThreshold} confidence)`,
                  )
                : ""),
    );

    if (run.ran) {
        const parts: string[] = [];
        parts.push(`${chalk.green(run.summary.passed)} passed`);
        if (run.summary.failed > 0) parts.push(`${chalk.red(run.summary.failed)} failed`);
        if (run.summary.timedOut > 0) parts.push(`${chalk.red(run.summary.timedOut)} timed out`);
        if (run.summary.errored > 0) parts.push(`${chalk.red(run.summary.errored)} errored`);
        console.log(
            `  ${chalk.bold("Test run:")}          ${parts.join(", ")}  ${chalk.dim(`(${formatDuration(run.durationMs)})`)}`,
        );
    } else {
        console.log(`  ${chalk.bold("Test run:")}          ${chalk.dim("skipped")}`);
    }

    console.log();
    if (result.exitCode === 0) {
        console.log(chalk.green("✓ raiken ci: clean"));
    } else {
        console.log(chalk.red("✗ raiken ci: failures detected"));
    }
}

function toMachineSummary(result: CiResult) {
    return {
        exitCode: result.exitCode,
        refs: result.impact.refs,
        changedFilesCount: result.impact.changedFiles.length,
        affectedTestCount: result.impact.affectedTests.length,
        skippedBelowThreshold: result.impact.skippedBelowThreshold.length,
        confidenceThreshold: result.impact.confidenceThreshold,
        run: {
            ran: result.run.ran,
            durationMs: result.run.durationMs,
            ...result.run.summary,
        },
        reportFiles: result.reportFiles,
    };
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const mins = Math.floor(seconds / 60);
    const rem = seconds - mins * 60;
    return `${mins}m ${rem.toFixed(0)}s`;
}
