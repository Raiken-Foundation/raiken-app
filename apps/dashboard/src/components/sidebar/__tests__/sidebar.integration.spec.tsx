import type { HitlWorkflowRecord } from "@raiken/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-markdown", () => ({
    default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("../sidebar.css", () => ({}));

const sidebarMock = vi.hoisted(() => {
    const noopMutation = {
        mutate: vi.fn(),
        mutateAsync: vi.fn().mockResolvedValue({ success: true }),
        isPending: false,
    };
    const continueMutateAsync = vi.fn(async () => {
        sidebarMockState.continueHitlCalls += 1;
        return {
            workflow: { status: "completed" },
            savedPath: "e2e/login.spec.ts",
        };
    });
    const advanceMutateAsync = vi.fn().mockResolvedValue({});
    const invalidateWorkflows = vi.fn();

    const stableEmptyFiles: Array<{
        name: string;
        path: string;
        directory: string;
        status: string;
    }> = [];
    const stableTestFilesData = { files: stableEmptyFiles };
    const stableGraphFilesData = { files: [] as Array<{ path: string }> };
    const stableConfigData = { config: { autonomy: {} as Record<string, unknown> } };
    const stableChatData = {
        messages: [] as Array<{
            id: string;
            content: string;
            sender: "user" | "assistant";
            timestamp: number;
        }>,
    };

    return {
        state: {
            chatQueryData: stableChatData,
            workflowQueryData: [] as HitlWorkflowRecord[],
            workflowsQuerySuccess: true,
            workflowsQueryError: false,
            workflowsQueryLoading: false,
            continueHitlCalls: 0,
        },
        stableTestFilesData,
        stableGraphFilesData,
        stableConfigData,
        noopMutation,
        continueMutateAsync,
        advanceMutateAsync,
        invalidateWorkflows,
    };
});

const sidebarMockState = sidebarMock.state;

vi.mock("../../../utils/trpc", () => ({
    trpc: {
        getChatMessages: {
            useQuery: () => ({
                data: sidebarMockState.chatQueryData,
                isSuccess: true,
                isError: false,
                isFetching: false,
                isLoading: false,
            }),
        },
        listActiveHitlWorkflows: {
            useQuery: () => ({
                data: sidebarMockState.workflowsQueryError
                    ? undefined
                    : sidebarMockState.workflowQueryData,
                isSuccess:
                    sidebarMockState.workflowsQuerySuccess && !sidebarMockState.workflowsQueryError,
                isError: sidebarMockState.workflowsQueryError,
                isFetching: false,
                isLoading: sidebarMockState.workflowsQueryLoading,
            }),
        },
        listTestFiles: {
            useQuery: () => ({
                data: sidebarMock.stableTestFilesData,
                isLoading: false,
                isFetching: false,
                refetch: vi.fn(),
            }),
        },
        getGraphFiles: {
            useQuery: () => ({ data: sidebarMock.stableGraphFilesData }),
        },
        getConfig: {
            useQuery: () => ({ data: sidebarMock.stableConfigData }),
        },
        addChatMessage: { useMutation: () => sidebarMock.noopMutation },
        clearChatMessages: { useMutation: () => sidebarMock.noopMutation },
        saveGeneratedTest: { useMutation: () => sidebarMock.noopMutation },
        updateConfig: { useMutation: () => sidebarMock.noopMutation },
        runTests: { useMutation: () => sidebarMock.noopMutation },
        continueHitlWorkflow: {
            useMutation: () => ({
                mutateAsync: sidebarMock.continueMutateAsync,
                isPending: false,
            }),
        },
        advanceHitlWorkflow: {
            useMutation: () => ({
                mutateAsync: sidebarMock.advanceMutateAsync,
                isPending: false,
            }),
        },
        useUtils: () => ({
            getConfig: { invalidate: vi.fn() },
            listActiveHitlWorkflows: { invalidate: sidebarMock.invalidateWorkflows },
        }),
    },
}));

import { Sidebar } from "../sidebar";

function renderSidebar(onHitlPendingChange = vi.fn()) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false, refetchInterval: false, refetchOnWindowFocus: false },
        },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return {
        queryClient,
        onHitlPendingChange,
        ...render(<Sidebar onHitlPendingChange={onHitlPendingChange} />, { wrapper }),
    };
}

