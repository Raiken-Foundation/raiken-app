import * as path from "node:path";
import {
    createProjectApplication,
    runPlaywrightSubprocess,
    startTestWatcher,
    type TestExecutionInput,
} from "@raiken/core";
import chalk from "chalk";
import { dim, routeDiagnosticsToStderr } from "../agent-stream";
import { CLI_EXIT, exitUsage } from "../errors";
import { cliExit } from "../repl/exit";
import { type RepairRunResult, repairFailedRun } from "./repair";
import { partitionSuiteSpecs, quarantineSkipNotice } from "./run-scope";

interface TestOptions {
    json?: boolean;
    headed?: boolean;
    debug?: boolean;
    grep?: string;
    workers?: string;
    project?: string;
    retries?: string;
    updateSnapshots?: boolean;
    list?: boolean;
    watch?: boolean;
    onlyFlaky?: boolean;
    fix?: boolean;
    /** REPL-injected confirm prompt for --fix (inquirer can't run there). */
    confirm?: (message: string) => Promise<boolean>;
}

interface ParsedRunTestCase {
    name?: string;
    suite?: string;
    status?: string;
    duration?: number;
    error?: {
        message?: string;
        snippet?: string;
        location?: { file: string; line: number; column: number };
    };
    attachments?: Array<{ name: string; contentType?: string; path?: string }>;
}

interface ParsedRunSummary {
    /** Total wall-clock seconds for the run. */
    timeSeconds?: number;
    reporter?: { durationMs?: number };
}

interface RunTestsResult {
    success: boolean;
    stderr?: string;
    parsedRun?: { tests?: ParsedRunTestCase[]; summary?: ParsedRunSummary } | null;
    listedTests?: Array<{ title: string; suite: string; file?: string; line?: number }>;
}

export interface CliRunFailure {
    /** Test title, with the describe-suite prefixed when one exists. */
    name: string;
    file?: string;
    line?: number;
    durationMs?: number;
}

export interface CliRunSummary {
    passed: number;
    failed: number;
    skipped: number;
    /** Every failing test, named (capped — see FAILURE_LIST_LIMIT). */
    failures: CliRunFailure[];
    /** Wall-clock run time, when the report carried one. */
    durationMs?: number;
    /** First failing test's error message, when one exists. */
    error?: string;
}

const ERROR_LINE_LIMIT = 12;
const FAILURE_LIST_LIMIT = 10;

/**
 * Playwright nests suites as "<file> > <describe> > …" — when the file is
 * already shown as a header (or separately), the leading file segment is
 * stutter. Drop it for display.
 */
function stripFileSuitePrefix(suite: string, file?: string): string {
    if (!file) return suite;
    const fileName = file.split(/[\\/]/).pop() ?? file;
    return suite.startsWith(`${fileName} > `) ? suite.slice(fileName.length + 3) : suite;
}

function failureDisplayName(test: ParsedRunTestCase): string {
    const suite = test.suite ? stripFileSuitePrefix(test.suite, test.error?.location?.file) : "";
    return suite ? `${suite} › ${test.name ?? "(unnamed)"}` : (test.name ?? "(unnamed)");
}

/**
 * Summarize a run from its parsed test cases — the SAME source `raiken
 * report` uses. Previously this read the raw Playwright `stats` block, which
 * counts nothing when the run dies before executing specs (a broken
 * webServer, a compile error), while `report` maps those reporter-level
 * errors to failed rows — so the two commands told different truths about
 * the same run (0/0/0 here vs 1 failed there).
 */
export function summarizeRunForCli(
    parsedRun: RunTestsResult["parsedRun"],
    stderr?: string,
): CliRunSummary {
    const tests = parsedRun?.tests ?? [];
    const passed = tests.filter((t) => t.status === "passed").length;
    const failed = tests.filter((t) => t.status === "failed").length;
    const skipped = tests.filter((t) => t.status === "skipped").length;

    const failures: CliRunFailure[] = tests
        .filter((t) => t.status === "failed")
        .slice(0, FAILURE_LIST_LIMIT)
        .map((t) => ({
            name: failureDisplayName(t),
            ...(t.error?.location?.file ? { file: t.error.location.file } : {}),
            ...(t.error?.location?.line ? { line: t.error.location.line } : {}),
            ...(typeof t.duration === "number" ? { durationMs: t.duration } : {}),
        }));

    const timeSeconds = parsedRun?.summary?.timeSeconds;
    const reporterMs = parsedRun?.summary?.reporter?.durationMs;
    const durationMs =
        typeof reporterMs === "number"
            ? Math.round(reporterMs)
            : typeof timeSeconds === "number"
              ? Math.round(timeSeconds * 1000)
              : undefined;

    const base: CliRunSummary = {
        passed,
        failed,
        skipped,
        failures,
        ...(durationMs !== undefined ? { durationMs } : {}),
    };

    const firstMessage = tests
        .find((t) => t.status === "failed" && t.error?.message?.trim())
        ?.error?.message?.trim();
    if (firstMessage) {
        return { ...base, error: truncateLines(firstMessage, ERROR_LINE_LIMIT) };
    }

    if (failed === 0 && passed === 0 && skipped === 0) {
        // Nothing executed at all — the cause lives on stderr (bad config,
        // missing dev script, playwright crash), not in the report.
        const errLines = (stderr ?? "")
            .split("\n")
            .map((line) => line.trimEnd())
            .filter((line) => line.length > 0);
        if (errLines.length > 0) {
            return {
                ...base,
                error: truncateLines(errLines.join("\n"), ERROR_LINE_LIMIT),
            };
        }
    }
    return base;
}

