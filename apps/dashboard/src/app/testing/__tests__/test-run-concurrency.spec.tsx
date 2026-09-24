import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const runMock = vi.hoisted(() => ({
    mutate: vi.fn(),
    handlers: {} as {
        onSuccess?: (data: unknown) => void;
        onError?: (error: { message: string }) => void;
    },
}));

vi.mock("../../../utils/trpc", () => ({
    trpc: {
        runTests: {
            useMutation: (options: typeof runMock.handlers) => {
                runMock.handlers = options;
                return { mutate: runMock.mutate, isPending: false };
            },
        },
        cancelTestRun: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
}));

import type { TestFile } from "../../../components/code-editor";
import { useTestRun } from "../use-test-run";

function testFile(id: string): TestFile {
    return {
        id,
        name: `${id}.spec.ts`,
        path: `e2e/${id}.spec.ts`,
        content: "import { test } from '@playwright/test';\ntest('x', async () => {});\n",
        status: "pending",
    } as TestFile;
}

function setup() {
    let files = [testFile("a"), testFile("b")];
    const setFiles = vi.fn((update: unknown) => {
        files =
            typeof update === "function"
                ? (update as (f: TestFile[]) => TestFile[])(files)
                : (update as TestFile[]);
    });

    const hook = renderHook(() =>
        useTestRun({
            files,
            setFiles: setFiles as never,
            activeFileId: "a",
            setActiveFilePath: vi.fn(),
            closedPathsRef: { current: new Set<string>() },
            skipDiskLoadRef: { current: null },
            savedContentRef: { current: new Map<string, string>() },
            persistOnRunMutation: { mutateAsync: vi.fn() } as never,
        }),
    );

    return { hook, getFiles: () => files };
}

describe("useTestRun concurrency", () => {
    it("ignores a second run while one is in flight, so results stay attributed to the right file", async () => {
        runMock.mutate.mockClear();
        const { hook, getFiles } = setup();

        await act(async () => {
            await hook.result.current.handleRunTests("a");
        });
        await act(async () => {
            await hook.result.current.handleRunTests("b");
        });

        expect(runMock.mutate).toHaveBeenCalledTimes(1);
        expect(runMock.mutate.mock.calls[0][0]).toMatchObject({ testFile: "e2e/a.spec.ts" });
        expect(getFiles().find((f) => f.id === "b")?.status).toBe("pending");

        act(() => {
            runMock.handlers.onSuccess?.({ success: true, stdout: "", results: null });
        });

        expect(getFiles().find((f) => f.id === "a")?.status).toBe("passed");
    });

    it("accepts a new run once the previous one settles", async () => {
        runMock.mutate.mockClear();
        const { hook } = setup();

        await act(async () => {
            await hook.result.current.handleRunTests("a");
        });
        act(() => {
            runMock.handlers.onSuccess?.({ success: true, stdout: "", results: null });
        });
        await act(async () => {
            await hook.result.current.handleRunTests("b");
        });

        expect(runMock.mutate).toHaveBeenCalledTimes(2);
        expect(runMock.mutate.mock.calls[1][0]).toMatchObject({ testFile: "e2e/b.spec.ts" });
    });

    it("releases the guard when the run errors", async () => {
        runMock.mutate.mockClear();
        const { hook } = setup();

        await act(async () => {
            await hook.result.current.handleRunTests("a");
        });
        act(() => {
            runMock.handlers.onError?.({ message: "boom" });
        });
        await act(async () => {
            await hook.result.current.handleRunTests("b");
        });

        expect(runMock.mutate).toHaveBeenCalledTimes(2);
    });
});
