import { spawn } from "node:child_process";
import * as path from "node:path";
import { TestStorage } from "./storage";

/**
 * Result of running a single test
 */
export interface TestRunResult {
    testFile: string;
    testName: string;
    status: "passed" | "failed" | "error" | "timeout" | "skipped";
    duration: number;
    error?: {
        message: string;
        stack?: string;
        selector?: string;
    };
}

/** Minimal shape of the Playwright JSON reporter output we consume. */
interface PlaywrightJsonResult {
    status?: string;
    duration?: number;
    error?: { message?: string; stack?: string };
}
interface PlaywrightJsonSpec {
    title: string;
    tests?: Array<{ results?: PlaywrightJsonResult[] }>;
}
interface PlaywrightJsonSuite {
    specs?: PlaywrightJsonSpec[];
    suites?: PlaywrightJsonSuite[];
}
interface PlaywrightJsonReport {
    suites?: PlaywrightJsonSuite[];
}

/**
 * Extract the Playwright JSON reporter object from a mixed stdout stream.
 *
 * The reporter prints one JSON object, but npm/npx and other tooling can emit
 * unrelated text (and even other JSON-ish blobs) around it. Rather than a
 * greedy regex — which can span across the wrong braces — we scan for balanced
 * `{...}` objects (ignoring braces inside strings) and return the first one
 * that parses and contains a `suites` array.
 */
export function extractReporterJson(output: string): PlaywrightJsonReport | null {
    // Fast path: the whole stream is the JSON object.
    try {
        const parsed = JSON.parse(output);
        if (parsed && typeof parsed === "object" && "suites" in parsed) return parsed;
    } catch {
        // fall through to scanning
    }

    for (let i = 0; i < output.length; i++) {
        if (output[i] !== "{") continue;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let j = i; j < output.length; j++) {
            const ch = output[j];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === "\\") escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === "{") depth++;
            else if (ch === "}") {
                depth--;
                if (depth === 0) {
                    const candidate = output.slice(i, j + 1);
                    try {
                        const parsed = JSON.parse(candidate);
                        if (parsed && typeof parsed === "object" && "suites" in parsed) {
                            return parsed;
                        }
                    } catch {
                        // not valid JSON; keep scanning from next "{"
                    }
                    i = j; // advance outer loop past this object
                    break;
                }
            }
        }
    }

    return null;
}

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
}

/**
 * TestRunner - Execute Playwright tests and capture results
 *
 * Responsibilities:
 * - Run individual test files
 * - Parse test output for pass/fail status
 * - Extract error messages and failing selectors
 * - Handle timeouts gracefully
 */
export class TestRunner {
    private projectPath: string;
    private storage: TestStorage;

    constructor(projectPath: string) {
        this.projectPath = projectPath;
        this.storage = new TestStorage(projectPath);
    }

    /**
     * Save test code to a temporary file.
     * Returns the path to the saved file.
     */
    async saveTestToTemp(testCode: string, testName?: string): Promise<string> {
        return this.storage.saveToTemp(testCode, testName);
    }

    /**
     * Save test code to the project's test directory.
     * Returns the path to the saved file.
     */
    async saveTestToProject(
        testCode: string,
        testDirectory: string,
        fileName: string,
    ): Promise<string> {
        return this.storage.saveToProject(testCode, testDirectory, fileName);
    }