function truncateLines(text: string, limit: number): string {
    const lines = text.split("\n");
    if (lines.length <= limit) return text;
    return `${lines.slice(0, limit).join("\n")}\n… (${lines.length - limit} more lines)`;
}

/**
 * Playwright error excerpts carry ANSI styling for the terminal. Keep it for
 * human output, but the `--json` payload is machine-read — escape sequences
 * there are garbage for CI consumers.
 */
export function stripAnsi(text: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes by construction
    return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Numeric flags arrive as strings from commander — validate like `start -p`. */
function parseNonNegativeInt(value: string | undefined, flag: string): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        exitUsage(`Invalid ${flag}: "${value}". Must be a non-negative integer.`);
    }
    return parsed;
}

/**
 * `raiken test [file]` — run the Playwright suite (or a single spec) and report
 * a compact pass/fail summary. Exit code reflects the outcome so it drops into
 * scripts and pre-push hooks. Mirrors the REPL `/test` command.
 */
export async function testCommand(file: string | undefined, options: TestOptions): Promise<void> {
    const workers = parseNonNegativeInt(options.workers, "--workers");
    const retries = parseNonNegativeInt(options.retries, "--retries");

    if (options.watch && options.json) exitUsage("--watch cannot be combined with --json.");
    if (options.watch && options.list) exitUsage("--watch cannot be combined with --list.");
    if (options.watch && options.debug) exitUsage("--watch cannot be combined with --debug.");
    if (options.watch && options.fix) exitUsage("--watch cannot be combined with --fix.");
    if (options.debug && options.json) exitUsage("--debug cannot be combined with --json.");
    if (options.debug && options.list) exitUsage("--debug cannot be combined with --list.");
    if (options.onlyFlaky && file) {
        exitUsage("--only-flaky selects quarantined specs from the suite; drop the file argument.");
    }

    const projectPath = process.cwd();
    const flags = { workers, retries };

    if (options.debug) {
        await debugRun(projectPath, file, options);
        return;
    }

    if (options.list) {
        await listTests(projectPath, file, options, flags);
        return;
    }

    if (options.watch) {
        await watchLoop(projectPath, file, options, flags);
        return;
    }

    const { input } = await buildRunInput(projectPath, file, options, flags);
    const { code, result } = await executeRun(projectPath, input, options);
    if (!options.fix || code === 0) cliExit(code);

    // --fix: hand the run we just did to the repair flow — no second
    // execution. The exit code stays 1: an unverified fix must not
    // green-light a CI pipeline.
    const target = resolveRepairTarget(projectPath, file, result);
    if (!target) {
        process.stderr.write(
            dim("  --fix: could not determine which spec file failed — nothing repaired.\n"),
        );
        cliExit(code);
    }
    await repairFailedRun({
        projectPath,
        file: target,
        run: result as RepairRunResult,
        options: {
            json: options.json,
            runSummary: {
                passed: result.parsedRun?.tests?.filter((t) => t.status === "passed").length ?? 0,
                failed: result.parsedRun?.tests?.filter((t) => t.status === "failed").length ?? 0,
                skipped: result.parsedRun?.tests?.filter((t) => t.status === "skipped").length ?? 0,
            },
            ...(options.confirm ? { confirm: options.confirm } : {}),
        },
    });
}

/** Pick the spec to repair: the explicit argument, else the first failure's file. */
function resolveRepairTarget(
    projectPath: string,
    file: string | undefined,
    result: RunTestsResult,
): string | null {
    if (file) return file;
    const location = (result.parsedRun?.tests ?? []).find(
        (t) => t.status === "failed" && t.error?.location?.file,
    )?.error?.location?.file;
    if (!location) return null;
    return path.isAbsolute(location) ? path.relative(projectPath, location) : location;
}

