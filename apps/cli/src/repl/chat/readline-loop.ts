import readline from "node:readline";
import { createProjectApplication } from "@raiken/core";
import chalk from "chalk";
import { dim } from "../../agent-stream";
import { boxWidth, promptBottomBorder, promptPrefix, promptTopBorder } from "../box";
import { withThrowExit } from "../exit";
import { InputQueue } from "../queue";
import { SlashMenuOverlay } from "../slash-overlay";
import { gatherStatusSnapshot, renderStatusStrip } from "../status";
import { ToolCallRenderer } from "../tool-renderer";
import { ensureBrowserSession } from "./bootstrap";
import { createPersist, finalizeReplSession, shutdownRepl } from "./cleanup";
import { EXIT_CONFIRM_MS, HISTORY_LIMIT } from "./constants";
import { createRunParity } from "./shell-escape";
import { slashCompleter } from "./slash/registry";
import type { ChatReplContext, ChatReplState, ManualSaveWatcher } from "./types";

export interface CreateReadlineLoopOptions {
    /** Inject a readline instance (tests / embedded reuse). */
    rl?: readline.Interface;
}

export interface ReadlineLoopResult {
    ctx: ChatReplContext;
    finalize: () => Promise<void>;
    teardown: () => void;
}

export function createReadlineLoop(
    projectPath: string,
    state: ChatReplState,
    options: CreateReadlineLoopOptions = {},
): ReadlineLoopResult {
    const app = createProjectApplication(projectPath);
    const tools = new ToolCallRenderer({ verbose: false });
    const inputQueue = new InputQueue();

    const rl =
        options.rl ??
        readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            historySize: HISTORY_LIMIT,
            terminal: true,
            completer: slashCompleter,
        });

    const slashOverlay = new SlashMenuOverlay(process.stdout);
    let slashSyncScheduled = false;

    const currentSlashOverlayState = () => ({
        enabled: state.readingUserInput,
        line: rl.line,
        cursor: rl.cursor,
        cursorRows: rl.getCursorPos().rows,
        prompt: state.activeReadlinePrompt,
    });

    const stopThinking = (): void => {
        state.thinking?.stop();
        state.thinking = null;
    };

    const persist = createPersist({ projectPath, state });

    const ctxBase = {
        projectPath,
        app,
        state,
        tools,
        inputQueue,
        rl,
        persist,
        stopThinking,
        runParity: createRunParity(),
        ensureBrowser: () => ensureBrowserSession(projectPath),
    };

    const ask = (query: string): Promise<string> =>
        new Promise((resolve) => {
            state.activeReadlinePrompt = query;
            rl.question(query, (answer) => {
                state.activeReadlinePrompt = "";
                resolve(answer);
            });
        });

    const askCancelable = (query: string, secret = false): Promise<string | null> => {
        const buffered = state.pendingLines.shift();
        if (buffered !== undefined) {
            process.stdout.write(`${query}${secret ? "••••" : buffered}\n`);
            return Promise.resolve(buffered);
        }
        return new Promise((resolve) => {
            let settled = false;
            const settle = (answer: string | null) => {
                if (settled) return;
                settled = true;
                state.activePromptAnswer = null;
                state.promptCancel = null;
                resolve(answer);
            };
            state.activePromptAnswer = (line) => settle(line);
            state.promptCancel = () => {
                settle(null);
                console.log(chalk.yellow("\n  ⏹  Cancelled."));
            };
            process.stdout.write(query);
        });
    };

    const askSecret = async (query: string): Promise<string | null> => {
        type ReadlineWithOutputHook = typeof rl & {
            _writeToOutput?: (value: string) => void;
        };
        const mutableReadline = rl as ReadlineWithOutputHook;
        const originalWrite = mutableReadline._writeToOutput;
        if (!originalWrite || !process.stdin.isTTY) return askCancelable(query, true);

        mutableReadline._writeToOutput = (value: string) => {
            if (value.includes("\n") || value.includes("\r")) {
                originalWrite.call(rl, "\n");
            } else if (value.length > 0) {
                originalWrite.call(rl, "•");
            }
        };
        try {
            return await askCancelable(query, true);
        } finally {
            mutableReadline._writeToOutput = originalWrite;
        }
    };

    const readUserInput = async (): Promise<string | null> => {
        state.pendingLines.length = 0;
        const snap = await gatherStatusSnapshot(projectPath, state.permissionMode, state.planMode);
        console.log("");
        renderStatusStrip(snap);
        if (inputQueue.length > 0) {
            console.log(dim(`  ${inputQueue.length} queued — draining next`));
        }
        if (state.activeSessionName) {
            console.log(dim(`  session: ${state.activeSessionName}`));
        }

        const width = boxWidth();
        console.log(promptTopBorder(width));

        const lines: string[] = [];
        let prompt = promptPrefix();
        state.readingUserInput = true;
        slashOverlay.reset();
        try {
            for (;;) {
                const raw = await ask(prompt);
                slashOverlay.finish(prompt, raw);
                if (state.closing) return null;
                if (raw.endsWith("\\") && !raw.endsWith("\\\\")) {
                    lines.push(raw.slice(0, -1));
                    prompt = promptPrefix(true);
                    continue;
                }
                lines.push(raw);
                break;
            }
        } finally {
            state.readingUserInput = false;
        }
        console.log(promptBottomBorder(width));
        return lines.join("\n").trim();
    };

    const createManualSaveWatcher = (): ManualSaveWatcher => {
        let settled = false;
        let resolvePromise: () => void = () => undefined;
        const promise = new Promise<void>((resolve) => {
            resolvePromise = resolve;
        });
        const finish = () => {
            if (settled) return;
            settled = true;
            rl.off("line", finish);
            resolvePromise();
        };
        rl.once("line", finish);
        return {
            promise,
            cancel: () => {
                settled = true;
                rl.off("line", finish);
            },
        };
    };

    const teardown = (): void => {
        if (state.replTornDown) return;
        state.replTornDown = true;

        rl.off("SIGINT", handleInterrupt);
        rl.off("line", handleLine);
        rl.off("close", handleClose);
        process.stdin.off("keypress", handleKeypress);
        process.stdout.off("resize", handleTerminalResize);

        try {
            rl.close();
        } catch {
            /* already closed */
        }
    };

    const shutdown = async (): Promise<void> => shutdownRepl(ctx, { teardown, exit: true });

    const ctx: ChatReplContext = {
        ...ctxBase,
        ask,
        askCancelable,
        askSecret,
        readUserInput,
        shutdown,
        createManualSaveWatcher,
    };

    const handleKeypress = (_input: string, key: readline.Key): void => {
        if (key.name === "return" || key.name === "enter" || (key.ctrl && key.name === "c")) {
            return;
        }
        if (!state.readingUserInput || slashSyncScheduled) return;
        slashSyncScheduled = true;
        setImmediate(() => {
            slashSyncScheduled = false;
            slashOverlay.sync(currentSlashOverlayState());
        });
    };

    const handleTerminalResize = (): void => {
        if (state.readingUserInput) slashOverlay.sync(currentSlashOverlayState());
    };

    const handleInterrupt = (): void => {
        if (state.readingUserInput && slashOverlay.visible) {
            slashOverlay.hide(currentSlashOverlayState());
        }
        if (state.currentAbort) {
            stopThinking();
            state.currentAbort.abort();
            state.currentAbort = null;
            state.exitArmedUntil = 0;
            console.log(chalk.yellow("\n  ⏹  Stopped the current run."));
            return;
        }
        if (state.promptCancel) {
            state.promptCancel();
            state.exitArmedUntil = 0;
            return;
        }
        const now = Date.now();
        if (now < state.exitArmedUntil) {
            void shutdown();
            return;
        }
        state.exitArmedUntil = now + EXIT_CONFIRM_MS;
        console.log(dim("\n  Press Ctrl+C again to exit"));
    };

    const handleLine = (line: string): void => {
        if (state.activePromptAnswer) {
            state.activePromptAnswer(line);
            return;
        }
        if (state.readingUserInput) return;
        if (state.turnActive) {
            const n = inputQueue.enqueue(line);
            if (n > 0) {
                const preview = line.trim().slice(0, 48);
                console.log(
                    dim(`  ↳ queued (${n}): ${preview}${line.trim().length > 48 ? "…" : ""}`),
                );
            }
            return;
        }
        state.pendingLines.push(line);
    };

    const handleClose = (): void => {
        if (state.replTornDown || state.replFinalized) return;
        void shutdownRepl(ctx, { teardown, exit: true });
    };

    rl.on("SIGINT", handleInterrupt);
    rl.on("line", handleLine);
    rl.on("close", handleClose);
    process.stdin.on("keypress", handleKeypress);
    process.stdout.on("resize", handleTerminalResize);

    const finalize = (): Promise<void> => finalizeReplSession(ctx);

    return { ctx, finalize, teardown };
}

/** Re-export for tests that need parity helper without full REPL. */
export { withThrowExit };
