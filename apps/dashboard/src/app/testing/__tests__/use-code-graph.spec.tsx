/**
 * Regression tests for the transient dashboard states seen during the first
 * index walk: watcher bumps fired by the build itself used to invalidate
 * getGraphFiles / listTestFiles against a half-written graph, rendering
 * phantom file-tree entries and a transient empty spec list that self-healed
 * after the build.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
    bump: { current: undefined as number | undefined },
    stats: { current: { totalFiles: 5 } as { totalFiles: number } | null },
    invalidate: {
        getGraphFiles: vi.fn(),
        listTestFiles: vi.fn(),
        getGraphStats: vi.fn(),
    },
    buildHandlers: {} as {
        onSuccess?: () => Promise<void> | void;
        onError?: (error: { message: string }) => void;
    },
    buildMutate: vi.fn(),
}));

vi.mock("../../../utils/trpc", () => ({
    trpc: {
        useUtils: () => ({
            getGraphFiles: { invalidate: mock.invalidate.getGraphFiles },
            listTestFiles: { invalidate: mock.invalidate.listTestFiles },
            getGraphStats: { invalidate: mock.invalidate.getGraphStats },
        }),
        getFileChangeBump: {
            useQuery: () => ({
                data: mock.bump.current === undefined ? undefined : { bump: mock.bump.current },
            }),
        },
        getProjectInfo: { useQuery: () => ({ data: null }) },
        getGraphStats: { useQuery: () => ({ data: mock.stats.current }) },
        buildCodeGraph: {
            useMutation: (handlers: typeof mock.buildHandlers) => {
                mock.buildHandlers = handlers;
                return { mutate: mock.buildMutate };
            },
        },
        getGraphFiles: { useQuery: () => ({ isLoading: false }) },
    },
}));

import { useCodeGraph } from "../use-code-graph";

describe("useCodeGraph watcher-bump invalidation", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mock.bump.current = undefined;
        mock.stats.current = { totalFiles: 5 };
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("coalesces a burst of bumps into a single invalidation", async () => {
        mock.bump.current = 1;
        const hook = renderHook(() => useCodeGraph());

        mock.bump.current = 2;
        hook.rerender();
        mock.bump.current = 3;
        hook.rerender();

        await act(async () => {
            vi.advanceTimersByTime(800);
        });

        expect(mock.invalidate.getGraphFiles).toHaveBeenCalledTimes(1);
        expect(mock.invalidate.listTestFiles).toHaveBeenCalledTimes(1);
    });

    it("suppresses invalidations while a build runs, then resyncs once on success", async () => {
        // totalFiles 0 triggers the auto-build on mount.
        mock.stats.current = { totalFiles: 0 };
        mock.bump.current = 1;
        const hook = renderHook(() => useCodeGraph());
        expect(mock.buildMutate).toHaveBeenCalledTimes(1);

        // Watcher bumps fired by the build itself must not refetch the
        // half-written graph.
        mock.bump.current = 2;
        hook.rerender();
        await act(async () => {
            vi.advanceTimersByTime(3000);
        });
        expect(mock.invalidate.getGraphFiles).not.toHaveBeenCalled();
        expect(mock.invalidate.listTestFiles).not.toHaveBeenCalled();

        // The build's own success handler performs the authoritative resync.
        await act(async () => {
            await mock.buildHandlers.onSuccess?.();
        });
        expect(mock.invalidate.getGraphStats).toHaveBeenCalledTimes(1);
        expect(mock.invalidate.getGraphFiles).toHaveBeenCalledTimes(1);
        expect(mock.invalidate.listTestFiles).toHaveBeenCalledTimes(1);

        // And post-build, genuinely new bumps invalidate again (debounced).
        mock.bump.current = 3;
        hook.rerender();
        await act(async () => {
            vi.advanceTimersByTime(800);
        });
        expect(mock.invalidate.getGraphFiles).toHaveBeenCalledTimes(2);
        expect(mock.invalidate.listTestFiles).toHaveBeenCalledTimes(2);
    });
});
