/**
 * createHitlRunNode is the bridge between "run the saved test" and the
 * repair loop. If it discards real Playwright failure data (selector,
 * error message, stack) and replaces it with a generic "Test run failed",
 * auto-repair has nothing real to work with — it's fixing blind.
 */
import { describe, expect, it, vi } from "vitest";
import { createHitlRunNode } from "../agent/graph/nodes/hitl";
import type { CallTool } from "../agent/graph/nodes/types";
import type { GraphStateType } from "../agent/graph/state";
import type { TestRunResult } from "../testing/runner";

function baseState(overrides: Partial<GraphStateType> = {}): GraphStateType {
    return {
        savedTestPath: "e2e/login.spec.ts",
        shouldRunTests: true,
        ...overrides,
    } as GraphStateType;
}

describe("createHitlRunNode", () => {
    it("preserves real per-test failure data instead of a generic error", async () => {
        const failingResults: TestRunResult[] = [
            {
                testFile: "e2e/login.spec.ts",
                testName: "shows an error on bad credentials",
                status: "failed",
                duration: 1234,
                error: {
                    message: "Timed out waiting for selector",
                    selector: '[data-testid="error-banner"]',
                },
            },
        ];
        const callTool: CallTool = vi.fn(async () => ({
            success: false,
            data: failingResults,
            message: "1 test(s) failed",
        }));

        const node = createHitlRunNode({ callTool } as unknown as Parameters<
            typeof createHitlRunNode
        >[0]);
        const result = await node(baseState());

        expect(result.testRunResult).toEqual(failingResults);
        expect(result.testRunResult?.[0]?.error?.selector).toBe('[data-testid="error-banner"]');
    });

    it("preserves real per-test results when the run passed", async () => {
        const passingResults: TestRunResult[] = [
            {
                testFile: "e2e/login.spec.ts",
                testName: "logs in successfully",
                status: "passed",
                duration: 987,
            },
        ];
        const callTool: CallTool = vi.fn(async () => ({
            success: true,
            data: passingResults,
            message: "All tests passed (1 test(s))",
        }));

        const node = createHitlRunNode({ callTool } as unknown as Parameters<
            typeof createHitlRunNode
        >[0]);
        const result = await node(baseState());

        expect(result.testRunResult).toEqual(passingResults);
    });

    it("falls back to a synthetic error only when there is no per-test data", async () => {
        const callTool: CallTool = vi.fn(async () => ({
            success: false,
            message: "Test execution failed: spawn ENOENT",
        }));

        const node = createHitlRunNode({ callTool } as unknown as Parameters<
            typeof createHitlRunNode
        >[0]);
        const result = await node(baseState());

        expect(result.testRunResult).toHaveLength(1);
        expect(result.testRunResult?.[0]?.status).toBe("error");
        expect(result.testRunResult?.[0]?.error?.message).toBe(
            "Test execution failed: spawn ENOENT",
        );
    });

    it("pauses for approval when the run tool requires HITL", async () => {
        const callTool: CallTool = vi.fn(async () => ({
            success: true,
            data: { status: "pending" },
            message: "Ready to run e2e/login.spec.ts. Waiting for confirmation.",
            hitlRequired: true,
        }));

        const node = createHitlRunNode({ callTool } as unknown as Parameters<
            typeof createHitlRunNode
        >[0]);
        const result = await node(baseState());

        expect(result.shouldPause).toBe(true);
        expect(result.testRunResult).toBeUndefined();
    });

    it("does nothing when there's no saved test or the caller didn't request a run", async () => {
        const callTool: CallTool = vi.fn();
        const node = createHitlRunNode({ callTool } as unknown as Parameters<
            typeof createHitlRunNode
        >[0]);

        expect(await node(baseState({ savedTestPath: null }))).toEqual({});
        expect(await node(baseState({ shouldRunTests: false }))).toEqual({});
        expect(callTool).not.toHaveBeenCalled();
    });
});
