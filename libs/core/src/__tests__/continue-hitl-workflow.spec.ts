import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testExecutionService } from "../testing/test-execution-service";
import {
    advanceHitlWorkflow,
    continueHitlWorkflow,
    persistHitlPauseWorkflow,
    WorkflowStore,
} from "../workflows";

const projects: string[] = [];

async function makeProject(): Promise<string> {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-hitl-workflow-"));
    projects.push(project);
    return project;
}

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(projects.splice(0).map((project) => fs.rm(project, { recursive: true })));
});

describe("durable HITL continuation", () => {
    it("persists a save pause and completes an approved save", async () => {
        const projectPath = await makeProject();
        const workflow = await persistHitlPauseWorkflow({
            projectPath,
            origin: "repl",
            repairAttempts: 0,
            shouldRunTests: false,
            hitlActions: [
                {
                    type: "save",
                    timestamp: Date.now(),
                    testCode: 'test("works", async () => {});',
                    suggestedPath: "e2e/example.spec.ts",
                    testName: "example",
                },
            ],
        });
        expect(workflow).toMatchObject({ status: "await_save_approval", pendingAction: "save" });

        const result = await continueHitlWorkflow({
            projectPath,
            workflowId: workflow?.id ?? "",
            action: "save",
            decision: "approve",
        });

        expect(result.workflow.status).toBe("completed");
        await expect(
            fs.readFile(path.join(projectPath, "e2e/example.spec.ts"), "utf-8"),
        ).resolves.toContain('test("works"');
    });

    it("cancels a rejected workflow without writing its draft", async () => {
        const projectPath = await makeProject();
        const workflow = await new WorkflowStore(projectPath).create({
            kind: "test_generate_repair",
            status: "await_save_approval",
            origin: "dashboard",
            testDraft: "do not write",
            savedTestPath: "e2e/rejected.spec.ts",
            shouldRunTests: false,
            repairAttempts: 0,
            pendingAction: "save",
        });

        const result = await continueHitlWorkflow({
            projectPath,
            workflowId: workflow.id,
            action: "save",
            decision: "reject",
        });

        expect(result.workflow.status).toBe("cancelled");
        await expect(fs.access(path.join(projectPath, "e2e/rejected.spec.ts"))).rejects.toThrow();
    });

    it("uses the canonical user-run service for approved workflow runs", async () => {
        const projectPath = await makeProject();
        // The saved spec must exist on disk — approving a run for a deleted
        // file now fails loudly instead of "completing" an empty run.
        await fs.mkdir(path.join(projectPath, "e2e"), { recursive: true });
        await fs.writeFile(
            path.join(projectPath, "e2e/approved.spec.ts"),
            'import { test, expect } from "@playwright/test";\ntest("approved", () => expect(1).toBe(1));\n',
        );
        const workflow = await new WorkflowStore(projectPath).create({
            kind: "test_generate_repair",
            status: "await_run_approval",
            origin: "repl",
            savedTestPath: "e2e/approved.spec.ts",
            shouldRunTests: true,
            repairAttempts: 0,
            pendingAction: "run",
        });
        const run = vi.spyOn(testExecutionService, "run").mockResolvedValue({
            runId: "run-1",
            success: true,
            exitCode: 0,
            stdout: "",
            stderr: "",
            results: {},
            parsedRun: {
                tests: [
                    {
                        id: "approved",
                        name: "approved",
                        suite: "e2e/approved.spec.ts",
                        status: "passed",
                        duration: 5,
                    },
                ],
                summary: {
                    suites: { passed: 1, failed: 0, total: 1 },
                    tests: { passed: 1, failed: 0, total: 1 },
                    timeSeconds: 0.005,
                },
            },
        });

        const result = await continueHitlWorkflow({
            projectPath,
            workflowId: workflow.id,
            action: "run",
            decision: "approve",
        });

        expect(run).toHaveBeenCalledWith(
            projectPath,
            { testFile: "e2e/approved.spec.ts" },
            { operationHeld: true },
        );
        expect(result.workflow).toMatchObject({
            status: "completed",
            runSummary: { passed: true, failureCount: 0 },
        });
    });

    it("resumes an interrupted repair and completes after verification passes", async () => {
        const projectPath = await makeProject();
        await fs.mkdir(path.join(projectPath, "e2e"), { recursive: true });
        await fs.writeFile(path.join(projectPath, "e2e/failing.spec.ts"), "old test");
        const workflow = await new WorkflowStore(projectPath).create({
            kind: "test_generate_repair",
            status: "repairing",
            origin: "dashboard",
            savedTestPath: "e2e/failing.spec.ts",
            testName: "failing",
            shouldRunTests: true,
            repairAttempts: 0,
            autonomy: { autoCorrect: "apply", maxRetries: 2, autoLearn: "off" },
            lastRunResults: [
                {
                    testFile: "e2e/failing.spec.ts",
                    testName: "failing",
                    status: "failed",
                    duration: 1,
                    error: { message: "failed assertion" },
                },
            ],
        });

        const completed = await advanceHitlWorkflow(
            { projectPath, workflowId: workflow.id },
            {
                model: {} as never,
                repairAttempt: async () => ({
                    repairAttempts: 1,
                    // Must be real, parseable test code — the save pipeline
                    // now validates every write.
                    fixedCode:
                        'import { test, expect } from "@playwright/test";\ntest("failing", () => expect(1).toBe(1));\n',
                    summary: "fixed",
                }),
                executeRun: async () => ({
                    success: true,
                    message: "passed",
                    results: [
                        {
                            testFile: "e2e/failing.spec.ts",
                            testName: "failing",
                            status: "passed",
                            duration: 1,
                        },
                    ],
                }),
            },
        );

        expect(completed).toMatchObject({
            status: "completed",
            repairAttempts: 1,
            runSummary: { passed: true, failureCount: 0 },
        });
        await expect(
            fs.readFile(path.join(projectPath, "e2e/failing.spec.ts"), "utf-8"),
        ).resolves.toContain('test("failing"');
    });

    it("fails an approved run whose saved file was deleted, without running", async () => {
        const projectPath = await makeProject();
        const workflow = await new WorkflowStore(projectPath).create({
            kind: "test_generate_repair",
            status: "await_run_approval",
            origin: "dashboard",
            savedTestPath: "e2e/gone.spec.ts",
            shouldRunTests: true,
            repairAttempts: 0,
            pendingAction: "run",
        });
        const run = vi.spyOn(testExecutionService, "run");

        const result = await continueHitlWorkflow({
            projectPath,
            workflowId: workflow.id,
            action: "run",
            decision: "approve",
        });

        expect(result.workflow.status).toBe("failed");
        expect(result.workflow.statusMessage).toContain("no longer exists");
        expect(run).not.toHaveBeenCalled();
    });

    it("treats a run that executed zero tests as inconclusive, not completed", async () => {
        const projectPath = await makeProject();
        await fs.mkdir(path.join(projectPath, "e2e"), { recursive: true });
        await fs.writeFile(
            path.join(projectPath, "e2e/empty.spec.ts"),
            'import { test, expect } from "@playwright/test";\ntest("empty", () => expect(1).toBe(1));\n',
        );
        const workflow = await new WorkflowStore(projectPath).create({
            kind: "test_generate_repair",
            status: "await_run_approval",
            origin: "dashboard",
            savedTestPath: "e2e/empty.spec.ts",
            shouldRunTests: true,
            repairAttempts: 0,
            pendingAction: "run",
        });
        vi.spyOn(testExecutionService, "run").mockResolvedValue({
            runId: "run-empty",
            success: false,
            exitCode: 1,
            stdout: "",
            stderr: "",
            results: {},
            parsedRun: {
                tests: [],
                summary: {
                    suites: { passed: 0, failed: 0, total: 0 },
                    tests: { passed: 0, failed: 0, total: 0 },
                    timeSeconds: 0,
                },
            },
        });

        const result = await continueHitlWorkflow({
            projectPath,
            workflowId: workflow.id,
            action: "run",
            decision: "approve",
        });

        expect(result.workflow.status).toBe("failed");
        expect(result.workflow.statusMessage).toContain("executed no tests");
    });

    it("rejects a decision computed against a stale workflow snapshot (CAS)", async () => {
        const projectPath = await makeProject();
        const workflow = await new WorkflowStore(projectPath).create({
            kind: "test_generate_repair",
            status: "await_save_approval",
            origin: "dashboard",
            testDraft:
                'import { test, expect } from "@playwright/test";\ntest("stale", () => expect(1).toBe(1));\n',
            savedTestPath: "e2e/stale.spec.ts",
            shouldRunTests: false,
            repairAttempts: 0,
            pendingAction: "save",
        });

        // A concurrent decision lands first (e.g. the CLI while the dashboard
        // had the record loaded). The lease-first re-validation must reject
        // the in-flight approve — the cancelled record can't be resurrected.
        await new WorkflowStore(projectPath).update(workflow.id, {
            status: "cancelled",
            pendingAction: undefined,
        });

        await expect(
            continueHitlWorkflow({
                projectPath,
                workflowId: workflow.id,
                action: "save",
                decision: "approve",
            }),
        ).rejects.toThrow(/not awaiting a save decision/);
        // The cancelled record stays cancelled — no resurrection.
        const after = await new WorkflowStore(projectPath).load(workflow.id);
        expect(after?.status).toBe("cancelled");
        // And nothing was written to disk.
        await expect(fs.access(path.join(projectPath, "e2e/stale.spec.ts"))).rejects.toThrow();
    });

    it("rejects a store update whose expected snapshot went stale (CAS)", async () => {
        const projectPath = await makeProject();
        const store = new WorkflowStore(projectPath);
        const workflow = await store.create({
            kind: "test_generate_repair",
            status: "await_save_approval",
            origin: "dashboard",
            testDraft: "draft",
            savedTestPath: "e2e/cas.spec.ts",
            shouldRunTests: false,
            repairAttempts: 0,
            pendingAction: "save",
        });

        // Another writer moves the record on between our load and update.
        await store.update(workflow.id, { statusMessage: "touched" });

        await expect(
            store.update(
                workflow.id,
                { status: "cancelled", pendingAction: undefined },
                { expectedUpdatedAt: workflow.updatedAt },
            ),
        ).rejects.toThrow(/changed while the decision was in flight/);
    });
});