const saveWorkflow: HitlWorkflowRecord = {
    id: "wf-save-1",
    version: 1,
    kind: "test_generate_repair",
    status: "await_save_approval",
    createdAt: 1,
    updatedAt: 1,
    origin: "dashboard",
    savedTestPath: "e2e/login.spec.ts",
    testDraft: 'test("login", async () => {});',
    testName: "login",
    shouldRunTests: true,
    repairAttempts: 0,
};

describe("Sidebar integration", () => {
    beforeEach(() => {
        sidebarMockState.chatQueryData.messages = [];
        sidebarMockState.workflowQueryData = [];
        sidebarMockState.workflowsQuerySuccess = true;
        sidebarMockState.workflowsQueryError = false;
        sidebarMockState.workflowsQueryLoading = false;
        sidebarMockState.continueHitlCalls = 0;
        sidebarMock.continueMutateAsync.mockClear();
        sidebarMock.advanceMutateAsync.mockClear();
        sidebarMock.invalidateWorkflows.mockClear();

        vi.stubGlobal(
            "fetch",
            vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
                if (init?.signal?.aborted) {
                    throw new DOMException("Aborted", "AbortError");
                }
                const body = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(
                            new TextEncoder().encode('data: {"chunk":"hello from agent"}\n\n'),
                        );
                        controller.close();
                    },
                });
                return { ok: true, body } as Response;
            }),
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("renders the agent shell and merges REPL chat after stream completion", async () => {
        sidebarMockState.chatQueryData.messages = [
            { id: "repl-user", content: "from repl", sender: "user", timestamp: 100 },
        ];
        const view = renderSidebar();

        expect(screen.getByPlaceholderText(/write a test/i)).toBeTruthy();
        expect(await screen.findByText(/from repl/)).toBeTruthy();

        const input = screen.getByPlaceholderText(/write a test/i);
        fireEvent.change(input, { target: { value: "generate login test" } });
        fireEvent.submit(input.closest("form") as HTMLFormElement);

        expect(await screen.findByText(/hello from agent/i, { timeout: 5000 })).toBeTruthy();

        sidebarMockState.chatQueryData.messages = [
            { id: "repl-user", content: "from repl", sender: "user", timestamp: 100 },
            {
                id: "repl-assistant",
                content: "repl follow-up",
                sender: "assistant",
                timestamp: 200,
            },
        ];
        view.rerender(
            <QueryClientProvider client={view.queryClient}>
                <Sidebar />
            </QueryClientProvider>,
        );

        expect(await screen.findByText(/repl follow-up/i, { timeout: 5000 })).toBeTruthy();
    });

    it("aborts an in-flight stream from the stop control", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        reject(new DOMException("Aborted", "AbortError"));
                    });
                });
            }),
        );

        renderSidebar();
        fireEvent.change(screen.getByPlaceholderText(/write a test/i), {
            target: { value: "long task" },
        });
        fireEvent.keyDown(screen.getByPlaceholderText(/write a test/i), { key: "Enter" });

        fireEvent.click(await screen.findByLabelText("Stop the running agent"));

        await waitFor(() => {
            expect(screen.getByText(/Stopping the agent/)).toBeTruthy();
        });
    });

    it("prevents duplicate workflow-backed save approvals", async () => {
        sidebarMockState.workflowQueryData = [saveWorkflow];
        sidebarMockState.chatQueryData.messages = [
            {
                id: "hitl-msg",
                content:
                    '<!--HITL:{"kind":"save_approval","type":"save","title":"Approve test save","message":"Review and save this recovered test draft, or reject it.","reasons":[],"options":[{"id":"save_approve","label":"Save","description":""},{"id":"save_reject","label":"Reject","description":""}],"context":{"workflowId":"wf-save-1"},"testCode":"test(\\"login\\", async () => {});","suggestedPath":"e2e/login.spec.ts"}-->',
                sender: "assistant",
                timestamp: 1,
            },
        ];
        renderSidebar();

        const saveButton = await screen.findByRole("button", { name: "Save" });
        fireEvent.click(saveButton);
        fireEvent.click(saveButton);

        await waitFor(() => {
            expect(sidebarMockState.continueHitlCalls).toBe(1);
        });
    });

    it("preserves pending cards when the workflow query fails after a successful snapshot", async () => {
        sidebarMockState.workflowQueryData = [saveWorkflow];
        sidebarMockState.chatQueryData.messages = [
            {
                id: "hitl-msg",
                content:
                    '<!--HITL:{"kind":"save_approval","type":"save","title":"Approve test save","message":"Review and save this recovered test draft, or reject it.","reasons":[],"options":[{"id":"save_approve","label":"Save","description":""},{"id":"save_reject","label":"Reject","description":""}],"context":{"workflowId":"wf-save-1"},"testCode":"test();","suggestedPath":"e2e/login.spec.ts"}-->',
                sender: "assistant",
                timestamp: 1,
            },
        ];
        const onHitlPendingChange = vi.fn();
        const view = renderSidebar(onHitlPendingChange);

        await screen.findByRole("button", { name: "Save" });

        sidebarMockState.workflowsQueryError = true;
        sidebarMockState.workflowQueryData = [];
        view.rerender(
            <QueryClientProvider client={view.queryClient}>
                <Sidebar onHitlPendingChange={onHitlPendingChange} />
            </QueryClientProvider>,
        );

        expect(await screen.findByRole("button", { name: "Save" })).toBeTruthy();
        expect(onHitlPendingChange.mock.calls.at(-1)?.[0]).toBe(true);
    });

    it("keeps workflow cards pending before the first authoritative query", async () => {
        sidebarMockState.workflowsQuerySuccess = false;
        sidebarMockState.workflowsQueryLoading = true;
        sidebarMockState.chatQueryData.messages = [
            {
                id: "hitl-msg",
                content:
                    '<!--HITL:{"kind":"save_approval","type":"save","title":"Approve test save","message":"m","reasons":[],"options":[{"id":"save_approve","label":"Save","description":""},{"id":"save_reject","label":"Reject","description":""}],"context":{"workflowId":"wf-save-1"},"testCode":"test();","suggestedPath":"e2e/a.spec.ts"}-->',
                sender: "assistant",
                timestamp: 1,
            },
        ];

        const onHitlPendingChange = vi.fn();
        renderSidebar(onHitlPendingChange);

        await waitFor(() => {
            expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
            expect(onHitlPendingChange).toHaveBeenCalledWith(true);
        });
        expect(screen.queryByText(/Approval already handled/i)).toBeNull();
    });

    it("shows handled state only after an authoritative empty workflow list", async () => {
        sidebarMockState.workflowsQuerySuccess = false;
        sidebarMockState.workflowsQueryLoading = true;
        sidebarMockState.chatQueryData.messages = [
            {
                id: "hitl-msg",
                content:
                    '<!--HITL:{"kind":"save_approval","type":"save","title":"Approve test save","message":"m","reasons":[],"options":[{"id":"save_approve","label":"Save","description":""},{"id":"save_reject","label":"Reject","description":""}],"context":{"workflowId":"wf-save-1"},"testCode":"test();","suggestedPath":"e2e/a.spec.ts"}-->',
                sender: "assistant",
                timestamp: 1,
            },
        ];
        const view = renderSidebar();

        await waitFor(() => {
            expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
        });

        sidebarMockState.workflowsQuerySuccess = true;
        sidebarMockState.workflowsQueryLoading = false;
        sidebarMockState.workflowQueryData = [];
        view.rerender(
            <QueryClientProvider client={view.queryClient}>
                <Sidebar />
            </QueryClientProvider>,
        );

        await waitFor(() => {
            expect(screen.getByText(/Approval already handled/i)).toBeTruthy();
        });
        expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    });
});