    /**
     * Run a test file using Playwright Test.
     */
    async runTest(testFile: string, options: TestRunOptions = {}): Promise<TestRunResult[]> {
        const { timeout = 60000, headed = false } = options;

        return new Promise((resolve) => {
            const results: TestRunResult[] = [];
            const startTime = Date.now();

            // Build npx playwright test command.
            //
            // Force serial execution (--workers=1). Raiken runs a suite against a
            // single live app instance backed by ONE authenticated account: parallel
            // workers overwhelm dev servers (load-event timeouts) and race on shared
            // account state, producing flaky failures unrelated to the code. Serial
            // is the reliable default for agent-driven E2E.
            const args = [
                "playwright",
                "test",
                testFile,
                "--reporter=json",
                "--workers=1",
                "--timeout",
                timeout.toString(),
            ];

            if (headed) {
                args.push("--headed");
            }

            const child = spawn("npx", args, {
                cwd: this.projectPath,
                shell: true,
                env: { ...process.env },
            });

            let stdout = "";
            let stderr = "";

            child.stdout?.on("data", (data) => {
                stdout += data.toString();
            });

            child.stderr?.on("data", (data) => {
                stderr += data.toString();
            });

            // Guards so the timeout and close/error handlers can't both settle
            // the promise (which would push duplicate results).
            let settled = false;
            let killTimer: NodeJS.Timeout | null = null;

            // Handle timeout
            const timeoutId = setTimeout(() => {
                // Ask the process group to terminate; if it ignores SIGTERM
                // (hung driver/browser), escalate to SIGKILL so we don't leave
                // orphaned npx/Chromium processes accumulating across runs.
                child.kill("SIGTERM");
                killTimer = setTimeout(() => {
                    try {
                        child.kill("SIGKILL");
                    } catch {
                        // Already exited.
                    }
                }, 5000);
                if (settled) return;
                settled = true;
                results.push({
                    testFile,
                    testName: "unknown",
                    status: "timeout",
                    duration: timeout,
                    error: {
                        message: `Test timed out after ${timeout}ms`,
                    },
                });
                resolve(results);
            }, timeout + 5000); // Extra buffer for process cleanup

            child.on("close", (code) => {
                clearTimeout(timeoutId);
                if (killTimer) clearTimeout(killTimer);
                if (settled) return;
                settled = true;
                const duration = Date.now() - startTime;

                // Try to parse JSON reporter output
                const parsed = this.parseJsonOutput(stdout, testFile, duration);
                if (parsed.length > 0) {
                    resolve(parsed);
                    return;
                }

                // Fallback: parse text output
                if (code === 0) {
                    results.push({
                        testFile,
                        testName: this.extractTestName(testFile),
                        status: "passed",
                        duration,
                    });
                } else {
                    const error = this.parseError(stderr || stdout);
                    results.push({
                        testFile,
                        testName: this.extractTestName(testFile),
                        status: "failed",
                        duration,
                        error,
                    });
                }

                resolve(results);
            });

            child.on("error", (err) => {
                clearTimeout(timeoutId);
                if (killTimer) clearTimeout(killTimer);
                if (settled) return;
                settled = true;
                results.push({
                    testFile,
                    testName: "unknown",
                    status: "error",
                    duration: Date.now() - startTime,
                    error: {
                        message: err.message,
                    },
                });
                resolve(results);
            });
        });
    }

    /**
     * Parse Playwright JSON reporter output.
     */
    private parseJsonOutput(
        output: string,
        testFile: string,
        fallbackDuration: number,
    ): TestRunResult[] {
        const results: TestRunResult[] = [];

        try {
            const json = extractReporterJson(output);
            if (!json) return results;

            // Playwright nests `suites` recursively (project → file → describe →
            // nested describe). Walk the whole tree so tests inside describe
            // blocks are not silently dropped, which would otherwise force a
            // fallback to weaker regex parsing.
            const walkSuites = (suites: PlaywrightJsonSuite[]) => {
                for (const suite of suites || []) {
                    for (const spec of suite.specs || []) {
                        // Aggregate across retries: prefer the final attempt's
                        // outcome, but keep the error from the last failing run.
                        const attempts = spec.tests?.flatMap((t) => t.results || []) || [];
                        if (attempts.length === 0) continue;
                        const result = attempts[attempts.length - 1];

                        const status =
                            result.status === "passed"
                                ? "passed"
                                : result.status === "timedOut"
                                  ? "timeout"
                                  : result.status === "skipped"
                                    ? "skipped"
                                    : "failed";

                        const testResult: TestRunResult = {
                            testFile,
                            testName: spec.title,
                            status,
                            duration: result.duration || fallbackDuration,
                        };

                        const failure =
                            status !== "passed" && status !== "skipped"
                                ? attempts.find((a) => a.error) || result
                                : undefined;
                        if (failure?.error) {
                            testResult.error = {
                                message: failure.error.message || "Unknown error",
                                stack: failure.error.stack,
                                selector:
                                    this.extractSelectorFromError(failure.error.message || "") ||
                                    undefined,
                            };
                        }

                        results.push(testResult);
                    }
                    if (suite.suites) walkSuites(suite.suites);
                }
            };

            walkSuites(json.suites || []);
        } catch {
            // Invalid JSON output
        }

        return results;
    }

    /**
     * Parse error message from stderr/stdout.
     */
    private parseError(output: string): { message: string; stack?: string; selector?: string } {
        // Extract first error-like message
        const errorMatch = output.match(/Error:(.+?)(?:\n|$)/);
        const message = errorMatch ? errorMatch[1].trim() : output.slice(0, 500);

        // Try to extract failing selector
        const selector = this.extractSelectorFromError(output);

        return {
            message,
            stack: output.slice(0, 2000),
            selector: selector || undefined,
        };
    }

    /**
     * Extract failing selector from error message.
     */
    private extractSelectorFromError(errorText: string): string | null {
        // Common Playwright error patterns
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
            if (match) {
                return match[1];
            }
        }

        return null;
    }

    /**
     * Extract test name from file path.
     */
    private extractTestName(testFile: string): string {
        const fileName = path.basename(testFile, path.extname(testFile));
        return fileName.replace(/\.spec$/, "").replace(/\.test$/, "");
    }

    /**
     * Clean up temporary test files.
     */
    async cleanup(): Promise<void> {
        await this.storage.cleanupTemp();
    }
}
