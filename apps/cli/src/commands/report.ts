/**
 * `raiken report [file]` — run the Playwright suite (or a single spec) and write
 * a detailed, shareable HTML report with embedded screenshots (plus optional
 * Markdown/JSON). Use `--from <results.json>` to build a report from a prior run
 * without re-running.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { appRouter } from "@raiken/shared";
import chalk from "chalk";
import { dim, routeDiagnosticsToStderr } from "../agent-stream";
import { cliExit } from "../repl/exit";

interface ReportOptions {
    from?: string;
    format?: string;
    output?: string;
    open?: boolean;
    json?: boolean;
    /** Commander negates `--no-embed-screenshots` into this boolean itself. */
    embedScreenshots?: boolean;
}

interface RunTestsResult {
    success: boolean;
    stdout?: string;
    stderr?: string;
    results?: unknown;
}

interface GenerateReportResult {
    outputDir: string;
    files: string[];
    htmlPath?: string;
    screenshotsEmbedded: number;
    summary: {
        tests: { passed: number; failed: number; total: number };
        timeSeconds: number;
    };
}

const VALID_FORMATS = ["html", "markdown", "json"] as const;
type Fmt = (typeof VALID_FORMATS)[number];

function parseFormats(raw?: string): Fmt[] {
    if (!raw) return ["html", "json"];
    const out = raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .map((s) => (s === "md" ? "markdown" : s))
        .filter((s): s is Fmt => (VALID_FORMATS as readonly string[]).includes(s));
    return out.length > 0 ? out : ["html", "json"];
}

function openFile(filePath: string): void {
    const cmd =
        process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "start"
              : "xdg-open";
    try {
        spawn(cmd, [filePath], {
            detached: true,
            stdio: "ignore",
            shell: process.platform === "win32",
        }).unref();
    } catch {
        /* best-effort */
    }
}

export async function reportCommand(
    file: string | undefined,
    options: ReportOptions,
): Promise<void> {
    const projectPath = process.cwd();
    const restore = options.json ? routeDiagnosticsToStderr() : null;
    const caller = appRouter.createCaller({ projectPath });
    const formats = parseFormats(options.format);

    let report: unknown;
    let rawOutput: string | undefined;
    let testSuccess = true;

    if (options.from) {
        // Build from an existing Playwright results JSON — no run.
        const fromPath = path.resolve(projectPath, options.from);
        try {
            const raw = await fs.readFile(fromPath, "utf-8");
            report = JSON.parse(raw);
        } catch (err) {
            restore?.();
            process.stderr.write(
                chalk.red(
                    `\n  ✗ Could not read report JSON at ${options.from}: ${
                        err instanceof Error ? err.message : err
                    }\n`,
                ),
            );
            cliExit(2);
            return;
        }
    } else {
        if (!options.json) {
            process.stderr.write(dim(`\n  Running tests${file ? ` for ${file}` : ""}…\n`));
        }
        const run = (await caller.runTests(file ? { testFile: file } : {})) as RunTestsResult;
        report = run.results;
        rawOutput = run.stdout;
        testSuccess = run.success;
        if (!report) {
            restore?.();
            process.stderr.write(
                chalk.red("\n  ✗ Test run produced no parseable report.\n") +
                    (run.stderr ? dim(run.stderr.split("\n").slice(0, 8).join("\n")) : ""),
            );
            cliExit(2);
            return;
        }
    }

    const result = (await caller.generateTestReport({
        report,
        rawOutput,
        testFile: file,
        formats,
        outputDir: options.output,
        embedScreenshots: options.embedScreenshots,
    })) as GenerateReportResult;

    // `--from` never ran tests itself, so `testSuccess` (which only reflects
    // a live run) can't tell us pass/fail — derive it from the report's own
    // summary instead. Previously `--from` always exited 0 regardless of
    // whether the report showed failures, which broke CI gates piping a
    // prior run's results.json through `raiken report --from`.
    const reportFailed = result.summary.tests.failed > 0;
    const exitCode = options.from ? (reportFailed ? 1 : 0) : testSuccess ? 0 : 1;

    if (options.json) {
        restore?.();
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        cliExit(exitCode);
        return;
    }

    const { passed, failed, total } = result.summary.tests;
    const badge = failed === 0 ? chalk.green("✓") : chalk.red("✗");
    console.log(`\n  ${badge} ${passed}/${total} passed${dim(`, ${failed} failed`)}`);
    console.log(
        chalk.green(`  Report: ${result.htmlPath ?? result.files[0]}`) +
            dim(`  (${result.screenshotsEmbedded} screenshot(s) embedded)`),
    );
    for (const f of result.files) {
        if (f !== result.htmlPath) console.log(dim(`     ${f}`));
    }
    console.log("");

    if (options.open) {
        if (result.htmlPath) {
            openFile(path.resolve(projectPath, result.htmlPath));
        } else {
            console.log(
                chalk.yellow(
                    '  ⚠ --open had nothing to open: no HTML report was generated (include "html" in --format).\n',
                ),
            );
        }
    }

    cliExit(exitCode);
}
