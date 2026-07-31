import chalk from "chalk";
import { accent, dim } from "../../../../agent-stream";
import { safeCliErrorMessage } from "../../../../errors";
import {
    continueBackgroundDiscover,
    getBackgroundDiscoverStatus,
    startBackgroundDiscover,
} from "../../../background-discover";
import { booleanFlag, type ParsedCommandArgs, stringFlag } from "../../../command-args";
import { withThrowExit } from "../../../exit";
import type { SlashHandler } from "../registry";

function positiveIntegerFlag(parsed: ParsedCommandArgs, name: string): number | undefined {
    const raw = stringFlag(parsed, name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : undefined;
}

export const handleDiscover: SlashHandler = async (ctx, parsedArgs) => {
    const { projectPath } = ctx;
    const action = parsedArgs.positionals[0]?.toLowerCase();
    if (action === "status" || booleanFlag(parsedArgs, "status")) {
        const st = getBackgroundDiscoverStatus();
        if (st.status === "idle") {
            const { discoverCommand } = await import("../../../../commands/discover");
            await ctx.runParity("discover", () => discoverCommand(undefined, { status: true }));
        } else {
            console.log(
                accent("\n  Background discover") +
                    dim(
                        `  ·  ${st.status}  ·  ${st.pages}/${st.maxPages} pages` +
                            `  ·  ${st.links} links  ·  ${st.startUrl}`,
                    ),
            );
            if (st.currentUrl) console.log(dim(`  current: ${st.currentUrl}`));
            if (st.status === "failed" && st.error) {
                console.log(chalk.red(`  error: ${st.error}`));
            }
            console.log("");
        }
        return;
    }
    if (action === "continue" || booleanFlag(parsedArgs, "continue")) {
        try {
            await continueBackgroundDiscover(projectPath, {
                skipAuth: booleanFlag(parsedArgs, "skipAuth"),
            });
        } catch (err) {
            console.log(chalk.red(`  ✗ ${safeCliErrorMessage(err)}`));
        }
        return;
    }
    const url = stringFlag(parsedArgs, "bg") ?? parsedArgs.positionals[0] ?? "";
    if (!url) {
        console.log(
            chalk.red("  usage: /discover <url>") +
                dim("  ·  /discover --continue  ·  /discover status"),
        );
        return;
    }
    try {
        if (booleanFlag(parsedArgs, "auth")) {
            const { authCommand } = await import("../../../../commands/auth");
            const authCode = await withThrowExit(() =>
                authCommand({ url, createManualSaveWatcher: ctx.createManualSaveWatcher }),
            );
            if (authCode !== 0) {
                console.log(dim(`  (auth exited with code ${authCode})`));
                return;
            }
        }
        await startBackgroundDiscover({
            url,
            projectPath,
            maxPages: positiveIntegerFlag(parsedArgs, "maxPages"),
            maxDepth: positiveIntegerFlag(parsedArgs, "maxDepth"),
            timeout: positiveIntegerFlag(parsedArgs, "timeout"),
            skipAuth: booleanFlag(parsedArgs, "skipAuth"),
        });
    } catch (err) {
        console.log(chalk.red(`  ✗ ${safeCliErrorMessage(err)}`));
    }
};

export const discoverySlashHandlers: Record<string, SlashHandler> = {
    discover: handleDiscover,
};
