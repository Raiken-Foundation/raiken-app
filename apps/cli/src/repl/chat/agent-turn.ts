import { runOrchestrator } from "@raiken/core";
import chalk from "chalk";
import { accent, dim, splitHITL } from "../../agent-stream";
import { safeCliErrorMessage } from "../../errors";
import { MarkdownStream } from "../markdown";
import { permissionModeToAutonomyOverride } from "../permissions";
import { buildAgentPlan, renderPlan } from "../plan";
import { startThinking } from "../thinking";
import { isMissingBrowserError, printPlaywrightInstallHint } from "./browser-helpers";
import { handleRunApproval, handleSaveApproval } from "./hitl";
import type { ChatReplContext } from "./types";

async function rejectAbortedHitl(
    ctx: ChatReplContext,
    hitl: Record<string, unknown> | null,
): Promise<void> {
    if (!hitl || (hitl.kind !== "save_approval" && hitl.kind !== "run_approval")) return;
    const context =
        hitl.context && typeof hitl.context === "object"
            ? (hitl.context as Record<string, unknown>)
            : {};
    const workflowId = typeof context.workflowId === "string" ? context.workflowId : undefined;
    if (!workflowId) return;
    await ctx.app.hitl.continue({
        workflowId,
        action: hitl.kind === "save_approval" ? "save" : "run",
        decision: "reject",
    });
}

export async function runAgentTurn(ctx: ChatReplContext, userText: string): Promise<void> {
    const { projectPath, state, tools } = ctx;

    if (state.planMode) {
        const plan = await buildAgentPlan(projectPath, userText);
        renderPlan(plan);
        const confirm = await ctx.askCancelable(accent("  Proceed? [Y]es · [n]o · [p]lan off › "));
        if (confirm === null) return;
        const a = confirm.trim().toLowerCase();
        if (a === "n" || a === "no") {
            console.log(dim("  Cancelled."));
            return;
        }
        if (a === "p" || a === "plan" || a === "off") {
            state.planMode = false;
            console.log(dim("  Plan mode off — running this turn."));
        }
    }

    const priorHistory = [...state.history];
    state.history.push({ role: "user", content: userText });

    const abort = new AbortController();
    state.currentAbort = abort;
    state.turnActive = true;
    state.exitArmedUntil = 0;
    let assistant = "";
    let pendingHITL: Record<string, unknown> | null = null;
    tools.setVerbose(state.verboseTools);
    const md = new MarkdownStream();

    state.thinking = startThinking();
    try {
        const stream = runOrchestrator({
            userPrompt: userText,
            projectPath,
            conversationHistory: priorHistory,
            autonomyOverride: permissionModeToAutonomyOverride(state.permissionMode),
            signal: abort.signal,
            origin: "repl",
            onToolCall: (name, args) => {
                ctx.stopThinking();
                tools.onToolCall(name, args);
            },
        });
        for await (const chunk of stream) {
            const { text, hitl } = splitHITL(chunk, {
                onProgress: (label, detail) => {
                    ctx.stopThinking();
                    tools.onProgress(label, detail);
                },
                suppressProgressPrint: true,
            });
            if (hitl && (hitl.kind === "save_approval" || hitl.kind === "run_approval")) {
                pendingHITL = hitl;
            }
            if (text) {
                ctx.stopThinking();
                tools.flush();
                if (!assistant) console.log("");
                md.push(text);
                assistant += text;
            }
        }
        tools.flush();
        md.end();
        if (!assistant.endsWith("\n")) process.stdout.write("\n");
    } catch (err) {
        ctx.stopThinking();
        tools.flush();
        if (abort.signal.aborted) {
            /* already reported by SIGINT handler */
        } else if (isMissingBrowserError(err)) {
            printPlaywrightInstallHint();
        } else {
            console.log(chalk.red(`\n  ✗ ${safeCliErrorMessage(err)}`));
        }
    } finally {
        ctx.stopThinking();
        state.turnActive = false;
        state.currentAbort = null;
    }

    if (abort.signal.aborted) {
        try {
            await rejectAbortedHitl(ctx, pendingHITL);
        } catch (error) {
            console.log(chalk.red(`\n  ✗ ${safeCliErrorMessage(error)}`));
        }
        // Keep the user's request, but never persist a partial assistant stream
        // or prompt for an approval after the user stopped the turn.
        ctx.persist();
        return;
    }

    state.history.push({ role: "assistant", content: assistant });
    ctx.persist();
    if (pendingHITL?.kind === "save_approval") {
        await handleSaveApproval(ctx, pendingHITL);
    } else if (pendingHITL?.kind === "run_approval") {
        await handleRunApproval(ctx, pendingHITL);
    }
}
