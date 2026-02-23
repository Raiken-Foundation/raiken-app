import { spawn } from "node:child_process";
import * as path from "node:path";
import { TestStorage } from "./storage";

/**
 * Result of running a single test
 */
export interface TestRunResult {
    testFile: string;
    testName: string;
    status: "passed" | "failed" | "error" | "timeout";
    duration: number;
    error?: {
        message: string;
        stack?: string;
        selector?: string;
    };
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
        fileName: string
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

            // Build npx playwright test command
            const args = [
                "playwright",
                "test",
                testFile,
                "--reporter=json",
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

            // Handle timeout
            const timeoutId = setTimeout(() => {
                child.kill("SIGTERM");
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
     * Run a specific test by name within a file.
     */
    async runTestByName(
        testFile: string,
        testName: string,
        options: TestRunOptions = {}
    ): Promise<TestRunResult> {
        const { timeout = 60000, headed = false } = options;

        return new Promise((resolve) => {
            const startTime = Date.now();

            const args = [
                "playwright",
                "test",
                testFile,
                "--grep",
                testName,
                "--reporter=json",
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

            const timeoutId = setTimeout(() => {
                child.kill("SIGTERM");
                resolve({
                    testFile,
                    testName,
                    status: "timeout",
                    duration: timeout,
                    error: {
                        message: `Test timed out after ${timeout}ms`,
                    },
                });
            }, timeout + 5000);

            child.on("close", (code) => {
                clearTimeout(timeoutId);
                const duration = Date.now() - startTime;

                if (code === 0) {
                    resolve({
                        testFile,
                        testName,
                        status: "passed",
                        duration,
                    });
                } else {
                    const error = this.parseError(stderr || stdout);
                    resolve({
                        testFile,
                        testName,
                        status: "failed",
                        duration,
                        error,
                    });
                }
            });

            child.on("error", (err) => {
                clearTimeout(timeoutId);
                resolve({
                    testFile,
                    testName,
                    status: "error",
                    duration: Date.now() - startTime,
                    error: {
                        message: err.message,
                    },
                });
            });
        });
    }

    /**
     * Parse Playwright JSON reporter output.
     */
    private parseJsonOutput(output: string, testFile: string, fallbackDuration: number): TestRunResult[] {
        const results: TestRunResult[] = [];

        try {
            // Find JSON in output (might have other text around it)
            const jsonMatch = output.match(/\{[\s\S]*"suites"[\s\S]*\}/);
            if (!jsonMatch) return results;

            const json = JSON.parse(jsonMatch[0]);

            for (const suite of json.suites || []) {
                for (const spec of suite.specs || []) {
                    for (const test of spec.tests || []) {
                        const result = test.results?.[0];
                        if (!result) continue;

                        const status =
                            result.status === "passed"
                                ? "passed"
                                : result.status === "timedOut"
                                  ? "timeout"
                                  : "failed";

                        const testResult: TestRunResult = {
                            testFile,
                            testName: spec.title,
                            status,
                            duration: result.duration || fallbackDuration,
                        };

                        if (status !== "passed" && result.error) {
                            testResult.error = {
                                message: result.error.message || "Unknown error",
                                stack: result.error.stack,
                                selector: this.extractSelectorFromError(result.error.message || "") || undefined,
                            };
                        }

                        results.push(testResult);
                    }
                }
            }
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
