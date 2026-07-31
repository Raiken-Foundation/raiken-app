import type { EventEmitter } from "node:events";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeReplSession, shutdownRepl } from "../cleanup";
import { createReadlineLoop } from "../readline-loop";
import type { ChatReplContext, ChatReplState } from "../types";

vi.mock("@raiken/core", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@raiken/core")>();
    return {
        ...actual,
        createProjectApplication: vi.fn(() => ({
            chat: {},
            indexing: { getGraphFiles: vi.fn(() => ({ files: [] })) },
            testing: {},
            hitl: {},
        })),
        BrowserSession: {
            getInstance: vi.fn(() => ({
                close: vi.fn().mockResolvedValue(undefined),
            })),
        },
    };
});

vi.mock("../bootstrap", () => ({
    ensureBrowserSession: vi.fn(),
}));

vi.mock("../status", () => ({
    gatherStatusSnapshot: vi.fn().mockResolvedValue({}),
    renderStatusStrip: vi.fn(),
}));

function createTestState(): ChatReplState {
    return {
        history: [],
        persistedHistoryIds: new Set(),
        activeSessionName: null,
        permissionMode: "ask",
        planMode: false,
        verboseTools: false,
        closing: false,
        turnActive: false,
        readingUserInput: false,
        currentAbort: null,
        promptCancel: null,
        activePromptAnswer: null,
        pendingLines: [],
        exitArmedUntil: 0,
        thinking: null,
        activeReadlinePrompt: "",
        replFinalized: false,
        replTornDown: false,
    };
}

function createTestReadline(): readline.Interface {
    const input = new PassThrough();
    const output = new PassThrough();
    return readline.createInterface({ input, output, terminal: true });
}

function listenerCount(emitter: EventEmitter, event: string): number {
    return emitter.listenerCount(event);
}

