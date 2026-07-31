import * as path from "node:path";
import { findPlaywrightConfigPath } from "./playwright-config";
import { extractReporterJson, mapReportToTestRunResults } from "./playwright-json-report";
import {
    playwrightJsonReporterEnv,
    runnerPlaywrightSpawnOptions,
    runPlaywrightSubprocess,
} from "./playwright-subprocess";
import type { ReportAttachment } from "./report-parser";
import { TestStorage } from "./storage";
import type { TestRunResult } from "./test-run-result";

export { extractReporterJson } from "./playwright-json-report";
export type { TestRunResult } from "./test-run-result";

/**
 * Options for running tests
 */
export interface TestRunOptions {
    /** Timeout in milliseconds */
    timeout?: number;
    /** Run in headed mode (visible browser) */
    headed?: boolean;
    /** Project path for relative file resolution */
    projectPath?: string;
    /** Cancel the subprocess and kill its process tree when aborted */
    signal?: AbortSignal;
    /**
     * Playwright `--retries`. Left unset the project config decides, which is
     * right for a user-initiated run but wrong for verification: a config with
     * `retries: 2` lets a fix that works one time in three report success.
     * Pin it to 0 whenever the run is evidence rather than a convenience.
     */
    retries?: number;
    /**
     * Playwright `--repeat-each`: run the spec this many times in a single
     * invocation. Used to prove a repair holds up rather than passing once.
     */
    repeatEach?: number;
}

/**
 * TestRunner - Execute Playwright tests and capture results
 */
export class TestRunner {
    private projectPath: string;
    private storage: TestStorage;

    constructor(projectPath: string) {
        this.projectPath = projectPath;
        this.storage = new TestStorage(projectPath);
    }

    async saveTestToTemp(testCode: string, testName?: string): Promise<string> {
        return this.storage.saveToTemp(testCode, testName);
    }

    async saveTestToProject(
        testCode: string,
        testDirectory: string,
        fileName: string,
    ): Promise<string> {
        return this.storage.saveToProject(testCode, testDirectory, fileName);
    }

    async runTest(testFile: string, options: TestRunOptions = {}): Promise<TestRunResult[]> {
        const { timeout = 60000, headed = false, signal, retries, repeatEach } = options;

        if (signal?.aborted) {
            return [
                {
                    testFile,
                    testName: this.extractTestName(testFile),
                    status: "error",
                    duration: 0,
                    error: { message: "Operation cancelled" },
                },
            ];
        }

        const configPath = await findPlaywrightConfigPath(this.projectPath);
        const startTime = Date.now();

        const args = [
            "playwright",
            "test",
            testFile,
            "--reporter=json",
            "--workers=1",
            "--timeout",
            timeout.toString(),
        ];

        if (configPath) args.push("--config", configPath);
        if (typeof retries === "number" && retries >= 0) args.push(`--retries=${retries}`);
        if (typeof repeatEach === "number" && repeatEach > 1) {
            args.push(`--repeat-each=${repeatEach}`);
        }
        if (headed) args.push("--headed");

        const subprocess = await runPlaywrightSubprocess(
            runnerPlaywrightSpawnOptions({
                cwd: this.projectPath,
                args,
                env: playwrightJsonReporterEnv(),
                signal,
                timeoutMs: timeout,
                timeoutGraceMs: 5000,
            }),
        );

        const duration = Date.now() - startTime;

        if (subprocess.cancelled) {
            return [
                {
                    testFile,
                    testName: this.extractTestName(testFile),
                    status: "error",
                    duration,
                    error: { message: "Operation cancelled" },
                },
            ];
        }

        if (subprocess.timedOut) {
            return [
                {
                    testFile,
                    testName: "unknown",
                    status: "timeout",
                    duration: timeout,
                    error: { message: `Test timed out after ${timeout}ms` },
                },
            ];
        }

        if (subprocess.spawnError) {
            return [
                {
                    testFile,
                    testName: "unknown",
                    status: "error",
                    duration,
                    error: { message: subprocess.spawnError.message },
                },
            ];
        }

        const parsed = this.parseJsonOutput(subprocess.stdout, testFile, duration);
        if (parsed.length > 0) {
            // Playwright can fail outside the specs (global teardown, a worker
            // crash after results were flushed) and still emit an all-green
            // report. Without this the repair loop and the flakiness gate would
            // read that run as a clean pass.
            if (subprocess.exitCode !== 0 && parsed.every((r) => r.status === "passed")) {
                parsed.push({
                    testFile,
                    testName: "Playwright run",
                    status: "error",
                    duration,
                    error: {
                        message: `Every test passed but Playwright exited with code ${subprocess.exitCode}, so the run failed outside the specs.`,
                        stack: (subprocess.stderr || subprocess.stdout).slice(0, 2000),
                    },
                });
            }
            return parsed;
        }

        if (subprocess.exitCode === 0) {
            return [
                {
                    testFile,
                    testName: this.extractTestName(testFile),
                    status: "error",
                    duration,
                    error: {
                        message:
                            "Playwright exited successfully but produced no parsable JSON report — cannot confirm the test actually ran. Check for a misconfigured reporter (e.g. PLAYWRIGHT_JSON_OUTPUT_NAME redirecting output to a file) or a crash before results were flushed.",
                        stack: (subprocess.stderr || subprocess.stdout).slice(0, 2000),
                    },
                },
            ];
        }

        return [
            {
                testFile,
                testName: this.extractTestName(testFile),
                status: "failed",
                duration,
                error: this.parseError(subprocess.stderr || subprocess.stdout),
            },
        ];
    }

    private parseJsonOutput(
        output: string,
        testFile: string,
        fallbackDuration: number,
    ): TestRunResult[] {
        try {
            const json = extractReporterJson(output);
            if (!json) return [];
            return mapReportToTestRunResults(json, testFile, fallbackDuration);
        } catch {
            return [];
        }
    }

    private parseError(output: string): { message: string; stack?: string; selector?: string } {
        const errorMatch = output.match(/Error:(.+?)(?:\n|$)/);
        const message = errorMatch ? errorMatch[1].trim() : output.slice(0, 500);
        const selector = this.extractSelectorFromError(output);
        return {
            message,
            stack: output.slice(0, 2000),
            selector: selector || undefined,
        };
    }

    private extractSelectorFromError(errorText: string): string | null {
        const patterns = [
            /locator\(['"](.+?)['"]\)/,
            /selector ['"](.+?)['"]/,
            /element ['"](.+?)['"]/,
            /getByRole\(['"](.+?)['"]/,
            /getByTestId\(['"](.+?)['"]/,
            /getByText\(['"](.+?)['"]/,
            /\[data-testid=['"](.+?)['"]\]/,
        ];
        for (const pattern of patterns) {
            const match = errorText.match(pattern);
            if (match) return match[1];
        }
        return null;
    }

    private extractTestName(testFile: string): string {
        const fileName = path.basename(testFile, path.extname(testFile));
        return fileName.replace(/\.spec$/, "").replace(/\.test$/, "");
    }

    async cleanup(): Promise<void> {
        await this.storage.cleanupTemp();
    }
}

export type { ReportAttachment };
