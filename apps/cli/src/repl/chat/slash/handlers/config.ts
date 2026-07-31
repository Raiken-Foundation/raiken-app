import { booleanFlag, stringFlag } from "../../../command-args";
import type { SlashHandler } from "../registry";

export const handleConfig: SlashHandler = async (ctx, parsedArgs) => {
    const { configCommand } = await import("../../../../commands/config");
    await ctx.runParity("config", () =>
        configCommand(parsedArgs.positionals[0], {
            provider: stringFlag(parsedArgs, "provider"),
            apiKey: stringFlag(parsedArgs, "apiKey"),
            model: stringFlag(parsedArgs, "model"),
            baseUrl: stringFlag(parsedArgs, "baseUrl"),
            unsetKey: booleanFlag(parsedArgs, "unsetKey"),
            list: booleanFlag(parsedArgs, "list"),
            json: booleanFlag(parsedArgs, "json"),
            fromRepl: true,
            replAsk: ctx.askCancelable,
            replAskSecret: ctx.askSecret,
        }),
    );
};

export const configSlashHandlers: Record<string, SlashHandler> = {
    config: handleConfig,
};
