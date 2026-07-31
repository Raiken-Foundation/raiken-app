import chalk from "chalk";
import { accent, dim } from "../../../../agent-stream";
import {
    cyclePermissionMode,
    parsePermissionMode,
    permissionModeLabel,
} from "../../../permissions";
import { printSlashHelp } from "../help";
import type { SlashHandler } from "../registry";

export const handleHelp: SlashHandler = async () => {
    printSlashHelp();
};

export const handleExit: SlashHandler = async (ctx) => {
    await ctx.shutdown();
};

export const handleMode: SlashHandler = async (ctx, _parsedArgs, rawArg) => {
    const { state } = ctx;
    if (rawArg) {
        const parsed = parsePermissionMode(rawArg);
        if (!parsed) {
            console.log(
                chalk.red(`  Unknown mode: ${rawArg}`) +
                    dim("  — ask | auto-save | auto-run | yolo"),
            );
            return;
        }
        state.permissionMode = parsed;
    } else {
        state.permissionMode = cyclePermissionMode(state.permissionMode);
    }
    console.log(
        dim("  Permission mode: ") +
            accent(permissionModeLabel(state.permissionMode)) +
            dim("  (ask → auto-save → auto-run → yolo)"),
    );
};

export const handleVerbose: SlashHandler = async (ctx) => {
    ctx.state.verboseTools = !ctx.state.verboseTools;
    ctx.tools.setVerbose(ctx.state.verboseTools);
    console.log(dim(`  Tool detail: ${ctx.state.verboseTools ? "verbose" : "collapsed"}`));
};

export const handlePlan: SlashHandler = async (ctx, _parsedArgs, rawArg) => {
    const { state } = ctx;
    if (rawArg === "on" || rawArg === "1" || rawArg === "true") state.planMode = true;
    else if (rawArg === "off" || rawArg === "0" || rawArg === "false") state.planMode = false;
    else state.planMode = !state.planMode;
    console.log(
        dim("  Plan mode: ") +
            accent(state.planMode ? "on" : "off") +
            dim("  — preview steps before the agent runs"),
    );
};

export const agentSlashHandlers: Record<string, SlashHandler> = {
    help: handleHelp,
    exit: handleExit,
    mode: handleMode,
    verbose: handleVerbose,
    plan: handlePlan,
};
