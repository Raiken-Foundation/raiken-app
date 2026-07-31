import type { HitlWorkflowRecord } from "@raiken/shared";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { deriveSaveResolution } from "../hitl/workflow-state";

const queryState = vi.hoisted(() => ({
    data: [] as HitlWorkflowRecord[],
    isSuccess: false,
    isError: false,
    isLoading: true,
}));

vi.mock("../../../utils/trpc", () => ({
    trpc: {
        listActiveHitlWorkflows: {
            useQuery: () => ({
                data: queryState.isError ? undefined : queryState.data,
                isSuccess: queryState.isSuccess && !queryState.isError,
                isError: queryState.isError,
                isLoading: queryState.isLoading,
                isFetching: false,
            }),
        },
    },
}));

import { useActiveHitlWorkflows } from "../hitl/use-hitl-workflows";

const saveHitl = {
    type: "save",
    title: "Approve test save",
    message: "m",
    reasons: [],
    options: [],
    context: { workflowId: "wf-save-1" },
    kind: "save_approval" as const,
};

const activeWorkflow: HitlWorkflowRecord = {
    id: "wf-save-1",
    version: 1,
    kind: "test_generate_repair",
    status: "await_save_approval",
    createdAt: 1,
    updatedAt: 1,
    origin: "dashboard",
    testDraft: "test();",
    shouldRunTests: true,
    repairAttempts: 0,
};

describe("workflow resolution authority", () => {
    it("stays pending while the workflow query has not succeeded yet", () => {
        expect(
            deriveSaveResolution({ id: "hitl-msg", hitlData: saveHitl }, [], {}, false),
        ).toBeUndefined();
    });

    it("remains pending when the workflow is still active", () => {
        expect(
            deriveSaveResolution(
                { id: "hitl-msg", hitlData: saveHitl },
                [activeWorkflow],
                {},
                true,
            ),
        ).toBeUndefined();
    });

    it("marks handled only after an authoritative empty workflow list", () => {
        expect(deriveSaveResolution({ id: "hitl-msg", hitlData: saveHitl }, [], {}, true)).toEqual({
            status: "handled",
        });
    });

    it("uses the last successful snapshot when the query later errors", () => {
        expect(
            deriveSaveResolution(
                { id: "hitl-msg", hitlData: saveHitl },
                [activeWorkflow],
                {},
                true,
            ),
        ).toBeUndefined();
    });
});

describe("useActiveHitlWorkflows polling contract", () => {
    it("requests bounded polling via resolveVisiblePollIntervalInner", async () => {
        const { resolveVisiblePollIntervalInner } = await import("../constants");
        expect(resolveVisiblePollIntervalInner(3000, 8000, false, false, false)).toBe(3000);
        expect(resolveVisiblePollIntervalInner(3000, 8000, true, false, false)).toBe(8000);
        expect(resolveVisiblePollIntervalInner(3000, 8000, false, true, false)).toBe(false);
    });
});

describe("useActiveHitlWorkflows hook", () => {
    it("flips authoritative after the first successful response", async () => {
        queryState.data = [];
        queryState.isSuccess = false;
        queryState.isError = false;
        queryState.isLoading = true;

        const { result, rerender } = renderHook(() => useActiveHitlWorkflows(false, false));
        expect(result.current.workflowsAuthoritative).toBe(false);

        queryState.isSuccess = true;
        queryState.isLoading = false;
        rerender();

        await waitFor(() => {
            expect(result.current.workflowsAuthoritative).toBe(true);
        });
    });
});
