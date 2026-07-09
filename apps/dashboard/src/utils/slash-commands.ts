/**
 * Slash-command registry for the chat sidebar.
 *
 * Each command is a small function-call the dashboard knows how to run locally:
 * navigate to a view, kick off a tRPC mutation, or adjust client state. Typing
 * `/` in the chat input opens an autocomplete menu driven by this registry.
 *
 * To add a new command: push an entry here, declare its args, and write a tiny
 * handler. The UI picks it up automatically.
 */

import type { trpc } from "./trpc";

export type DashboardView = "testing" | "discovery" | "quality" | "settings";

/** Inferred tRPC utils type (return of `trpc.useUtils()`). */
export type TRPCUtils = ReturnType<typeof trpc.useUtils>;
export type SidebarTab = "chat" | "files";

/** A sub-route inside a view (e.g. `quality/doctor`). */
export type DashboardRoute =
    | { view: "testing"; tab?: SidebarTab }
    | { view: "discovery" }
    | { view: "quality"; tool?: "doctor" | "impact" | "trace" | "cover" | "context" }
    | { view: "settings" };

export interface SlashContext {
    /** Navigate to a view/route. Changes `window.location.hash`. */
    navigate: (route: DashboardRoute) => void;
    /** Switch just the sidebar tab (chat vs files) without changing views. */
    setSidebarTab: (tab: SidebarTab) => void;
    /** Clear the chat transcript (server-side + local). */
    clearChat: () => void;
    /** Append a synthetic message to the local chat transcript. */
    echoSystem: (markdown: string) => void;
    /** Interrupt the running agent. Returns whether anything was stopped. */
    stop: () => boolean;
    /** tRPC utilities for firing mutations from handlers. */
    trpcUtils: TRPCUtils;
}

export interface SlashResult {
    /** Short status line shown in the chat. Markdown is allowed. */
    message: string;
    /** If true, the raw `/command` text is NOT also appended to chat. */
    silent?: boolean;
}

