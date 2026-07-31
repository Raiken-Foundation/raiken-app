import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HITL_RESUME_BACKOFF_MS } from "../constants";
import { markHitlResumeFailure } from "../hitl/resume-state";
import { useHitlWorkflowResume } from "../hitl/use-hitl-workflows";

const trpcMock = vi.hoisted(() => {
    const advanceMutateAsync = vi.fn();
    const invalidate = vi.fn();
    return { advanceMutateAsync, invalidate };
});

vi.mock("../../../utils/trpc", () => ({
    trpc: {
        advanceHitlWorkflow: {
            useMutation: () => ({
                mutateAsync: trpcMock.advanceMutateAsync,
                isPending: false,
            }),
        },
        useUtils: () => ({
            listActiveHitlWorkflows: { invalidate: trpcMock.invalidate },
        }),
    },
}));

describe("useHitlWorkflowResume", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        trpcMock.advanceMutateAsync.mockReset();
        trpcMock.invalidate.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("clears retry timer on unmount", async () => {
        const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
        trpcMock.advanceMutateAsync.mockRejectedValue(new Error("transient"));

        const workflows = [{ id: "wf-repair", status: "repairing" as const }];
        const { unmount } = renderHook(() => useHitlWorkflowResume(workflows));

        await act(async () => {
            await Promise.resolve();
        });

        unmount();
        expect(clearTimeoutSpy).toHaveBeenCalled();
        clearTimeoutSpy.mockRestore();
    });

    it("retries after backoff when advanceHitlWorkflow fails", async () => {
        trpcMock.advanceMutateAsync
            .mockRejectedValueOnce(new Error("transient"))
            .mockResolvedValueOnce({});

        const workflows = [{ id: "wf-repair", status: "repairing" as const }];
        renderHook(() => useHitlWorkflowResume(workflows));

        await act(async () => {
            await Promise.resolve();
        });
        expect(trpcMock.advanceMutateAsync).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(HITL_RESUME_BACKOFF_MS);
        });

        expect(trpcMock.advanceMutateAsync).toHaveBeenCalledTimes(2);
    });

    it("clears the in-flight guard on failure so retry is not blocked", () => {
        const resumed = new Set(["wf-repair"]);
        const retryAfter = new Map<string, number>();
        markHitlResumeFailure("wf-repair", resumed, retryAfter, 1000, HITL_RESUME_BACKOFF_MS);
        expect(resumed.has("wf-repair")).toBe(false);
    });
});