/** Build the service input, applying the quarantine filter for full-suite runs. */
async function buildRunInput(
    projectPath: string,
    file: string | undefined,
    options: TestOptions,
    flags: { workers?: number; retries?: number },
): Promise<{ input: TestExecutionInput }> {
    const input: TestExecutionInput = {
        ...(file ? { testFile: file } : {}),
        ...(options.grep ? { testName: options.grep } : {}),
        ...(flags.workers !== undefined ? { workers: flags.workers } : {}),
        ...(flags.retries !== undefined ? { retries: flags.retries } : {}),
        ...(options.headed ? { headed: true } : {}),
        ...(options.project ? { project: options.project } : {}),
        ...(options.updateSnapshots ? { updateSnapshots: true } : {}),
    };

    if (file) return { input };

    const partition = await partitionSuiteSpecs(projectPath);
    if (!partition) {
        if (options.onlyFlaky) {
            process.stderr.write(
                dim(
                    "  No quarantined specs (quarantine.testFiles in raiken.config.json is empty).\n",
                ),
            );
            cliExit(0);
        }
        return { input };
    }

    if (options.onlyFlaky) {
        if (partition.excluded.length === 0) {
            process.stderr.write(dim("  No quarantined specs match files on disk.\n"));
            cliExit(0);
        }
        process.stderr.write(
            dim(`  Running ${partition.excluded.length} quarantined spec(s) only.\n`),
        );
        return { input: { ...input, testFiles: partition.excluded } };
    }

    if (partition.excluded.length > 0) {
        process.stderr.write(dim(quarantineSkipNotice(partition.excluded)));
    }
    if (partition.included.length === 0) {
        process.stderr.write(dim("  Every spec is quarantined — nothing to run.\n"));
        cliExit(0);
    }
    return { input: { ...input, testFiles: partition.included } };
}

/** Execute one run, print the human or JSON summary, return code + raw result. */
async function executeRun(
    projectPath: string,
    input: TestExecutionInput,
    options: TestOptions,
): Promise<{ code: number; result: RunTestsResult }> {
    const app = createProjectApplication(projectPath);
    const restore = options.json ? routeDiagnosticsToStderr() : null;

    const result = (await app.testing.runTests(input)) as RunTestsResult;
    const summary = summarizeRunForCli(result.parsedRun, result.stderr);
    const { passed, failed, skipped } = summary;
    for (const failure of summary.failures) {
        if (failure.file && path.isAbsolute(failure.file)) {
            failure.file = path.relative(projectPath, failure.file);
        }
    }

    if (options.json) {
        restore?.();
        // --fix on a failed run: the repair payload is the one JSON document
        // for this invocation (it embeds the run counts), so stdout stays a
        // single parseable object.
        if (!(options.fix && !result.success)) {
            process.stdout.write(
                `${JSON.stringify(
                    {
                        success: result.success,
                        passed,
                        failed,
                        skipped,
                        ...(summary.durationMs !== undefined
                            ? { durationMs: summary.durationMs }
                            : {}),
                        ...(summary.failures.length > 0
                            ? {
                                  failures: summary.failures,
                                  ...(failed > summary.failures.length
                                      ? { failuresTruncated: failed - summary.failures.length }
                                      : {}),
                              }
                            : {}),
                        ...(!result.success && summary.error
                            ? { error: stripAnsi(summary.error) }
                            : {}),
                    },
                    null,
                    2,
                )}\n`,
            );
        }
        return { code: result.success ? 0 : 1, result };
    }

    const badge = result.success ? chalk.green("✓ passed") : chalk.red("✗ failed");
    const timing =
        summary.durationMs !== undefined ? ` in ${(summary.durationMs / 1000).toFixed(1)}s` : "";
    console.log(
        `  ${badge}${dim(`  (${passed} passed, ${failed} failed, ${skipped} skipped${timing})`)}`,
    );
    if (!result.success) {
        for (const failure of summary.failures) {
            const location = failure.file
                ? dim(`  (${failure.file}${failure.line ? `:${failure.line}` : ""})`)
                : "";
            console.log(`  ${chalk.red("✗")} ${failure.name}${location}`);
        }
        if (failed > summary.failures.length) {
            console.log(dim(`  … and ${failed - summary.failures.length} more failure(s)`));
        }
        if (summary.error) {
            console.log(dim(summary.error));
            if (summary.error.includes("config.webServer")) {
                // Playwright's message names the failure but not the cause —
                // usually the port in playwright.config.ts doesn't match the
                // dev server (or the port is already taken).
                console.log(
                    dim(
                        "  Hint: the webServer block in playwright.config.ts starts your dev " +
                            "server and waits on its port. Check the port matches your app and " +
                            "isn't already in use.",
                    ),
                );
            }
        }
        if (passed + failed + skipped === 0) {
            console.log(
                dim(
                    "  No tests ran — the suite failed before executing any spec " +
                        "(run `raiken doctor` to check the environment).",
                ),
            );
        } else if (!summary.error && result.stderr) {
            console.log(dim(result.stderr.split("\n").slice(0, 8).join("\n")));
        }
    }
    console.log("");
    return { code: result.success ? 0 : 1, result };
}

