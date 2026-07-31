import chalk from "chalk";
import { dim } from "../../../../agent-stream";
import { booleanFlag, stringFlag, stringFlags } from "../../../command-args";
import type { SlashHandler } from "../registry";

export const handleTests: SlashHandler = async (ctx) => {
    const files = ctx.app.indexing.getGraphFiles({ limit: 500, offset: 0 });
    const specs = files.files.filter((f) => /\.(spec|test|e2e)\.[tj]sx?$/.test(f.path));
    if (specs.length === 0) return void console.log(dim("  No test files found."));
    for (const s of specs.slice(0, 100)) console.log(`  ${dim("•")} ${s.path}`);
};

export const handleTest: SlashHandler = async (ctx, parsedArgs) => {
    const { testCommand } = await import("../../../../commands/test");
    await ctx.runParity("test", () =>
        testCommand(parsedArgs.positionals[0], {
            json: booleanFlag(parsedArgs, "json"),
            headed: booleanFlag(parsedArgs, "headed"),
            list: booleanFlag(parsedArgs, "list"),
            onlyFlaky: booleanFlag(parsedArgs, "onlyFlaky"),
            fix: booleanFlag(parsedArgs, "fix"),
            updateSnapshots: booleanFlag(parsedArgs, "updateSnapshots"),
            grep: stringFlag(parsedArgs, "grep", "g"),
            workers: stringFlag(parsedArgs, "workers"),
            project: stringFlag(parsedArgs, "project"),
            retries: stringFlag(parsedArgs, "retries"),
            confirm: async (message) => {
                const answer = (await ctx.ask(`${message} (y/N) `)).trim().toLowerCase();
                return answer === "y" || answer === "yes";
            },
        }),
    );
};

export const handleRepair: SlashHandler = async (ctx, parsedArgs) => {
    const { repairCommand } = await import("../../../../commands/repair");
    await ctx.runParity("repair", () =>
        repairCommand(parsedArgs.positionals[0], {
            apply: booleanFlag(parsedArgs, "apply"),
            json: booleanFlag(parsedArgs, "json"),
            interpret: !booleanFlag(parsedArgs, "noInterpret"),
            confirm: async (message) => {
                const answer = (await ctx.ask(`${message} (y/N) `)).trim().toLowerCase();
                return answer === "y" || answer === "yes";
            },
        }),
    );
};

export const handleReport: SlashHandler = async (ctx, parsedArgs) => {
    const { reportCommand } = await import("../../../../commands/report");
    await ctx.runParity("report", () =>
        reportCommand(parsedArgs.positionals[0], {
            from: stringFlag(parsedArgs, "from"),
            format: stringFlag(parsedArgs, "format"),
            output: stringFlag(parsedArgs, "output"),
            open: booleanFlag(parsedArgs, "open"),
            json: booleanFlag(parsedArgs, "json"),
            embedScreenshots: booleanFlag(parsedArgs, "noEmbedScreenshots") ? false : undefined,
        }),
    );
};

export const handleDoctor: SlashHandler = async (ctx, parsedArgs) => {
    const { doctorCommand } = await import("../../../../commands/doctor");
    await ctx.runParity("doctor", () =>
        doctorCommand({
            dir: stringFlag(parsedArgs, "dir"),
            failOn: stringFlag(parsedArgs, "failOn"),
            json: booleanFlag(parsedArgs, "json"),
        }),
    );
};

export const handleContext: SlashHandler = async (ctx, parsedArgs) => {
    const { contextCommand } = await import("../../../../commands/context");
    await ctx.runParity("context", () =>
        contextCommand({
            output: stringFlag(parsedArgs, "output"),
            maxRows: stringFlag(parsedArgs, "maxRows"),
            impact: !booleanFlag(parsedArgs, "noImpact"),
            json: booleanFlag(parsedArgs, "json"),
        }),
    );
};

export const handleCi: SlashHandler = async (ctx, parsedArgs) => {
    const { ciCommand } = await import("../../../../commands/ci");
    await ctx.runParity("ci", () =>
        ciCommand({
            base: stringFlag(parsedArgs, "base"),
            head: stringFlag(parsedArgs, "head"),
            staged: booleanFlag(parsedArgs, "staged"),
            outputDir: stringFlag(parsedArgs, "outputDir"),
            format: stringFlag(parsedArgs, "format"),
            confidence: stringFlag(parsedArgs, "confidence"),
            maxTests: stringFlag(parsedArgs, "maxTests"),
            timeout: stringFlag(parsedArgs, "timeout"),
            skipRun: booleanFlag(parsedArgs, "skipRun"),
            json: booleanFlag(parsedArgs, "json"),
        }),
    );
};

