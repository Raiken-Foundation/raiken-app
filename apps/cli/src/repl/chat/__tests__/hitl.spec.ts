import { describe, expect, it, vi } from "vitest";
import { handleRunApproval, handleSaveApproval } from "../hitl";
import type { ChatReplContext } from "../types";

describe("HITL approval handlers", () => {
    it("auto-saves when permission mode allows", async () => {
        const saveGeneratedTest = vi.fn().mockResolvedValue({ filePath: "/tests/login.spec.ts" });
        const runTests = vi.fn().mockResolvedValue({
            success: true,
            results: { stats: { expected: 1, unexpected: 0 } },
        });
        const ctx = {
            state: { permissionMode: "auto-run" },
            app: {
                testing: { saveGeneratedTest, runTests },
            },
            askCancelable: vi.fn(),
        } as unknown as ChatReplContext;

        await handleSaveApproval(ctx, {
            testCode: "test('x', () => {})",
            suggestedPath: "tests/login.spec.ts",
        });

        expect(saveGeneratedTest).toHaveBeenCalled();
        expect(runTests).toHaveBeenCalledWith({ testFile: "/tests/login.spec.ts" });
    });

    it("advances the durable workflow for automatic save and run", async () => {
        const continueHitl = vi
            .fn()
            .mockResolvedValueOnce({
                savedPath: "tests/login.spec.ts",
                workflow: { status: "await_run_approval" },
            })
            .mockResolvedValueOnce({
                run: { success: true, results: [] },
                workflow: { status: "completed" },
            });
        const saveGeneratedTest = vi.fn();
        const runTests = vi.fn();
        const ctx = {
            state: { permissionMode: "auto-run" },
            app: {
                hitl: { continue: continueHitl },
                testing: { saveGeneratedTest, runTests },
            },
            askCancelable: vi.fn(),
        } as unknown as ChatReplContext;

        await handleSaveApproval(ctx, {
            testCode: "test('x', () => {})",
            suggestedPath: "tests/login.spec.ts",
            context: { workflowId: "wf-1" },
        });

        expect(continueHitl).toHaveBeenNthCalledWith(1, {
            workflowId: "wf-1",
            action: "save",
            decision: "approve",
            filePath: "tests/login.spec.ts",
        });
        expect(continueHitl).toHaveBeenNthCalledWith(2, {
            workflowId: "wf-1",
            action: "run",
            decision: "approve",
        });
        expect(saveGeneratedTest).not.toHaveBeenCalled();
        expect(runTests).not.toHaveBeenCalled();
    });

    it("rejects a durable save workflow when the prompt is cancelled", async () => {
        const continueHitl = vi.fn();
        const ctx = {
            state: { permissionMode: "ask" },
            app: {
                hitl: { continue: continueHitl },
                testing: { saveGeneratedTest: vi.fn(), runTests: vi.fn() },
            },
            askCancelable: vi.fn().mockResolvedValue(null),
        } as unknown as ChatReplContext;

        await handleSaveApproval(ctx, {
            testCode: "test('x', () => {})",
            suggestedPath: "tests/login.spec.ts",
            context: { workflowId: "wf-cancel" },
        });

        expect(continueHitl).toHaveBeenCalledWith({
            workflowId: "wf-cancel",
            action: "save",
            decision: "reject",
        });
    });

    it("rejects run approval when user says no", async () => {
        const continueHitl = vi.fn();
        const ctx = {
            state: { permissionMode: "ask" },
            app: { hitl: { continue: continueHitl }, testing: { runTests: vi.fn() } },
            askCancelable: vi.fn().mockResolvedValue("n"),
        } as unknown as ChatReplContext;

        await handleRunApproval(ctx, {
            testFile: "tests/a.spec.ts",
            context: { workflowId: "wf-1" },
        });

        expect(continueHitl).toHaveBeenCalledWith({
            workflowId: "wf-1",
            action: "run",
            decision: "reject",
        });
    });
});
