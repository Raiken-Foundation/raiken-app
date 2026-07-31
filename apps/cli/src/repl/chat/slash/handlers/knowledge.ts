import chalk from "chalk";
import { booleanFlag, stringFlag } from "../../../command-args";
import type { ChatReplContext } from "../../types";
import type { SlashHandler } from "../registry";

/** Readline-based y/N confirm for destructive slash actions (inquirer can't run inside the REPL). */
const replConfirm =
    (ctx: ChatReplContext) =>
    async (message: string): Promise<boolean> => {
        const answer = await ctx.askCancelable(`  ${message}? [y/N] `);
        const normalized = answer?.trim().toLowerCase();
        return normalized === "y" || normalized === "yes";
    };

export const handleStatus: SlashHandler = async (ctx, parsedArgs) => {
    const { statusCommand } = await import("../../../../commands/status");
    await ctx.runParity("status", () => statusCommand({ json: booleanFlag(parsedArgs, "json") }));
};

export const handleKnowledge: SlashHandler = async (ctx, parsedArgs) => {
    const [ksub, ...krest] = parsedArgs.positionals;
    const { knowledgeCommand } = await import("../../../../commands/knowledge");
    await ctx.runParity("knowledge", () =>
        knowledgeCommand(ksub, krest.join(" ") || undefined, {
            limit: stringFlag(parsedArgs, "limit"),
            json: booleanFlag(parsedArgs, "json"),
            force: booleanFlag(parsedArgs, "force"),
            confirm: replConfirm(ctx),
        }),
    );
};

export const handleSearch: SlashHandler = async (ctx, parsedArgs) => {
    const query = parsedArgs.positionals.join(" ");
    if (!query) return void console.log(chalk.red("  usage: /search <query>"));
    const { searchCommand } = await import("../../../../commands/search");
    await ctx.runParity("search", () =>
        searchCommand(query, {
            limit: stringFlag(parsedArgs, "limit"),
            type: stringFlag(parsedArgs, "type"),
            json: booleanFlag(parsedArgs, "json"),
        }),
    );
};

export const handleMemory: SlashHandler = async (ctx, parsedArgs) => {
    const { memoryCommand } = await import("../../../../commands/memory");
    await ctx.runParity("memory", () =>
        memoryCommand(parsedArgs.positionals[0], {
            json: booleanFlag(parsedArgs, "json"),
            force: booleanFlag(parsedArgs, "force"),
            confirm: replConfirm(ctx),
        }),
    );
};

export const handleIndex: SlashHandler = async (ctx, parsedArgs) => {
    const { indexCommand } = await import("../../../../commands/indexer");
    await ctx.runParity("index", () =>
        indexCommand({
            embeddings:
                booleanFlag(parsedArgs, "embeddings") ||
                parsedArgs.positionals.includes("embeddings"),
            force: booleanFlag(parsedArgs, "force"),
        }),
    );
};

export const knowledgeSlashHandlers: Record<string, SlashHandler> = {
    status: handleStatus,
    knowledge: handleKnowledge,
    search: handleSearch,
    memory: handleMemory,
    index: handleIndex,
};
