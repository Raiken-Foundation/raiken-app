import { BrowserSession } from "@raiken/core";
import { dim } from "../../agent-stream";
import { CLI_EXIT } from "../../errors";
import { saveLiveHistory, saveSession } from "../sessions";
import type { ChatReplContext } from "./types";

export function createPersist(ctx: Pick<ChatReplContext, "projectPath" | "state">): () => void {
    return () => {
        const persisted = saveLiveHistory(
            ctx.projectPath,
            ctx.state.history,
            ctx.state.persistedHistoryIds,
        );
        if (!persisted) return;
        ctx.state.history.splice(0, ctx.state.history.length, ...persisted);
        ctx.state.persistedHistoryIds = new Set(
            persisted.flatMap((message) => (message.id === undefined ? [] : [message.id])),
        );
    };
}

/** Persist history, save named session, and close the browser — safe to call repeatedly. */
export async function finalizeReplSession(ctx: ChatReplContext): Promise<void> {
    const { projectPath, state } = ctx;
    if (state.replFinalized) return;

    state.replFinalized = true;
    state.closing = true;
    ctx.persist();

    if (state.activeSessionName) {
        try {
            saveSession(projectPath, state.activeSessionName, state.history, state.permissionMode);
        } catch {
            /* best-effort */
        }
    }

    try {
        await BrowserSession.getInstance(projectPath).close();
    } catch {
        /* already closed */
    }
}

export interface ShutdownReplOptions {
    /** Remove readline/process listeners and close the interface. */
    teardown?: () => void;
    /** Call `process.exit(0)` after cleanup (default true). */
    exit?: boolean;
}

/**
 * Full interactive shutdown: finalize once, tear down listeners, optionally exit.
 * Idempotent — repeated calls are no-ops after the first finalize.
 */
export async function shutdownRepl(
    ctx: ChatReplContext,
    options: ShutdownReplOptions = {},
): Promise<void> {
    const { teardown, exit = true } = options;
    const alreadyFinalized = ctx.state.replFinalized;

    await finalizeReplSession(ctx);

    if (!alreadyFinalized) {
        console.log(dim("\n  Closing browser and exiting..."));
    }

    teardown?.();

    if (exit) {
        process.exit(CLI_EXIT.SUCCESS);
    }
}
