import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
                    fixedCode: "fixed test",
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
        ).resolves.toContain("fixed test");
    });
});