describe("REPL lifecycle", () => {
    describe("finalizeReplSession", () => {
        it("persists and closes browser only once when called repeatedly", async () => {
            const { BrowserSession } = await import("@raiken/core");
            const close = vi.fn().mockResolvedValue(undefined);
            vi.mocked(BrowserSession.getInstance).mockReturnValue({ close } as never);

            const persist = vi.fn();
            const state = createTestState();
            const ctx = {
                projectPath: "/proj",
                state,
                persist,
            } as unknown as ChatReplContext;

            await finalizeReplSession(ctx);
            await finalizeReplSession(ctx);

            expect(persist).toHaveBeenCalledTimes(1);
            expect(close).toHaveBeenCalledTimes(1);
            expect(state.replFinalized).toBe(true);
        });
    });

    describe("createReadlineLoop teardown", () => {
        it("removes every installed listener and is idempotent across repeated calls", () => {
            const rl = createTestReadline();
            const stdinBefore = listenerCount(process.stdin, "keypress");
            const stdoutBefore = listenerCount(process.stdout, "resize");

            const state = createTestState();
            const { teardown } = createReadlineLoop("/proj", state, { rl });

            expect(listenerCount(rl, "SIGINT")).toBeGreaterThan(0);
            expect(listenerCount(rl, "line")).toBeGreaterThan(0);
            expect(listenerCount(rl, "close")).toBeGreaterThan(0);
            expect(listenerCount(process.stdin, "keypress")).toBe(stdinBefore + 1);
            expect(listenerCount(process.stdout, "resize")).toBe(stdoutBefore + 1);

            teardown();
            teardown();

            expect(listenerCount(rl, "SIGINT")).toBe(0);
            expect(listenerCount(rl, "line")).toBe(0);
            expect(listenerCount(rl, "close")).toBe(0);
            expect(listenerCount(process.stdin, "keypress")).toBe(stdinBefore);
            expect(listenerCount(process.stdout, "resize")).toBe(stdoutBefore);
            expect(state.replTornDown).toBe(true);
        });

        it("supports repeated start/teardown cycles without listener leaks", () => {
            const stdinBefore = listenerCount(process.stdin, "keypress");
            const stdoutBefore = listenerCount(process.stdout, "resize");

            for (let i = 0; i < 3; i++) {
                const rl = createTestReadline();
                const state = createTestState();
                const { teardown } = createReadlineLoop("/proj", state, { rl });
                teardown();
            }

            expect(listenerCount(process.stdin, "keypress")).toBe(stdinBefore);
            expect(listenerCount(process.stdout, "resize")).toBe(stdoutBefore);
        });
    });

    describe("SIGINT interrupt ladder", () => {
        it("aborts in-flight turn then clears abort handle", () => {
            const rl = createTestReadline();
            const state = createTestState();
            const abort = new AbortController();
            state.currentAbort = abort;
            const abortSpy = vi.spyOn(abort, "abort");

            const { teardown } = createReadlineLoop("/proj", state, { rl });
            rl.emit("SIGINT");

            expect(abortSpy).toHaveBeenCalled();
            expect(state.currentAbort).toBeNull();
            teardown();
        });

        it("cancels HITL prompt on second interrupt tier", () => {
            const rl = createTestReadline();
            const state = createTestState();
            const cancel = vi.fn();
            state.promptCancel = cancel;

            const { teardown } = createReadlineLoop("/proj", state, { rl });
            rl.emit("SIGINT");

            expect(cancel).toHaveBeenCalled();
            teardown();
        });

        it("removes SIGINT listener after teardown", () => {
            const rl = createTestReadline();
            const state = createTestState();
            const { teardown } = createReadlineLoop("/proj", state, { rl });

            expect(listenerCount(rl, "SIGINT")).toBe(1);
            teardown();
            expect(listenerCount(rl, "SIGINT")).toBe(0);
        });
    });

    describe("shutdownRepl", () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("finalize + teardown + exit without duplicate browser close", async () => {
            const exitSpy = vi
                .spyOn(process, "exit")
                .mockImplementation((() => undefined) as never);
            const { BrowserSession } = await import("@raiken/core");
            const close = vi.fn().mockResolvedValue(undefined);
            vi.mocked(BrowserSession.getInstance).mockReturnValue({ close } as never);

            const rl = createTestReadline();
            const persist = vi.fn();
            const state = createTestState();
            const { ctx, teardown } = createReadlineLoop("/proj", state, { rl });
            ctx.persist = persist;

            await shutdownRepl(ctx, { teardown, exit: true });

            expect(persist).toHaveBeenCalledTimes(1);
            expect(close).toHaveBeenCalledTimes(1);
            expect(exitSpy).toHaveBeenCalledWith(0);
            expect(state.replTornDown).toBe(true);

            exitSpy.mockRestore();
        });

        it("is idempotent when already finalized", async () => {
            const exitSpy = vi
                .spyOn(process, "exit")
                .mockImplementation((() => undefined) as never);
            const { BrowserSession } = await import("@raiken/core");
            const close = vi.fn().mockResolvedValue(undefined);
            vi.mocked(BrowserSession.getInstance).mockReturnValue({ close } as never);

            const persist = vi.fn();
            const state = createTestState();
            state.replFinalized = true;
            const ctx = {
                projectPath: "/proj",
                state,
                persist,
                rl: { close: vi.fn() },
            } as unknown as ChatReplContext;
            const teardown = vi.fn();

            await shutdownRepl(ctx, { teardown, exit: true });

            expect(persist).not.toHaveBeenCalled();
            expect(close).not.toHaveBeenCalled();
            expect(teardown).toHaveBeenCalled();
            expect(exitSpy).toHaveBeenCalledWith(0);

            exitSpy.mockRestore();
        });
    });

    describe("finally path after thrown handler", () => {
        it("persists and closes browser once when simulating runChatRepl finally", async () => {
            const { BrowserSession } = await import("@raiken/core");
            const close = vi.fn().mockResolvedValue(undefined);
            vi.mocked(BrowserSession.getInstance).mockReturnValue({ close } as never);

            const rl = createTestReadline();
            const state = createTestState();
            const { ctx, finalize, teardown } = createReadlineLoop("/proj", state, { rl });
            const persistSpy = vi.spyOn(ctx, "persist");

            try {
                throw new Error("agent failed");
            } catch {
                /* runChatRepl swallows handler errors */
            } finally {
                await finalize();
                teardown();
            }

            expect(persistSpy).toHaveBeenCalledTimes(1);
            expect(close).toHaveBeenCalledTimes(1);

            await finalize();
            teardown();
            expect(persistSpy).toHaveBeenCalledTimes(1);
            expect(close).toHaveBeenCalledTimes(1);
        });
    });
});
