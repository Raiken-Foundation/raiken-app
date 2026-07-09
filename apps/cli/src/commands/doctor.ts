/**
 * `raiken doctor` — lints the test suite for the small set of patterns
 * that are reliably the cause of E2E flakes (fixed sleeps, .only, trivial
 * assertions). Designed to be cheap enough to run from a pre-commit hook
 * or CI pipeline without slowing anyone down.
 */

import {
    type DoctorFinding,
    type DoctorReport,
    type DoctorSeverity,
    readConfiguredTestDirectory,
    scanTests,
} from "@raiken/core";
import chalk from "chalk";
import { cliExit } from "../repl/exit";

interface DoctorCommandOptions {
    dir?: string;
    json?: boolean;
    /** If set, exit non-zero only when at least one finding of this severity exists. */
    failOn?: string;
}

export async function doctorCommand(options: DoctorCommandOptions): Promise<void> {
    const projectPath = process.cwd();
    const testDir = options.dir ?? readConfiguredTestDirectory(projectPath) ?? "e2e";
    const failOn = parseFailOn(options.failOn);
    const jsonOutput = options.json === true;

    if (!jsonOutput) {
        console.log(chalk.cyan(`\nraiken doctor — scanning ${testDir}/\n`));
    }

    const report = await scanTests({ projectPath, testDirectory: testDir });

    if (jsonOutput) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
        printHumanReport(report, testDir);
    }

    cliExit(shouldFail(report, failOn) ? 1 : 0);
}

function parseFailOn(value: string | undefined): DoctorSeverity {
    const normalised = (value ?? "error").toLowerCase();
    if (normalised === "error" || normalised === "warning" || normalised === "info") {
        return normalised;
    }
    return "error";
}

function shouldFail(report: DoctorReport, threshold: DoctorSeverity): boolean {
    const order: DoctorSeverity[] = ["info", "warning", "error"];
    const cutoff = order.indexOf(threshold);
    return report.findings.some((f) => order.indexOf(f.severity) >= cutoff);
}

function printHumanReport(report: DoctorReport, testDir: string): void {
    if (report.scannedFiles === 0) {
        console.log(chalk.yellow(`No test files found under ${testDir}/.`));
        return;
    }

    if (report.findings.length === 0) {
        console.log(
            chalk.green(`✓ Clean. Scanned ${report.scannedFiles} file(s) — no issues found.`),
        );
        return;
    }

    let currentFile = "";
    for (const f of report.findings) {
        if (f.file !== currentFile) {
            currentFile = f.file;
            console.log(`\n${chalk.bold(f.file)}`);
        }
        console.log(
            `  ${severityBadge(f.severity)} ${chalk.dim(`${f.line}:${f.column}`)}  ${chalk.dim(f.rule)}`,
        );
        console.log(`     ${f.message}`);
        console.log(`     ${chalk.dim(f.snippet)}`);
        console.log(`     ${chalk.cyan("→")} ${f.suggestion}`);
    }

    console.log();
    console.log(
        `${chalk.bold("Scanned:")} ${report.scannedFiles} file(s)   ` +
            `${chalk.bold("Errors:")} ${chalk.red(report.summary.error)}   ` +
            `${chalk.bold("Warnings:")} ${chalk.yellow(report.summary.warning)}   ` +
            `${chalk.bold("Info:")} ${report.summary.info}`,
    );
}

function severityBadge(s: DoctorFinding["severity"]): string {
    if (s === "error") return chalk.red("✗ error  ");
    if (s === "warning") return chalk.yellow("! warn   ");
    return chalk.blue("i info   ");
}
