import chalk from "chalk";
import { dim } from "../../../agent-stream";
import { parseCommandArgs } from "../../command-args";
import type { ChatReplContext } from "../types";
import { agentSlashHandlers } from "./handlers/agent";
import { browserSlashHandlers } from "./handlers/browser";
import { configSlashHandlers } from "./handlers/config";
import { discoverySlashHandlers } from "./handlers/discovery";
import { knowledgeSlashHandlers } from "./handlers/knowledge";
import { sessionSlashHandlers } from "./handlers/session";
import { testingSlashHandlers } from "./handlers/testing";
import {
    listRegisteredSlashCommandNames,
    matchSlashCommands,
    resolveSlashCommand,
    type SlashHandler,
} from "./registry";

export const SLASH_DISPATCH_HANDLERS: Record<string, SlashHandler> = {
    ...agentSlashHandlers,
    ...browserSlashHandlers,
    ...sessionSlashHandlers,
    ...discoverySlashHandlers,
    ...knowledgeSlashHandlers,
    ...testingSlashHandlers,
    ...configSlashHandlers,
};

/** Verify registry ↔ dispatch parity at module load (dev/test guard). */
export function assertSlashDispatchParity(): void {
    const registered = listRegisteredSlashCommandNames();
    const missing = registered.filter((name) => SLASH_DISPATCH_HANDLERS[name] === undefined);
    if (missing.length > 0) {
        throw new Error(`Slash commands missing dispatch handlers: ${missing.join(", ")}`);
    }
}

export function createSlashDispatcher(ctx: ChatReplContext): (line: string) => Promise<void> {
    return async (line: string) => {
        const spaceIdx = line.indexOf(" ");
        const enteredCommand = (
            spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx)
        ).toLowerCase();
        const cmd = resolveSlashCommand(enteredCommand)?.name ?? enteredCommand;
        const rawArg = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim();
        const parsedArgs = parseCommandArgs(rawArg);

        const handler = SLASH_DISPATCH_HANDLERS[cmd];
        if (handler) {
            await handler(ctx, parsedArgs, rawArg);
            return;
        }

        const suggestions = matchSlashCommands(cmd)
            .map((command) => command.name)
            .slice(0, 5);
        const hint =
            suggestions.length > 0
                ? dim(`  — did you mean ${suggestions.map((s) => `/${s}`).join(", ")}?`)
                : dim("  — /help for the list");
        console.log(chalk.red(`  Unknown command: /${cmd}`) + hint);
    };
}
