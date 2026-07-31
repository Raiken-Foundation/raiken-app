import chalk from "chalk";
import { dim } from "../../agent-stream";
import { withThrowExit } from "../exit";
import { printShellSummary, runShellCommand } from "../shell";
import type { ChatReplContext } from "./types";

export async function handleShell(ctx: ChatReplContext, command: string): Promise<void> {
    if (!command.trim()) {
        console.log(chalk.red("  usage: !<shell command>"));
        return;
    }
    console.log(dim(`  $ ${command}`));
    const result = await runShellCommand(command, ctx.projectPath);
    printShellSummary(result);
}

/**
 * A key pasted into the main chat prompt is already visible in terminal
 * scrollback, so never silently save or send it to the agent.
 */
export async function startSecureConfigAfterPastedKey(ctx: ChatReplContext): Promise<void> {
    console.log(
        chalk.yellow(
            "\n  API keys are entered through the masked `/config` prompt, not the chat prompt.",
        ),
    );
    console.log(dim("  The pasted value was not saved or sent to the AI provider.\n"));
    const { configCommand } = await import("../../commands/config");
    await ctx.runParity("config", () =>
        configCommand(undefined, {
            fromRepl: true,
            replAsk: ctx.askCancelable,
            replAskSecret: ctx.askSecret,
        }),
    );
}

export function createRunParity(): (label: string, fn: () => Promise<void>) => Promise<void> {
    return async (label, fn) => {
        const code = await withThrowExit(fn);
        if (code !== 0) {
            console.log(dim(`  (${label} exited with code ${code})`));
        }
    };
}