/** `raiken test --list` — discover the suite without executing it. */
async function listTests(
    projectPath: string,
    file: string | undefined,
    options: TestOptions,
    flags: { workers?: number; retries?: number },
): Promise<void> {
    const app = createProjectApplication(projectPath);
    const restore = options.json ? routeDiagnosticsToStderr() : null;
    const { input } = await buildRunInput(projectPath, file, options, flags);

    const result = (await app.testing.runTests({ ...input, listOnly: true })) as RunTestsResult;
    const listed = result.listedTests ?? [];

    if (options.json) {
        restore?.();
        process.stdout.write(
            `${JSON.stringify({ success: result.success, count: listed.length, tests: listed }, null, 2)}\n`,
        );
        cliExit(result.success ? 0 : 1);
    }

    if (!result.success) {
        console.log(chalk.red("  ✗ Could not list tests (Playwright failed to load the suite)."));
        if (result.stderr) console.log(dim(result.stderr.split("\n").slice(0, 8).join("\n")));
        cliExit(1);
    }

    if (listed.length === 0) {
        console.log(dim("  No tests found. Check testDir in playwright.config.ts."));
        cliExit(0);
    }

    // Group rows under a file header; within a group, align the :line column
    // and strip the duplicated "<file> > " Playwright prefixes from suites.
    const groups = new Map<string, typeof listed>();
    for (const test of listed) {
        const group = test.file ?? test.suite ?? "(suite)";
        const bucket = groups.get(group) ?? [];
        bucket.push(test);
        groups.set(group, bucket);
    }

    for (const [group, tests] of groups) {
        console.log(`\n  ${chalk.bold(group)}`);
        const rows = tests.map((test) => {
            const suite = test.suite ? stripFileSuitePrefix(test.suite, test.file) : "";
            const label = suite && suite !== group ? `${suite} › ${test.title}` : test.title;
            return { label, line: test.line };
        });
        const width = Math.max(...rows.map((row) => row.label.length));
        for (const row of rows) {
            const line = row.line ? dim(`  :${row.line}`) : "";
            console.log(`    ${row.label.padEnd(width)}${line}`);
        }
    }
    console.log(dim(`\n  ${listed.length} test(s).`));
    cliExit(0);
}

/**
 * `raiken test --debug` — hand the terminal to the Playwright inspector.
 * Bypasses the JSON-capture service: the inspector needs a real TTY, not
 * piped stdout.
 */
async function debugRun(
    projectPath: string,
    file: string | undefined,
    options: TestOptions,
): Promise<void> {
    const args = ["playwright", "test"];
    if (file) args.push(file);
    if (options.grep) args.push("-g", options.grep);
    if (options.project) args.push(`--project=${options.project}`);
    args.push("--debug");

    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    const result = await runPlaywrightSubprocess({
        cwd: projectPath,
        args,
        interactive: true,
        signal: controller.signal,
    });
    if (result.spawnError) {
        console.log(chalk.red(`  Could not start Playwright: ${result.spawnError.message}`));
        cliExit(1);
    }
    cliExit(result.cancelled ? CLI_EXIT.CANCELLED : (result.exitCode ?? 0));
}

/**
 * `raiken test --watch` — the edit → re-run inner loop. Initial run, then a
 * debounced re-run on any project change; an in-flight run is cancelled so
 * rapid saves don't queue stale executions. Ctrl+C stops.
 */
async function watchLoop(
    projectPath: string,
    file: string | undefined,
    options: TestOptions,
    flags: { workers?: number; retries?: number },
): Promise<void> {
    const app = createProjectApplication(projectPath);

    let chain: Promise<void> = Promise.resolve();
    const scheduleRun = (reason: string) => {
        chain = chain.then(async () => {
            process.stderr.write(dim(`\n  ── ${reason} ${new Date().toLocaleTimeString()} ──\n`));
            const { input } = await buildRunInput(projectPath, file, options, flags);
            await executeRun(projectPath, input, { ...options, json: false });
            process.stderr.write(dim("  Watching for changes… (Ctrl+C to stop)\n"));
        });
        return chain;
    };

    await scheduleRun("initial run ·");

    const watcher = startTestWatcher({
        projectPath,
        onTrigger: ({ file: changed }) => {
            app.testing.cancelTestRun();
            void scheduleRun(`changed: ${changed} ·`);
        },
        onError: (error) => {
            process.stderr.write(dim(`  Watcher error: ${String(error)}\n`));
        },
    });

    await new Promise<void>((resolve) => {
        process.once("SIGINT", () => resolve());
    });
    await watcher.close();
    app.testing.cancelTestRun();
    cliExit(CLI_EXIT.CANCELLED);
}