export const handleCover: SlashHandler = async (ctx, parsedArgs) => {
    const target = parsedArgs.positionals.join(" ");
    if (!target) return void console.log(chalk.red("  usage: /cover <target>"));
    const { coverCommand } = await import("../../../../commands/cover");
    await ctx.runParity("cover", () =>
        coverCommand(target, {
            ticket: stringFlag(parsedArgs, "ticket", "t"),
            output: stringFlag(parsedArgs, "output", "o"),
            dir: stringFlag(parsedArgs, "dir"),
            dryRun: booleanFlag(parsedArgs, "dryRun"),
            json: booleanFlag(parsedArgs, "json"),
        }),
    );
};

export const handleTrace: SlashHandler = async (ctx, parsedArgs) => {
    const { traceCommand } = await import("../../../../commands/trace");
    await ctx.runParity("trace", () =>
        traceCommand(parsedArgs.positionals.join(" ") || undefined, {
            file: stringFlag(parsedArgs, "file", "f"),
            minConfidence: stringFlag(parsedArgs, "minConfidence"),
            limit: stringFlag(parsedArgs, "limit"),
            json: booleanFlag(parsedArgs, "json"),
        }),
    );
};

export const handleSync: SlashHandler = async (ctx, parsedArgs) => {
    const { syncCommand } = await import("../../../../commands/sync");
    await ctx.runParity("sync", () =>
        syncCommand({ ticket: stringFlag(parsedArgs, "ticket", "t") }),
    );
};

export const handleAuth: SlashHandler = async (ctx, parsedArgs) => {
    const { authCommand } = await import("../../../../commands/auth");
    await ctx.runParity("auth", () =>
        authCommand({
            url: stringFlag(parsedArgs, "url") ?? parsedArgs.positionals[0],
            cookie: stringFlag(parsedArgs, "cookie"),
            domain: stringFlag(parsedArgs, "domain"),
            storage: stringFlags(parsedArgs, "storage"),
            fromStateFile: stringFlag(parsedArgs, "fromStateFile"),
            createManualSaveWatcher: ctx.createManualSaveWatcher,
        }),
    );
};

export const handleOrganize: SlashHandler = async (ctx, parsedArgs) => {
    const { organizeCommand } = await import("../../../../commands/organize");
    await ctx.runParity("organize", () =>
        organizeCommand({
            yes: booleanFlag(parsedArgs, "yes", "y"),
            testsOnly: booleanFlag(parsedArgs, "testsOnly"),
            configOnly: booleanFlag(parsedArgs, "configOnly"),
            json: booleanFlag(parsedArgs, "json"),
            confirm: async (message) => {
                const answer = (await ctx.ask(`${message} (y/N) `)).trim().toLowerCase();
                return answer === "y" || answer === "yes";
            },
        }),
    );
};

export const handleHooks: SlashHandler = async (ctx, parsedArgs) => {
    const [sub] = parsedArgs.positionals;
    const hooksType = stringFlag(parsedArgs, "type");
    if (sub === "install") {
        const { hooksInstallCommand } = await import("../../../../commands/hooks");
        await ctx.runParity("hooks install", () =>
            hooksInstallCommand({
                type: hooksType,
                skipRun: booleanFlag(parsedArgs, "skipRun"),
                husky: booleanFlag(parsedArgs, "husky"),
            }),
        );
        return;
    }
    if (sub === "uninstall") {
        const { hooksUninstallCommand } = await import("../../../../commands/hooks");
        await ctx.runParity("hooks uninstall", () => hooksUninstallCommand({ type: hooksType }));
        return;
    }
    if (!sub || sub === "status") {
        const { hooksStatusCommand } = await import("../../../../commands/hooks");
        await ctx.runParity("hooks status", () => hooksStatusCommand());
        return;
    }
    console.log(
        chalk.red(`  Unknown hooks subcommand: ${sub}`) + dim("  — install | uninstall | status"),
    );
};

export const testingSlashHandlers: Record<string, SlashHandler> = {
    tests: handleTests,
    test: handleTest,
    repair: handleRepair,
    report: handleReport,
    doctor: handleDoctor,
    context: handleContext,
    ci: handleCi,
    cover: handleCover,
    trace: handleTrace,
    sync: handleSync,
    auth: handleAuth,
    organize: handleOrganize,
    hooks: handleHooks,
};
