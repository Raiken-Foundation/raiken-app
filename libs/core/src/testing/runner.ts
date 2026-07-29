import { spawn } from "node:child_process";
import * as path from "node:path";
import { findPlaywrightConfigPath } from "./playwright-config";
import { killProcessTree } from "./process-tree";
import type { ReportAttachment } from "./report-parser";
import { TestStorage } from "./storage";

/**
 * Result of running a single test
 */
export interface TestRunResult {
    testFile: string;
    testName: string;
    /**
     * `"flaky"` means the same spec both passed and failed within one
     * invocation — across Playwright retries or `--repeat-each` repetitions.
     * It is deliberately NOT `"passed"`: every caller checks
     * `status === "passed"`, so an intermittent test can never be reported as
     * a green run or as a successful repair.
     */
    status: "passed" | "failed" | "error" | "timeout" | "skipped" | "flaky";
    duration: number;
    error?: {
        message: string;
        stack?: string;
        selector?: string;
    };
    /**
     * Screenshots/videos/traces Playwright attached to this attempt. Carried
     * through so `raiken ci` results can feed the same report writer that
     * `raiken report` uses, without CI runs silently losing artifacts.
     */
    attachments?: ReportAttachment[];
}

/** Minimal shape of the Playwright JSON reporter output we consume. */
interface PlaywrightJsonResult {
    status?: string;
    duration?: number;
    error?: { message?: string; stack?: string };
    attachments?: Array<{ name?: string; contentType?: string; path?: string; body?: string }>;
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

/** A verdict that is neither a pass nor a deliberate skip. */
function isFailureStatus(status: TestRunResult["status"]): boolean {
    return status !== "passed" && status !== "skipped";
}

/**
 * Collapse repetitions of the same test into one verdict.
 *
 * `--repeat-each` does not add attempts inside a spec — Playwright reports each
 * repetition as its own spec entry, so a run of the same test that passed once
 * and failed once arrives here as two independent results. Left unmerged, a
 * caller counting statuses sees "1 passed, 1 failed" for a single test, and the
 * `flaky` verdict that repair verification depends on is never reached.
 */
function mergeRepetitions(results: TestRunResult[]): TestRunResult[] {
    const order: string[] = [];
    const groups = new Map<string, TestRunResult[]>();

    for (const result of results) {
        const key = `${result.testFile}\u0000${result.testName}`;
        const group = groups.get(key);
        if (group) {
            group.push(result);
        } else {
            groups.set(key, [result]);
            order.push(key);
        }
    }

    return order.map((key) => {
        const group = groups.get(key) as TestRunResult[];
        if (group.length === 1) return group[0];

        const statuses = group.map((r) => r.status);
        const failing = statuses.filter(isFailureStatus);
        const unstable =
            statuses.includes("flaky") ||
            (failing.length > 0 && statuses.some((s) => s === "passed"));

        let status: TestRunResult["status"];
        if (unstable) status = "flaky";
        else if (failing.length > 0) status = failing[0];
        else if (statuses.includes("passed")) status = "passed";
        else status = "skipped";

        // Report the whole verification, not one repetition of it.
        const duration = group.reduce((total, r) => total + (r.duration || 0), 0);
        const merged: TestRunResult = { ...group[0], status, duration };

        const failure = group.find((r) => r.error);
        if (isFailureStatus(status) && failure?.error) merged.error = failure.error;
        else if (!isFailureStatus(status)) delete merged.error;

        const withAttachments = group.find((r) => r.attachments?.length);
        if (withAttachments?.attachments) merged.attachments = withAttachments.attachments;

        return merged;
    });
}

/** Map one Playwright attempt status onto our result vocabulary. */
function mapAttemptStatus(status: string | undefined): TestRunResult["status"] {
    if (status === "passed") return "passed";
    if (status === "timedOut") return "timeout";
    if (status === "skipped") return "skipped";
    return "failed";
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

        // Resolve the project's actual Playwright config explicitly instead
        // of relying on Playwright's own cwd-based auto-discovery, which
        // silently falls back to built-in defaults (wrong testDir/baseURL)
        // for monorepos where the config lives in a package subdirectory
        // rather than at `this.projectPath`. Shared with the dashboard's
        // `runTests` tRPC procedure so both code paths resolve identically.
        const configPath = await findPlaywrightConfigPath(this.projectPath);

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

            if (configPath) {
                args.push("--config", configPath);
            }

            // Explicit `--retries` overrides whatever the project config sets.
            // Zero makes the run evidence: nothing is retried, so the reported
            // outcome is the outcome of a single honest attempt.
            if (typeof retries === "number" && retries >= 0) {
                args.push(`--retries=${retries}`);
            }

            if (typeof repeatEach === "number" && repeatEach > 1) {
                args.push(`--repeat-each=${repeatEach}`);
            }

            if (headed) {
                args.push("--headed");
            }

            // Guarantee the JSON reporter writes to stdout (which we parse
            // below) instead of a file. If the parent process's environment
            // has `PLAYWRIGHT_JSON_OUTPUT_NAME` set (some CI setups do this
            // globally), Playwright silently redirects the JSON report to
            // that file, stdout ends up empty, and we'd otherwise fall back
            // to guessing pass/fail from the exit code alone.
            const env = { ...process.env };
            delete env["PLAYWRIGHT_JSON_OUTPUT_NAME"];

            const child = spawn("npx", args, {
                cwd: this.projectPath,
                shell: true,
                // See killProcessTree() docs: shell:true means signals to
                // `child` don't reach the real Playwright/browser tree, so we
                // make it its own process group (POSIX) to enable group-kill.
                detached: process.platform !== "win32",
                env,
            });

            let stdout = "";
            let stderr = "";

            child.stdout?.on("data", (data) => {
                stdout += data.toString();
            });

            child.stderr?.on("data", (data) => {
                stderr += data.toString();
            });

            // Guards so the timeout, abort, and close/error handlers can't both settle
            // the promise (which would push duplicate results).
            let settled = false;
            let killTimer: NodeJS.Timeout | null = null;

            const settleCancelled = () => {
                if (settled) return;
                settled = true;
                results.push({
                    testFile,
                    testName: this.extractTestName(testFile),
                    status: "error",
                    duration: Date.now() - startTime,
                    error: { message: "Operation cancelled" },
                });
                resolve(results);
            };

            const terminateProcessTree = () => {
                if (child.pid) killProcessTree(child.pid, "SIGTERM");
                killTimer = setTimeout(() => {
                    if (child.pid) killProcessTree(child.pid, "SIGKILL");
                }, 5000);
            };

            let timeoutId: ReturnType<typeof setTimeout>;

            const onAbort = () => {
                clearTimeout(timeoutId);
                terminateProcessTree();
                settleCancelled();
            };

            if (signal) {
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
            }

            // Handle timeout
            timeoutId = setTimeout(() => {
                // Ask the process TREE to terminate (not just the shell
                // wrapper); if it ignores SIGTERM (hung driver/browser),
                // escalate to SIGKILL so we don't leave orphaned
                // npx/Chromium processes accumulating across runs.
                terminateProcessTree();
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

            const cleanup = () => {
                clearTimeout(timeoutId);
                if (killTimer) clearTimeout(killTimer);
                signal?.removeEventListener("abort", onAbort);
            };

            child.on("close", (code) => {
                cleanup();
                if (settled) return;
                settled = true;
                const duration = Date.now() - startTime;

                // Try to parse JSON reporter output
                const parsed = this.parseJsonOutput(stdout, testFile, duration);
                if (parsed.length > 0) {
                    resolve(parsed);
                    return;
                }

                // No parsable JSON report. Even if Playwright exited 0, we have
                // no actual evidence any test ran or passed — a config error,
                // a redirected reporter, or a crash before the reporter flushed
                // could all produce exit code 0 with empty/garbage stdout. Prior
                // behavior blindly reported "passed" here, which is a false
                // positive that can hide real breakage. Report "error" instead
                // so callers surface it rather than silently trusting a green
                // run with zero verifiable data.
                if (code === 0) {
                    results.push({
                        testFile,
                        testName: this.extractTestName(testFile),
                        status: "error",
                        duration,
                        error: {
                            message:
                                "Playwright exited successfully but produced no parsable JSON report — cannot confirm the test actually ran. Check for a misconfigured reporter (e.g. PLAYWRIGHT_JSON_OUTPUT_NAME redirecting output to a file) or a crash before results were flushed.",
                            stack: (stderr || stdout).slice(0, 2000),
                        },
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
                cleanup();
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
                        const testResult = this.summarizeSpec(spec, testFile, fallbackDuration);
                        if (testResult) results.push(testResult);
                    }
                    if (suite.suites) walkSuites(suite.suites);
                }
            };

            walkSuites(json.suites || []);
            return mergeRepetitions(results);
        } catch {
            // Invalid JSON output
        }

        return results;
    }

    /**
     * Collapse every attempt Playwright recorded for one spec into a single
     * verdict.
     *
     * The reporter nests attempts twice: `spec.tests` holds one entry per
     * project × `--repeat-each` repetition, and each entry's `results` holds
     * one per retry. Reading only the last attempt of the flattened list —
     * the previous behavior — reports `passed` for a spec that failed and
     * then passed, no matter which layer the pass came from.
     *
     * For a repair verification that is the difference between a fix and the
     * appearance of one, so a mixed set of outcomes is reported as `flaky`
     * (never `passed`) and keeps the failing attempt's error, giving the
     * repair loop the actual reason instead of a green light.
     */
    private summarizeSpec(
        spec: PlaywrightJsonSpec,
        testFile: string,
        fallbackDuration: number,
    ): TestRunResult | null {
        const attemptGroups = (spec.tests ?? [])
            .map((test) => test.results ?? [])
            .filter((group) => group.length > 0);
        const attempts = attemptGroups.flat();
        if (attempts.length === 0) return null;
        const last = attempts[attempts.length - 1];

        const isFailure = isFailureStatus;

        // One verdict per repetition, taken from its final retry — the same
        // rule Playwright applies when it prints a run summary.
        const perRepetition = attemptGroups.map((group) =>
            mapAttemptStatus(group[group.length - 1].status),
        );
        // A repetition that only went green because an earlier retry was
        // discarded is itself unstable, even though its final attempt passed.
        const passedOnRetry = attemptGroups.some(
            (group) =>
                mapAttemptStatus(group[group.length - 1].status) === "passed" &&
                group.slice(0, -1).some((attempt) => isFailure(mapAttemptStatus(attempt.status))),
        );

        const failing = perRepetition.filter(isFailure);
        const anyPassed = perRepetition.includes("passed");

        let status: TestRunResult["status"];
        if (failing.length > 0 && (anyPassed || passedOnRetry)) {
            status = "flaky";
        } else if (failing.length > 0) {
            status = failing[0];
        } else if (passedOnRetry) {
            status = "flaky";
        } else if (anyPassed) {
            status = "passed";
        } else {
            status = "skipped";
        }

        const testResult: TestRunResult = {
            testFile,
            testName: spec.title,
            status,
            duration: last.duration || fallbackDuration,
        };

        if (isFailure(status)) {
            const failure = attempts.find((attempt) => attempt.error) || last;
            if (failure.error) {
                testResult.error = {
                    message: failure.error.message || "Unknown error",
                    stack: failure.error.stack,
                    selector:
                        this.extractSelectorFromError(failure.error.message || "") || undefined,
                };
            }
        }

        // Attachments live on the LAST attempt (retries reuse the same
        // artifact slots), matching the attempt we read duration from.
        if (last.attachments && last.attachments.length > 0) {
            testResult.attachments = last.attachments.map((att) => ({
                name: att.name ?? "",
                contentType: att.contentType ?? "",
                path: att.path,
                body: att.body,
            }));
        }

        return testResult;
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
