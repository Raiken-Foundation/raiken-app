import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentMemory } from "../agent/memory";
import { loadAutonomyConfig, loadTestDirectory, resolvePathWithinProject } from "../config";
import { writeFileAtomic } from "../io/atomic-write";
import { mergeCorrelationContext, obs, runDetachedOperation } from "../observability";
import { acquireProjectOperation, type ProjectOperationLease } from "../operations";
import { RunTraceRecorder } from "../run-traces";
import { WorkflowStore } from "../workflows/workflow-store";
import { findPlaywrightConfigPath, writePlaywrightConfig } from "./playwright-config";
import {
    extractReporterJson,
    type ListedPlaywrightTest,
    listTestsFromReport,
    mapReportToTestRunResults,
    mapTestRunResultsToParsedRun,
} from "./playwright-json-report";
import {
    playwrightJsonReporterEnv,
    runnerPlaywrightSpawnOptions,
    runPlaywrightSubprocess,
} from "./playwright-subprocess";
import { sweepStaleRunSpecs } from "./raiken-temp-specs";
import type { ParsedPlaywrightRun } from "./report-parser";
import { isTestRunSuccessful, summarizeParsedPlaywrightRun } from "./run-outcome";
import { prepareTestArtifactContent } from "./save-test-artifact";

export interface TestExecutionInput {
    testFile?: string;
    /**
     * Run several spec files in one Playwright invocation. Takes precedence
     * over `testFile` when non-empty (used by quarantine filtering, which
     * must exclude individual specs from a full-suite run).
     */
    testFiles?: string[];
    testName?: string;
    workers?: number;
    inlineContent?: string;
    inlineFileName?: string;
    signal?: AbortSignal;
    headed?: boolean;
    /** Restrict to one Playwright project (browser) from the config. */
    project?: string;
    retries?: number;
    updateSnapshots?: boolean;
    /** Discover tests without executing them (`playwright test --list`). */
    listOnly?: boolean;
    /** Extra raw Playwright CLI arguments appended verbatim after ours. */
    extraArgs?: string[];
}

export interface TestExecutionResult {
    runId: string;
    success: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    results: unknown;
    parsedRun?: ParsedPlaywrightRun | null;
    /** Populated instead of `parsedRun` when the run was `--list` only. */
    listedTests?: ListedPlaywrightTest[];
    busy?: boolean;
    cancelled?: boolean;
}

/**
 * Build the Playwright CLI argv for a run — pure so the CLI flags we expose
 * (`--headed`, `--project`, `--retries`, …) can be verified without spawning
 * a browser. Kept in lockstep with `TestExecutionInput`.
 */
export function buildTestRunArgs(options: {
    targets: string[];
    input: TestExecutionInput;
    configPath: string | null;
}): string[] {
    const { targets, input, configPath } = options;
    const args = ["playwright", "test"];
    args.push(...targets);
    if (input.listOnly) args.push("--list");
    if (input.testName) args.push("-g", input.testName);
    args.push(`--workers=${input.workers ?? 1}`, "--reporter=json");
    if (input.headed) args.push("--headed");
    if (input.project) args.push(`--project=${input.project}`);
    if (typeof input.retries === "number" && input.retries >= 0) {
        args.push(`--retries=${input.retries}`);
    }
    if (input.updateSnapshots) args.push("--update-snapshots");
    if (configPath) args.push("--config", configPath);
    if (input.extraArgs?.length) args.push(...input.extraArgs);
    return args;
}

export interface TestExecutionRuntimeOptions {
    /** The caller already owns the project's test operation lease. */
    operationHeld?: boolean;
}

interface ActiveTestRun {
    runId: string;
    abort: AbortController;
}

const timeoutMs = 5 * 60 * 1000;

export class TestExecutionService {
    private readonly active = new Map<string, ActiveTestRun>();

    getActiveRun(projectPath: string): { runId: string } | null {
        const run = this.active.get(path.resolve(projectPath));
        return run ? { runId: run.runId } : null;
    }

    cancel(projectPath: string, runId?: string): boolean {
        const active = this.active.get(path.resolve(projectPath));
        if (!active || (runId && active.runId !== runId)) return false;
        active.abort.abort();
        return true;
    }

