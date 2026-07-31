import chalk from "chalk";
import { accent } from "../../agent-stream";
import { looksLikeApiKey } from "../../commands/config";
import { safeCliErrorMessage } from "../../errors";
import { runAgentTurn } from "./agent-turn";
import { bootstrapChatRepl } from "./bootstrap";
import { createReadlineLoop } from "./readline-loop";
import { handleShell, startSecureConfigAfterPastedKey } from "./shell-escape";
import { assertSlashDispatchParity, createSlashDispatcher } from "./slash/dispatch";
import type { ChatCommandOptions } from "./types";

assertSlashDispatchParity();

export async function runChatRepl(options: ChatCommandOptions = {}): Promise<void> {
    const { projectPath, state } = await bootstrapChatRepl(options);
    const { ctx, finalize, teardown } = createReadlineLoop(projectPath, state);
    const handleSlash = createSlashDispatcher(ctx);

    try {
        while (!state.closing) {
            let line: string | null = ctx.inputQueue.dequeue() ?? null;
            if (line) {
                console.log(`\n${accent("›")} ${line}`);
            } else {
                try {
                    line = await ctx.readUserInput();
                } catch {
                    if (state.closing) break;
                    continue;
                }
            }
            if (line === null || state.closing) break;
            if (!line) continue;
            state.exitArmedUntil = 0;
            try {
                if (line.startsWith("!")) await handleShell(ctx, line.slice(1).trim());
                else if (line.startsWith("/")) await handleSlash(line);
                else if (looksLikeApiKey(line)) {
                    await startSecureConfigAfterPastedKey(ctx);
                } else await runAgentTurn(ctx, line);
            } catch (err) {
                console.log(chalk.red(`  ✗ ${safeCliErrorMessage(err)}`));
            }
        }
    } finally {
        await finalize();
        teardown();
    }
}
