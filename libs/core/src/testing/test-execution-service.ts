import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentMemory } from "../agent/memory";
import { loadAutonomyConfig, resolvePathWithinProject } from "../config";
import { acquireProjectOperation, type ProjectOperationLease } from "../operations";
import { cleanGeneratedTestCode, readConfiguredTestDirectory } from "../utils";
import { WorkflowStore } from "../workflows/workflow-store";
import { findPlaywrightConfigPath, writePlaywrightConfig } from "./playwright-config";
import { killProcessTree } from "./process-tree";
import { type ParsedPlaywrightRun, parsePlaywrightReport } from "./report-parser";
import { extractReporterJson } from "./runner";

export interface TestExecutionInput {
    testFile?: string;
    testName?: string;
    workers?: number;
    inlineContent?: string;
    inlineFileName?: string;
    signal?: AbortSignal;
}

export interface TestExecutionResult {
    runId: string;
    success: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    results: unknown;
    parsedRun?: ParsedPlaywrightRun | null;
    busy?: boolean;
    cancelled?: boolean;
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

    async run(projectPath: string, input: TestExecutionInput): Promise<TestExecutionResult> {
        const projectKey = path.resolve(projectPath);
        const runId = randomUUID();
        if (this.active.has(projectKey)) return this.busy(runId);

        const abort = new AbortController();
        const onExternalAbort = () => abort.abort();
        input.signal?.addEventListener("abort", onExternalAbort, { once: true });
        if (input.signal?.aborted) abort.abort();
        this.active.set(projectKey, { runId, abort });

        let lease: ProjectOperationLease | undefined;
        let tempFile: string | null = null;
        try {
            lease = await acquireProjectOperation(projectPath, "test", abort.signal);
            let configPath = await findPlaywrightConfigPath(projectPath);
            if (!configPath) {
                const created = await writePlaywrightConfig(projectPath, { testDir: "./e2e" });
                if (created.success) configPath = created.path;
            }

            let target = input.testFile;
            if (input.inlineContent !== undefined) {
                const cleaned = cleanGeneratedTestCode(input.inlineContent);
                const scratch = !input.testFile || input.testFile.startsWith("scratch:");
                if (!scratch && input.testFile) {
                    const resolved = resolvePathWithinProject(projectPath, input.testFile);
                    await this.writeAtomic(resolved, cleaned);
                } else {
                    const directory = readConfiguredTestDirectory(projectPath) || "e2e";
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
                    target = path.join(directory, `${baseName}.raiken-run-${Date.now()}.spec.ts`);
                    tempFile = resolvePathWithinProject(projectPath, target);
                    await this.sweepStale(path.dirname(tempFile));
                    await this.writeAtomic(tempFile, cleaned);
                }
            }
            return await this.spawnRun(projectPath, runId, target, input, configPath, abort.signal);
        } catch (error) {
            const cancelled =
                abort.signal.aborted ||
                (error instanceof DOMException && error.name === "AbortError");
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
    }

    private async spawnRun(
        projectPath: string,
        runId: string,
        target: string | undefined,
        input: TestExecutionInput,
        configPath: string | null,
        signal: AbortSignal,
    ): Promise<TestExecutionResult> {
        return new Promise((resolve) => {
            const args = ["playwright", "test"];
            if (target) args.push(target);
            if (input.testName) args.push("-g", input.testName);
            args.push(`--workers=${input.workers ?? 1}`, "--reporter=json");
            if (configPath) args.push("--config", configPath);
            const child = spawn("npx", args, {
                cwd: projectPath,
                shell: true,
                detached: process.platform !== "win32",
                env: { ...process.env, FORCE_COLOR: "0" },
            });
            let stdout = "";
            let stderr = "";
            let settled = false;
            let killTimer: NodeJS.Timeout | null = null;
            let timer: NodeJS.Timeout;
            child.stdout?.on("data", (data) => {
                stdout += data.toString();
            });
            child.stderr?.on("data", (data) => {
                stderr += data.toString();
            });
            const terminate = () => {
                if (child.pid) killProcessTree(child.pid, "SIGTERM");
                killTimer = setTimeout(() => {
                    if (child.pid) killProcessTree(child.pid, "SIGKILL");
                }, 5000);
            };
            const finish = (result: TestExecutionResult) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                resolve(result);
            };
            const parse = (): {
                results: unknown;
                parsedRun: ParsedPlaywrightRun | null;
            } => {
                const results = extractReporterJson(stdout);
                return {
                    results,
                    parsedRun: results ? parsePlaywrightReport(results) : null,
                };
            };
            const onAbort = () => {
                terminate();
                finish({
                    runId,
                    success: false,
                    exitCode: null,
                    stdout,
                    stderr: `${stderr}\n[raiken] Test run cancelled.`,
                    ...parse(),
                    cancelled: true,
                });
            };
            signal.addEventListener("abort", onAbort, { once: true });
            timer = setTimeout(() => {
                terminate();
                finish({
                    runId,
                    success: false,
                    exitCode: null,
                    stdout,
                    stderr: `${stderr}\n[raiken] Test run timed out after ${Math.round(
                        timeoutMs / 1000,
                    )}s and was terminated.`,
                    ...parse(),
                });
            }, timeoutMs);
            if (signal.aborted) onAbort();
            child.on("close", (code) => {
                if (settled) {
                    if (killTimer) clearTimeout(killTimer);
                    return;
                }
                const parsed = parse();
                this.recordOutcome(projectPath, input.testFile, parsed.parsedRun);
                void this.reconcileReviewedWorkflow(
                    projectPath,
                    input.testFile,
                    code === 0,
                    parsed.parsedRun,
                );
                finish({
                    runId,
                    success: code === 0,
                    exitCode: code,
                    stdout,
                    stderr,
                    ...parsed,
                });
            });
            child.on("error", (error) => {
                if (settled) {
                    if (killTimer) clearTimeout(killTimer);
                    return;
                }
                finish({
                    runId,
                    success: false,
                    exitCode: -1,
                    stdout,
                    stderr: error.message,
                    results: null,
                    parsedRun: null,
                });
            });
        });
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
            const failure = run.tests.find((test) => test.status === "failed");
            AgentMemory.getInstance(projectPath).recordRunOutcome(testFile, {
                status: failure ? "failed" : "passed",
                durationMs: run.tests.reduce((sum, test) => sum + (test.duration || 0), 0),
                errorMessage: failure?.error?.message,
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
        await store.update(workflow.id, {
            status: passed ? "completed" : "await_repair_review",
            lastRunResults: undefined,
            runSummary: {
                passed,
                failureCount: run?.tests.filter((test) => test.status === "failed").length ?? 0,
            },
            statusMessage: passed
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

    private async writeAtomic(target: string, data: string): Promise<void> {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(temporary, data, "utf-8");
        await fs.rename(temporary, target);
    }

    private async sweepStale(directory: string): Promise<void> {
        try {
            const now = Date.now();
            for (const name of await fs.readdir(directory)) {
                const timestamp = Number(name.match(/\.raiken-run-(\d+)\.spec\.ts$/)?.[1]);
                if (Number.isFinite(timestamp) && now - timestamp > 10 * 60 * 1000) {
                    await fs.rm(path.join(directory, name), { force: true });
                }
            }
        } catch {
            // Directory may not exist yet.
        }
    }
}

export const testExecutionService = new TestExecutionService();
