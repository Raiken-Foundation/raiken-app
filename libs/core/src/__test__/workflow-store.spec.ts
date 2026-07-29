import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "../workflows";

const projects: string[] = [];

async function makeProject(): Promise<string> {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-workflow-"));
    projects.push(project);
    return project;
}

afterEach(async () => {
    await Promise.all(projects.splice(0).map((project) => fs.rm(project, { recursive: true })));
});

describe("WorkflowStore", () => {
    it("writes an atomic, minimal durable HITL continuation record", async () => {
        const project = await makeProject();
        const store = new WorkflowStore(project);
        const workflow = await store.create({
            kind: "test_generate_repair",
            status: "await_run_approval",
            origin: "repl",
            savedTestPath: "e2e/login.spec.ts",
            shouldRunTests: true,
            repairAttempts: 0,
            pendingAction: "run",
        });

        await expect(store.load(workflow.id)).resolves.toMatchObject(workflow);
        await expect(store.listActive()).resolves.toHaveLength(1);

        const saved = await fs.readFile(
            path.join(project, ".raiken", "workflows", `${workflow.id}.json`),
            "utf-8",
        );
        expect(saved).not.toContain("apiKey");
        expect(saved).not.toContain("conversationHistory");
    });

    it("removes terminal records from active workflow discovery", async () => {
        const store = new WorkflowStore(await makeProject());
        const workflow = await store.create({
            kind: "test_generate_repair",
            status: "await_save_approval",
            origin: "dashboard",
            shouldRunTests: false,
            repairAttempts: 0,
            pendingAction: "save",
        });
        await store.update(workflow.id, {
            status: "completed",
            pendingAction: undefined,
            testDraft: "large generated test",
            lastRepairedCode: "temporary repair",
            lastRunResults: [],
        });

        await expect(store.listActive()).resolves.toEqual([]);
        const terminal = await store.load(workflow.id);
        expect(terminal?.status).toBe("completed");
        expect(terminal).not.toHaveProperty("testDraft");
        expect(terminal).not.toHaveProperty("lastRepairedCode");
        expect(terminal).not.toHaveProperty("lastRunResults");
    });
});