    async run(
        projectPath: string,
        input: TestExecutionInput,
        runtime: TestExecutionRuntimeOptions = {},
    ): Promise<TestExecutionResult> {
        const projectKey = path.resolve(projectPath);
        const runId = randomUUID();
        if (this.active.has(projectKey)) return this.busy(runId);

        return runDetachedOperation({ runId, projectPath }, async () => {
            mergeCorrelationContext({ runId, projectPath });
            const trace = RunTraceRecorder.forOperational(projectPath, "test", { runId });
            const startedAt = Date.now();
            obs.info("test.run.started", { runId, meta: { testFile: input.testFile } });

            const abort = new AbortController();
            const onExternalAbort = () => abort.abort();
            input.signal?.addEventListener("abort", onExternalAbort, { once: true });
            if (input.signal?.aborted) abort.abort();
            this.active.set(projectKey, { runId, abort });

            let lease: ProjectOperationLease | undefined;
            let tempFile: string | null = null;
            try {
                if (!runtime.operationHeld) {
                    lease = await acquireProjectOperation(projectPath, "test", abort.signal);
                }
                let configPath = await findPlaywrightConfigPath(projectPath);
                if (!configPath) {
                    const created = await writePlaywrightConfig(projectPath, { testDir: "./e2e" });
                    if (created.success) configPath = created.path;
                }

                let target = input.testFile;
                if (input.inlineContent !== undefined) {
                    const cleaned = prepareTestArtifactContent(input.inlineContent);
                    const scratch = !input.testFile || input.testFile.startsWith("scratch:");
                    if (!scratch && input.testFile) {
                        const resolved = resolvePathWithinProject(projectPath, input.testFile);
                        await writeFileAtomic(resolved, cleaned);
                    } else {
                        const directory = loadTestDirectory(projectPath);
                        const rawName = (
                            input.inlineFileName ||
                            input.testFile ||
                            "raiken-scratch"
                        ).replace(/^scratch:/, "");
                        const baseName =
                            path
                                .basename(rawName)
                                .replace(/\.(spec|test)\.(t|j)sx?$/i, "")
                                .replace(/[^a-zA-Z0-9_-]+/g, "-")
                                .replace(/(^-|-$)/g, "") || "raiken-scratch";
                        target = path.join(
                            directory,
                            `${baseName}.raiken-run-${Date.now()}.spec.ts`,
                        );
                        tempFile = resolvePathWithinProject(projectPath, target);
                        await sweepStaleRunSpecs(projectPath, path.dirname(tempFile));
                        await writeFileAtomic(tempFile, cleaned);
                    }
                }
                const result = await this.spawnRun(
                    projectPath,
                    runId,
                    target,
                    input,
                    configPath,
                    abort.signal,
                );
                trace?.end(
                    result.success ? "completed" : "error",
                    result.success ? undefined : result.stderr,
                );
                obs.duration("test.run.completed", startedAt, {
                    runId,
                    status: result.success ? "completed" : "failed",
                    level: result.success ? "info" : "warn",
                });
                return result;
            } catch (error) {
                const cancelled =
                    abort.signal.aborted ||
                    (error instanceof DOMException && error.name === "AbortError");
                trace?.end(
                    cancelled ? "aborted" : "error",
                    error instanceof Error ? error.message : undefined,
                );
                obs.duration("test.run.completed", startedAt, {
                    level: "error",
                    runId,
                    status: cancelled ? "aborted" : "error",
                });
                return {
                    runId,
                    success: false,
                    exitCode: null,
                    stdout: "",
                    stderr: cancelled
                        ? "Test run cancelled."
                        : error instanceof Error
                          ? error.message
                          : "Test execution failed.",
                    results: null,
                    busy: /already active/i.test(error instanceof Error ? error.message : ""),
                    cancelled,
                };
            } finally {
                input.signal?.removeEventListener("abort", onExternalAbort);
                this.active.delete(projectKey);
                if (tempFile) await fs.rm(tempFile, { force: true }).catch(() => undefined);
                await lease?.release();
            }
        });
    }

