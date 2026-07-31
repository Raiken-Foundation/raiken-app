import chalk from "chalk";
import { accent, dim } from "../../../../agent-stream";
import {
    clearConversation,
    listSessions,
    previewMessage,
    resolveResumeTarget,
    saveSession,
    setCurrentSessionId,
} from "../../../sessions";
import type { SlashHandler } from "../registry";

export const handleSessions: SlashHandler = async (ctx, _parsedArgs, rawArg) => {
    const { projectPath, state } = ctx;
    if (!rawArg || rawArg === "list") {
        const sessions = listSessions(projectPath);
        if (sessions.length === 0) {
            console.log(dim("\n  No saved sessions. Use /save <name> to snapshot.\n"));
            return;
        }
        console.log(accent("\n  Sessions"));
        for (const s of sessions.slice(0, 20)) {
            const when = new Date(s.updatedAt).toLocaleString();
            console.log(
                `  ${accent(s.name.padEnd(20))} ${dim(`${s.messages.length} msgs · ${when}`)}`,
            );
            console.log(`      ${dim(previewMessage(s.messages))}`);
        }
        console.log("");
        return;
    }
    if (rawArg.startsWith("save ") || rawArg === "save") {
        const name = rawArg === "save" ? "" : rawArg.slice(5).trim();
        if (!name) {
            console.log(chalk.red("  usage: /sessions save <name>  (or /save <name>)"));
            return;
        }
        const snap = saveSession(projectPath, name, state.history, state.permissionMode);
        state.activeSessionName = snap.name;
        console.log(
            chalk.green(`  ✓ Saved session "${snap.name}"`) +
                dim(`  (${snap.messages.length} messages)`),
        );
        return;
    }
    console.log(dim("  usage: /sessions [list] | /sessions save <name>"));
};

export const handleSave: SlashHandler = async (ctx, _parsedArgs, rawArg) => {
    if (!rawArg) {
        console.log(chalk.red("  usage: /save <name>"));
        return;
    }
    const snap = saveSession(ctx.projectPath, rawArg, ctx.state.history, ctx.state.permissionMode);
    ctx.state.activeSessionName = snap.name;
    console.log(
        chalk.green(`  ✓ Saved session "${snap.name}"`) +
            dim(`  (${snap.messages.length} messages)`),
    );
};

export const handleResume: SlashHandler = async (ctx, _parsedArgs, rawArg) => {
    const { projectPath, state } = ctx;
    const target = resolveResumeTarget(projectPath, rawArg || undefined);
    if (target.messages.length === 0) {
        console.log(
            chalk.yellow(
                rawArg
                    ? `  No session found for "${rawArg}".`
                    : "  No sessions to resume. Use /save <name> first.",
            ),
        );
        return;
    }
    state.history.length = 0;
    state.history.push(...target.messages);
    state.activeSessionName = target.session?.name ?? null;
    if (target.session) setCurrentSessionId(projectPath, target.session.id);
    ctx.persist();
    console.log(
        chalk.green(`  ✓ Resumed "${target.label}"`) +
            dim(`  ·  ${state.history.length} messages · ${previewMessage(state.history)}`),
    );
};

export const handleClear: SlashHandler = async (ctx) => {
    await clearConversation(ctx.projectPath, ctx.app.chat);
    ctx.state.history.length = 0;
    ctx.state.persistedHistoryIds = new Set();
    ctx.inputQueue.clear();
    ctx.state.activeSessionName = null;
    console.log(dim("  Conversation context and agent memory cleared."));
};

export const sessionSlashHandlers: Record<string, SlashHandler> = {
    sessions: handleSessions,
    save: handleSave,
    resume: handleResume,
    clear: handleClear,
};
