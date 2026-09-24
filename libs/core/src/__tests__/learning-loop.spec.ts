/**
 * Test-outcome learning loop coverage (Phase 2 of the "close partial feature
 * gaps" plan): recordTestGenerated -> recordRunOutcome wiring, dominant
 * selector strategy derivation, and the `autonomy.autoLearn` gate on the
 * agent tools' auto-save/auto-run branches.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentMemory } from "../agent/memory";
import { createAgentTools, type ToolResult } from "../agent/tools";
import { CodeGraphDB } from "../database/db";

// The AI SDK's `tool()` typing allows `execute` to return an async iterable
// (for streaming tools), which none of our tools actually use. Narrow it back
// down here the same way `callTool` in agent.ts does, so tests can call
// `execute` directly without fighting the broader inferred type.
function callToolExecute<T>(fn: unknown, args: unknown): Promise<ToolResult<T>> {
    return (fn as (args: unknown) => Promise<ToolResult<T>>)(args);
}

describe("AgentMemory - test outcome learning loop", () => {
    let testDir: string;
    let memory: AgentMemory;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-learning-"));
        memory = AgentMemory.getInstance(testDir);
    });

    afterEach(() => {
        AgentMemory.clearInstances();
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("attaches a run outcome to the most recently generated test", () => {
        memory.recordTestGenerated("e2e/login.spec.ts", "login", "test login", "test(...)");
        memory.recordRunOutcome("e2e/login.spec.ts", { status: "passed", durationMs: 1200 });

        const testId = memory.getLatestTestOutcomeId("e2e/login.spec.ts");
        if (testId === null) throw new Error("expected a test outcome id");
        const outcome = memory.getTestOutcome(testId);
        expect(outcome?.status).toBe("passed");
    });

    it("re-attaches to the newest generation when a file is regenerated", () => {
        memory.recordTestGenerated("e2e/login.spec.ts", "login", "v1", "test(...)");
        const secondId = memory.recordTestGenerated(
            "e2e/login.spec.ts",
            "login",
            "v2",
            "test(...) v2",
        );

        expect(memory.getLatestTestOutcomeId("e2e/login.spec.ts")).toBe(secondId);

        memory.recordRunOutcome("e2e/login.spec.ts", {
            status: "failed",
            errorMessage: "selector not found",
        });
        const outcome = memory.getTestOutcome(secondId);
        expect(outcome?.status).toBe("failed");
        expect(outcome?.errorMessage).toBe("selector not found");
    });

    it("is a no-op when there is no generation record for the file", () => {
        // Should not throw even though "e2e/never-saved.spec.ts" was never recorded.
        expect(() =>
            memory.recordRunOutcome("e2e/never-saved.spec.ts", { status: "passed" }),
        ).not.toThrow();
    });

    it("derives a dominant selector strategy once there is enough signal", () => {
        expect(memory.getSelectorStrategy()).toBeNull();

        for (let i = 0; i < 12; i++) {
            memory.recordSelectorSuccess(`button ${i}`, `[data-testid="btn-${i}"]`, "data-testid");
        }
        memory.recordSelectorSuccess("link", "text=Sign in", "text");

        memory.updateDominantSelectorStrategy();
        expect(memory.getSelectorStrategy()).toBe("data-testid");
    });

    it("does not set a strategy when there aren't enough recorded samples", () => {
        memory.recordSelectorSuccess("button", '[data-testid="btn"]', "data-testid");
        memory.updateDominantSelectorStrategy();
        expect(memory.getSelectorStrategy()).toBeNull();
    });
});

describe("createAgentTools - autonomy.autoLearn gating", () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-learning-tools-"));
    });

    afterEach(() => {
        AgentMemory.clearInstances();
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("records a generation on auto-save when autoLearn is not 'off'", async () => {
        const tools = createAgentTools({
            projectPath: testDir,
            autonomy: {
                autoSaveTests: true,
                autoRunTests: false,
                autoCorrect: "suggest",
                autoLearn: "auto",
                maxRetries: 2,
            },
        });

        const result = await callToolExecute(tools.saveFile.execute, {
            filePath: "e2e/example.spec.ts",
            content: "test('example', async () => {});",
            testName: "example",
        });
        expect(result.success).toBe(true);

        const memory = AgentMemory.getInstance(testDir);
        expect(memory.getLatestTestOutcomeId("e2e/example.spec.ts")).not.toBeNull();
    });

    it("does not record a generation when autoLearn is 'off'", async () => {
        const tools = createAgentTools({
            projectPath: testDir,
            autonomy: {
                autoSaveTests: true,
                autoRunTests: false,
                autoCorrect: "suggest",
                autoLearn: "off",
                maxRetries: 2,
            },
        });

        const result = await callToolExecute(tools.saveFile.execute, {
            filePath: "e2e/example.spec.ts",
            content: "test('example', async () => {});",
            testName: "example",
        });
        expect(result.success).toBe(true);

        const memory = AgentMemory.getInstance(testDir);
        expect(memory.getLatestTestOutcomeId("e2e/example.spec.ts")).toBeNull();
    });

    it("does not double-record when saveFile requires HITL confirmation", async () => {
        const tools = createAgentTools({
            projectPath: testDir,
            autonomy: {
                autoSaveTests: false,
                autoRunTests: false,
                autoCorrect: "suggest",
                autoLearn: "auto",
                maxRetries: 2,
            },
        });

        const result = await callToolExecute(tools.saveFile.execute, {
            filePath: "e2e/example.spec.ts",
            content: "test('example', async () => {});",
            testName: "example",
        });
        expect(result.hitlRequired).toBe(true);

        // Nothing was actually written to disk or recorded yet — recording
        // only happens once the file is truly saved (auto-save branch here,
        // or the dashboard's saveGeneratedTest procedure for HITL-confirmed
        // saves), never at the point a confirmation is merely proposed.
        const memory = AgentMemory.getInstance(testDir);
        expect(memory.getLatestTestOutcomeId("e2e/example.spec.ts")).toBeNull();
    });

    it("rejects runTest paths that escape the project root before requesting approval", async () => {
        const tools = createAgentTools({
            projectPath: testDir,
            autonomy: {
                autoSaveTests: false,
                autoRunTests: false,
                autoCorrect: "suggest",
                autoLearn: "off",
                maxRetries: 2,
            },
        });

        const result = await callToolExecute(tools.runTest.execute, {
            testFile: "../outside.spec.ts",
        });

        expect(result.success).toBe(false);
        expect(result.hitlRequired).toBeUndefined();
        expect(result.message).toContain("Path traversal denied");
    });
});

describe("CodeGraphDB - selector strategy aggregation", () => {
    let testDir: string;
    let db: CodeGraphDB;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-selector-agg-"));
        db = new CodeGraphDB(testDir);
    });

    afterEach(() => {
        db.close();
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("returns null when there is no selector history", () => {
        expect(db.getDominantSelectorType()).toBeNull();
    });

    it("returns null when the leading type loses more than it wins", () => {
        db.recordSelectorFailure("button", ".btn", "css");
        db.recordSelectorFailure("button", ".btn", "css");
        db.recordSelectorSuccess("button", ".btn", "css");
        expect(db.getDominantSelectorType()).toBeNull();
    });

    it("picks the type with the most aggregate successes", () => {
        db.recordSelectorSuccess("a", '[data-testid="a"]', "data-testid");
        db.recordSelectorSuccess("b", '[data-testid="b"]', "data-testid");
        db.recordSelectorSuccess("c", "role=button", "role");
        const dominant = db.getDominantSelectorType();
        expect(dominant?.type).toBe("data-testid");
        expect(dominant?.successCount).toBe(2);
    });
});