    private async spawnRun(
        projectPath: string,
        runId: string,
        target: string | undefined,
        input: TestExecutionInput,
        configPath: string | null,
        signal: AbortSignal,
    ): Promise<TestExecutionResult> {
        const targets =
            input.testFiles && input.testFiles.length > 0
                ? input.testFiles
                : target
                  ? [target]
                  : [];
        const args = buildTestRunArgs({ targets, input, configPath });

        const subprocess = await runPlaywrightSubprocess(
            runnerPlaywrightSpawnOptions({
                cwd: projectPath,
                args,
                env: { ...playwrightJsonReporterEnv(), FORCE_COLOR: "0" },
                signal,
                timeoutMs,
            }),
        );

        const parse = (): { results: unknown; parsedRun: ParsedPlaywrightRun | null } => {
            const raw = extractReporterJson(subprocess.stdout);
            if (!raw) return { results: null, parsedRun: null };
            const testFile = target ?? "unknown";
            const runResults = mapReportToTestRunResults(raw, testFile);
            return {
                results: raw,
                parsedRun: mapTestRunResultsToParsedRun(runResults, raw),
            };
        };

        if (subprocess.cancelled) {
            return {
                runId,
                success: false,
                exitCode: null,
                stdout: subprocess.stdout,
                stderr: `${subprocess.stderr}\n[raiken] Test run cancelled.`,
                ...parse(),
                cancelled: true,
            };
        }

        if (subprocess.timedOut) {
            return {
                runId,
                success: false,
                exitCode: null,
                stdout: subprocess.stdout,
                stderr: `${subprocess.stderr}\n[raiken] Test run timed out after ${Math.round(
                    timeoutMs / 1000,
                )}s and was terminated.`,
                ...parse(),
            };
        }

        if (subprocess.spawnError) {
            return {
                runId,
                success: false,
                exitCode: -1,
                stdout: subprocess.stdout,
                stderr: subprocess.spawnError.message,
                results: null,
                parsedRun: null,
            };
        }

        if (input.listOnly) {
            const raw = extractReporterJson(subprocess.stdout);
            return {
                runId,
                success: subprocess.exitCode === 0 && raw !== null,
                exitCode: subprocess.exitCode,
                stdout: subprocess.stdout,
                stderr: subprocess.stderr,
                results: raw,
                parsedRun: null,
                listedTests: raw ? listTestsFromReport(raw) : [],
            };
        }

        const parsed = parse();
        const raw = extractReporterJson(subprocess.stdout);
        const runResults = raw ? mapReportToTestRunResults(raw, target ?? "unknown") : [];
        // A non-zero exit with an all-green report means Playwright failed
        // outside the specs (global teardown, worker crash after flush). Keeping
        // `success` tied to `exitCode` stops those from being reported as a pass.
        const success = isTestRunSuccessful(runResults) && subprocess.exitCode === 0;

        this.recordOutcome(projectPath, input.testFile, parsed.parsedRun);
        void this.reconcileReviewedWorkflow(projectPath, input.testFile, success, parsed.parsedRun);

        return {
            runId,
            success,
            exitCode: subprocess.exitCode,
            stdout: subprocess.stdout,
            stderr: subprocess.stderr,
            ...parsed,
        };
    }

    private recordOutcome(
        projectPath: string,
        testFile: string | undefined,
        run: ParsedPlaywrightRun | null,
    ): void {
        if (!testFile || testFile.startsWith("scratch:") || !run?.tests.length) return;
        if (run.tests.every((test) => test.status === "skipped")) return;
        try {
            if (loadAutonomyConfig(projectPath).autoLearn === "off") return;
            const summary = summarizeParsedPlaywrightRun(run);
            AgentMemory.getInstance(projectPath).recordRunOutcome(testFile, {
                status: summary.memoryStatus,
                durationMs: summary.durationMs,
                errorMessage: summary.errorMessage,
            });
        } catch {
            // Learning is best-effort and cannot change a test run result.
        }
    }

    private async reconcileReviewedWorkflow(
        projectPath: string,
        testFile: string | undefined,
        passed: boolean,
        run: ParsedPlaywrightRun | null,
    ): Promise<void> {
        if (!testFile) return;
        const store = new WorkflowStore(projectPath);
        const workflow = (await store.listActive()).find(
            (candidate) =>
                candidate.status === "await_repair_review" && candidate.savedTestPath === testFile,
        );
        if (!workflow) return;
        const summary = run
            ? summarizeParsedPlaywrightRun(run)
            : { passed, inconclusive: false, failureCount: passed ? 0 : 1 };
        await store.update(workflow.id, {
            status: summary.passed ? "completed" : "await_repair_review",
            lastRunResults: undefined,
            runSummary: {
                passed: summary.passed,
                failureCount: summary.failureCount,
            },
            statusMessage: summary.inconclusive
                ? "The run executed no tests, so the manually reviewed test is still unverified."
                : summary.passed
                  ? "The manually reviewed test now passes."
                  : "The manually reviewed test is still failing.",
        });
    }

    private busy(runId: string): TestExecutionResult {
        return {
            runId,
            success: false,
            exitCode: null,
            stdout: "",
            stderr: "A test run is already in progress for this project.",
            results: null,
            busy: true,
        };
    }
}

export const testExecutionService = new TestExecutionService();