export interface SlashCommand {
    /** Canonical name, without leading slash. */
    name: string;
    /** Alternate names that also match this command. */
    aliases?: string[];
    /** One-line description (used in autocomplete + `/help`). */
    description: string;
    /** Optional argument hint shown next to the name (e.g. `[url]`). */
    argsHint?: string;
    /** Group label for organising `/help`. */
    group?: "navigate" | "run" | "utility";
    /** Executes the command. Return a message to echo in the chat. */
    execute(args: string, ctx: SlashContext): Promise<SlashResult> | SlashResult;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const COMMANDS: SlashCommand[] = [
    // ---- Navigate ---------------------------------------------------------
    {
        name: "tests",
        aliases: ["testing", "t"],
        description: "Open the testing view (chat + code editor).",
        group: "navigate",
        execute(_args, ctx) {
            ctx.navigate({ view: "testing" });
            return { message: "Opened **testing**.", silent: true };
        },
    },
    {
        name: "files",
        description: "Switch the sidebar to the file tree.",
        group: "navigate",
        execute(_args, ctx) {
            ctx.setSidebarTab("files");
            return { message: "Switched sidebar to **files**.", silent: true };
        },
    },
    {
        name: "chat",
        description: "Switch the sidebar back to chat.",
        group: "navigate",
        execute(_args, ctx) {
            ctx.setSidebarTab("chat");
            return { message: "Switched sidebar to **chat**.", silent: true };
        },
    },
    {
        name: "settings",
        aliases: ["config"],
        description: "Open Raiken settings (AI provider, browser, discovery…).",
        group: "navigate",
        execute(_args, ctx) {
            ctx.navigate({ view: "settings" });
            return { message: "Opened **settings**.", silent: true };
        },
    },

    // ---- Run --------------------------------------------------------------
    {
        name: "discovery",
        aliases: ["discover", "crawl"],
        argsHint: "[url]",
        description: "Open discovery. Pass a URL to kick off a crawl immediately.",
        group: "run",
        async execute(args, ctx) {
            const url = args.trim();
            ctx.navigate({ view: "discovery" });

            if (!url) {
                return {
                    message:
                        "Opened **discovery**. Provide a URL to start a crawl: `/discovery https://example.com`.",
                };
            }

            if (!/^https?:\/\//i.test(url)) {
                return {
                    message: `\`${url}\` doesn't look like a URL. Try \`/discovery https://…\`.`,
                };
            }

            try {
                const result = await ctx.trpcUtils.client.startDiscovery.mutate({ url });
                if (!result.success) {
                    return {
                        message: `Discovery didn't start: ${result.message}`,
                    };
                }
                return {
                    message: `Started discovery on \`${url}\`. Live status on the Discovery view.`,
                };
            } catch (err) {
                return {
                    message: `Failed to start discovery: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
        },
    },
    {
        name: "doctor",
        description: "Open the doctor panel (test-suite anti-pattern lint).",
        group: "run",
        execute(_args, ctx) {
            ctx.navigate({ view: "quality", tool: "doctor" });
            return { message: "Running **raiken doctor**.", silent: true };
        },
    },
    {
        name: "impact",
        aliases: ["ci"],
        description: "Open the impact / CI panel (affected tests for a diff).",
        group: "run",
        execute(_args, ctx) {
            ctx.navigate({ view: "quality", tool: "impact" });
            return { message: "Opened **impact** (raiken ci).", silent: true };
        },
    },
    {
        name: "trace",
        argsHint: "[stack trace]",
        description: "Open the trace panel. Paste a stack trace to pre-fill.",
        group: "run",
        execute(args, ctx) {
            if (args.trim()) {
                try {
                    sessionStorage.setItem("raiken.prefill.trace", args.trim());
                } catch {
                    // sessionStorage unavailable — still navigate
                }
            }
            ctx.navigate({ view: "quality", tool: "trace" });
            return {
                message: args.trim()
                    ? "Pre-filled trace and opened **trace**."
                    : "Opened **trace**.",
                silent: true,
            };
        },
    },
    {
        name: "cover",
        argsHint: "[target or AC id]",
        description: "Open cover (Playwright spec drafter). Pre-fills the target field.",
        group: "run",
        execute(args, ctx) {
            if (args.trim()) {
                try {
                    sessionStorage.setItem("raiken.prefill.cover", args.trim());
                } catch {
                    // ignore
                }
            }
            ctx.navigate({ view: "quality", tool: "cover" });
            return {
                message: args.trim()
                    ? `Pre-filled cover target \`${args.trim()}\` and opened **cover**.`
                    : "Opened **cover**.",
                silent: true,
            };
        },
    },
    {
        name: "context",
        aliases: ["ctx"],
        description: "Generate raiken.ctx.md from project state.",
        group: "run",
        async execute(_args, ctx) {
            ctx.navigate({ view: "quality", tool: "context" });
            try {
                const result = await ctx.trpcUtils.client.writeContext.mutate({});
                return {
                    message: `Wrote context to \`${result.relativePath}\`.`,
                };
            } catch (err) {
                return {
                    message: `Failed to write context: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
        },
    },
    {
        name: "sync",
        description: "Sync the current git branch with its ticket provider.",
        group: "run",
        async execute(_args, ctx) {
            try {
                const result = await ctx.trpcUtils.client.syncTicket.mutate({});
                const ticket = (result as { ticket?: { id?: string; title?: string } } | null)
                    ?.ticket;
                if (ticket?.id) {
                    return {
                        message: `Ticket sync: \`${ticket.id}\`${ticket.title ? ` — ${ticket.title}` : ""}.`,
                    };
                }
                return { message: "Ticket sync completed." };
            } catch (err) {
                return {
                    message: `Ticket sync failed: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
        },
    },
    {
        name: "build",
        aliases: ["reindex", "rebuild"],
        description: "Re-index the project (rebuild the code graph).",
        group: "run",
        async execute(_args, ctx) {
            try {
                const result = await ctx.trpcUtils.client.buildCodeGraph.mutate({
                    path: ".",
                    persist: true,
                });
                return {
                    message: `Rebuilt code graph — ${result.stats.totalFiles} files, ${result.stats.totalFunctions} functions.`,
                };
            } catch (err) {
                return {
                    message: `Rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
        },
    },
    {
        name: "test",
        aliases: ["run-tests"],
        argsHint: "[file or test name]",
        description:
            "Run Playwright tests. Optional pattern filters by name; pass a path to scope.",
        group: "run",
        async execute(args, ctx) {
            const arg = args.trim();
            // A path-ish arg is treated as a file scope; everything else as a name filter.
            const looksLikeFile = /[\\/]/.test(arg) || /\.(spec|test)\.(t|j)sx?$/.test(arg);
            const input = arg
                ? looksLikeFile
                    ? { testFile: arg, parallel: true }
                    : { testName: arg, parallel: true }
                : { parallel: true };

            ctx.echoSystem(
                arg ? `Running tests matching \`${arg}\`…` : "Running the full test suite…",
            );
            try {
                const result = (await ctx.trpcUtils.client.runTests.mutate(input)) as {
                    success: boolean;
                    exitCode: number | null;
                    results: { stats?: { expected?: number; unexpected?: number } } | null;
                };
                const stats = result.results?.stats;
                const passed = stats?.expected ?? 0;
                const failed = stats?.unexpected ?? 0;
                const headline = result.success
                    ? `Tests passed (${passed} green)`
                    : `Tests failed — ${failed} red, ${passed} green (exit ${result.exitCode ?? "?"})`;
                return { message: headline };
            } catch (err) {
                return {
                    message: `Test run failed: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
        },
    },
    // ---- Utility ----------------------------------------------------------
    {
        name: "stop",
        aliases: ["abort", "cancel"],
        description: "Interrupt the agent that is currently running.",
        group: "utility",
        execute(_args, ctx) {
            const stopped = ctx.stop();
            return {
                message: stopped ? "Stopped the running agent." : "Nothing is running.",
                silent: true,
            };
        },
    },
    {
        name: "clear",
        description: "Clear the chat transcript.",
        group: "utility",
        execute(_args, ctx) {
            ctx.clearChat();
            return { message: "Cleared chat.", silent: true };
        },
    },
    {
        name: "help",
        aliases: ["?"],
        description: "Show the full slash-command reference.",
        group: "utility",
        execute(_args, ctx) {
            const groups: Record<string, SlashCommand[]> = {};
            for (const cmd of COMMANDS) {
                const g = cmd.group ?? "utility";
                const bucket = groups[g] ?? [];
                bucket.push(cmd);
                groups[g] = bucket;
            }
            const order: Array<keyof typeof groups> = ["navigate", "run", "utility"];
            const labels: Record<string, string> = {
                navigate: "Navigate",
                run: "Run",
                utility: "Utility",
            };
            const lines: string[] = ["**Slash commands**", ""];
            for (const key of order) {
                const cmds = groups[key];
                if (!cmds?.length) continue;
                lines.push(`_${labels[key]}_`);
                for (const cmd of cmds) {
                    const alias = cmd.aliases?.length
                        ? ` · aliases: \`${cmd.aliases.join(", ")}\``
                        : "";
                    lines.push(
                        `- \`/${cmd.name}${cmd.argsHint ? ` ${cmd.argsHint}` : ""}\` — ${cmd.description}${alias}`,
                    );
                }
                lines.push("");
            }
            ctx.echoSystem(lines.join("\n"));
            return { message: "", silent: true };
        },
    },
];

export const SLASH_COMMANDS = COMMANDS;

// ---------------------------------------------------------------------------
// Lookup + parsing helpers
// ---------------------------------------------------------------------------

/** Parse a raw chat input into { commandName, args } if it starts with `/`. */
export function parseSlashInput(input: string): { name: string; args: string } | null {
    const trimmed = input.trimStart();
    if (!trimmed.startsWith("/")) return null;
    const body = trimmed.slice(1);
    const spaceIdx = body.search(/\s/);
    if (spaceIdx === -1) {
        return { name: body.toLowerCase(), args: "" };
    }
    return {
        name: body.slice(0, spaceIdx).toLowerCase(),
        args: body.slice(spaceIdx + 1).trimStart(),
    };
}

/** Resolve a command by canonical name or alias. */
export function findSlashCommand(name: string): SlashCommand | undefined {
    if (!name) return undefined;
    const lower = name.toLowerCase();
    return COMMANDS.find((c) => c.name === lower || (c.aliases?.includes(lower) ?? false));
}

/** Return the commands whose name/alias starts with `query` (case-insensitive). */
export function matchSlashCommands(query: string): SlashCommand[] {
    const q = query.toLowerCase();
    if (!q) return COMMANDS;
    const starts: SlashCommand[] = [];
    const contains: SlashCommand[] = [];
    for (const cmd of COMMANDS) {
        const names = [cmd.name, ...(cmd.aliases ?? [])];
        if (names.some((n) => n.startsWith(q))) starts.push(cmd);
        else if (names.some((n) => n.includes(q))) contains.push(cmd);
    }
    return [...starts, ...contains];
}
