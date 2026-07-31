import { BrowserSession } from "@raiken/core";
import chalk from "chalk";
import ora from "ora";
import { dim } from "../../agent-stream";
import { bootstrapProject } from "../../bootstrap";
import { gatherAttentionItems, renderAttentionBanner } from "../attention";
import {
    loadLiveHistory,
    previewMessage,
    resolveResumeTarget,
    saveLiveHistory,
    setCurrentSessionId,
} from "../sessions";
import { isMissingBrowserError, printPlaywrightInstallHint } from "./browser-helpers";
import type { ChatCommandOptions, ChatReplState } from "./types";

export interface BootstrapResult {
    projectPath: string;
    state: ChatReplState;
}

export async function bootstrapChatRepl(
    options: ChatCommandOptions = {},
): Promise<BootstrapResult> {
    const projectPath = process.cwd();
    process.env.RAIKEN_HEADLESS = "0";

    console.log(dim("  Type a request, or /help for commands.\n"));

    const boot = ora({ text: dim("Preparing project…"), color: "magenta" }).start();
    let bootResult: Awaited<ReturnType<typeof bootstrapProject>>;
    try {
        bootResult = await bootstrapProject(projectPath, { verbose: false });
    } finally {
        boot.stop();
    }
    if (!bootResult.ok) {
        console.log(
            chalk.yellow(
                "  ⚠ Code understanding failed to initialize — search, impact analysis, and " +
                    "context lookups will be empty this session (see error above).\n",
            ),
        );
    }

    try {
        const attentionItems = await gatherAttentionItems(
            projectPath,
            bootResult.ok ? bootResult.warnings : [],
        );
        renderAttentionBanner(attentionItems);
    } catch {
        /* attention banner is best-effort */
    }

    const state = createInitialState();

    if (options.resume !== undefined) {
        const target = resolveResumeTarget(
            projectPath,
            options.resume === true ? undefined : options.resume,
        );
        if (target.messages.length === 0 && options.resume !== true) {
            console.log(chalk.yellow(`  No session found for "${options.resume}".`));
            console.log(dim("  Use /sessions to list saved threads.\n"));
        } else if (target.messages.length === 0) {
            // `raiken resume` with nothing saved used to fall through to a
            // fresh session with zero feedback — invisible dead end, since the
            // welcome banner is what advertised resume in the first place.
            console.log(chalk.yellow("  No saved sessions to resume — starting a fresh one."));
            console.log(dim("  Save this thread anytime with /save <name>.\n"));
        } else {
            state.history.push(...target.messages);
            state.activeSessionName = target.session?.name ?? null;
            if (target.session) setCurrentSessionId(projectPath, target.session.id);
            const liveIds = new Set(
                loadLiveHistory(projectPath).flatMap((message) =>
                    message.id === undefined ? [] : [message.id],
                ),
            );
            const persisted = saveLiveHistory(projectPath, state.history, liveIds);
            if (persisted) {
                state.history.splice(0, state.history.length, ...persisted);
                state.persistedHistoryIds = new Set(
                    persisted.flatMap((message) => (message.id === undefined ? [] : [message.id])),
                );
            }
            console.log(
                dim(
                    `  Resumed "${target.label}"` +
                        `  ·  ${state.history.length} messages` +
                        `  ·  ${previewMessage(state.history)}\n`,
                ),
            );
        }
    } else {
        const live = loadLiveHistory(projectPath);
        if (live.length > 0) {
            state.history.push(...live);
            state.persistedHistoryIds = new Set(
                live.flatMap((message) => (message.id === undefined ? [] : [message.id])),
            );
            console.log(
                dim(`  Restored ${state.history.length} messages from previous session.\n`),
            );
        }
    }

    return { projectPath, state };
}

export function createInitialState(): ChatReplState {
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

export async function ensureBrowserSession(projectPath: string): Promise<BrowserSession> {
    const session = BrowserSession.getInstance(projectPath);
    if (!session.isActive()) {
        try {
            await session.start({ headless: false });
        } catch (err) {
            if (isMissingBrowserError(err)) {
                printPlaywrightInstallHint();
            }
            throw err;
        }
    }
    return session;
}
