/**
 * One source of truth for slash discovery, filtering, completion, help, and
 * unknown-command suggestions. Dispatch remains in chat.ts because handlers
 * close over the live browser, session, and tRPC caller.
 */

export type SlashCommandGroup = "Agent" | "Browser / DOM" | "Knowledge" | "Testing" | "Session";

export interface SlashCommandDefinition {
    name: string;
    aliases?: readonly string[];
    description: string;
    argsHint?: string;
    group: SlashCommandGroup;
}

export const SLASH_COMMAND_REGISTRY: readonly SlashCommandDefinition[] = [
    {
        name: "help",
        aliases: ["?"],
        description: "Show every command and shortcut",
        group: "Agent",
    },
    {
        name: "plan",
        description: "Preview steps before the agent runs",
        argsHint: "[on|off]",
        group: "Agent",
    },
    {
        name: "mode",
        aliases: ["permissions"],
        description: "Change save and run permissions",
        argsHint: "[ask|auto-save|auto-run|yolo]",
        group: "Agent",
    },
    {
        name: "verbose",
        description: "Toggle detailed tool-call output",
        group: "Agent",
    },
    {
        name: "config",
        aliases: ["ai"],
        description: "Paste an API key, or set provider/key/model (use `raiken config` for the wizard)",
        argsHint: "<api-key> | [--provider <id>] [--api-key <key>] [--model <id>] [--list]",
        group: "Agent",
    },
    {
        name: "status",
        description: "Show project setup and indexes",
        argsHint: "[--json]",
        group: "Knowledge",
    },
    {
        name: "discover",
        description: "Crawl the app in the background",
        argsHint: "<url|status|--continue> [options]",
        group: "Knowledge",
    },
    {
        name: "test",
        description: "Run the Playwright suite or one spec",
        argsHint: "[file] [--json]",
        group: "Testing",
    },
    {
        name: "report",
        description: "Run tests and write a detailed report",
        argsHint: "[file] [options]",
        group: "Testing",
    },
    {
        name: "sessions",
        aliases: ["session"],
        description: "List or save conversations",
        argsHint: "[list|save <name>]",
        group: "Session",
    },
    {
        name: "goto",
        description: "Navigate the browser to a URL",
        argsHint: "<url>",
        group: "Browser / DOM",
    },
    {
        name: "click",
        description: "Click an element",
        argsHint: "<selector>",
        group: "Browser / DOM",
    },
    {
        name: "fill",
        description: "Fill an input",
        argsHint: "<selector> = <value>",
        group: "Browser / DOM",
    },
    {
        name: "type",
        description: "Type into an element",
        argsHint: "<selector> = <text>",
        group: "Browser / DOM",
    },
    {
        name: "press",
        description: "Press a keyboard key",
        argsHint: "<key>",
        group: "Browser / DOM",
    },
    {
        name: "snapshot",
        description: "Print the current page DOM",
        group: "Browser / DOM",
    },
    { name: "url", description: "Show the current URL", group: "Browser / DOM" },
    { name: "back", description: "Go back in browser history", group: "Browser / DOM" },
    { name: "reload", description: "Reload the current page", group: "Browser / DOM" },
    {
        name: "screenshot",
        description: "Save a screenshot as PNG",
        group: "Browser / DOM",
    },
    {
        name: "knowledge",
        aliases: ["kb"],
        description: "Inspect discovered pages and blockers",
        argsHint: "[section] [arg] [options]",
        group: "Knowledge",
    },
    {
        name: "search",
        description: "Search code semantically",
        argsHint: "<query> [options]",
        group: "Knowledge",
    },
    {
        name: "index",
        description: "Rebuild code graph or embeddings",
        argsHint: "[--embeddings] [--force]",
        group: "Knowledge",
    },
    {
        name: "memory",
        description: "Inspect or clear agent memory",
        argsHint: "[clear] [--json]",
        group: "Knowledge",
    },
    { name: "tests", description: "List discovered test files", group: "Testing" },
    {
        name: "cover",
        description: "Draft a spec for a target",
        argsHint: "<target> [options]",
        group: "Testing",
    },
    {
        name: "ci",
        description: "Analyze changes and run affected tests",
        argsHint: "[options]",
        group: "Testing",
    },
    {
        name: "doctor",
        description: "Find flaky test anti-patterns",
        argsHint: "[options]",
        group: "Testing",
    },
    {
        name: "trace",
        description: "Map a stack trace to tests",
        argsHint: "[trace] [options]",
        group: "Testing",
    },
    {
        name: "context",
        description: "Write a project context file",
        argsHint: "[options]",
        group: "Testing",
    },
    {
        name: "sync",
        description: "Sync the current ticket",
        argsHint: "[--ticket <id>]",
        group: "Testing",
    },
    {
        name: "auth",
        description: "Capture or import authentication state",
        argsHint: "[url] [options]",
        group: "Testing",
    },
    {
        name: "organize",
        description: "Reorganize tests into feature folders, clean up config",
        argsHint: "[--yes] [--tests-only] [--config-only] [--json]",
        group: "Testing",
    },
    {
        name: "hooks",
        description: "Install, remove, or inspect git hooks",
        argsHint: "<install|uninstall|status> [options]",
        group: "Testing",
    },
    {
        name: "save",
        description: "Save this conversation",
        argsHint: "<name>",
        group: "Session",
    },
    {
        name: "resume",
        description: "Load a saved conversation",
        argsHint: "[name]",
        group: "Session",
    },
    {
        name: "clear",
        description: "Clear conversation context and memory",
        group: "Session",
    },
    {
        name: "exit",
        aliases: ["quit"],
        description: "Close the browser and quit",
        group: "Session",
    },
] as const;

export const SLASH_COMMANDS = SLASH_COMMAND_REGISTRY.map((command) => command.name);

export interface ParsedSlashLine {
    command: string;
    args: string;
    hasArgs: boolean;
}

export function parseSlashLine(line: string): ParsedSlashLine | null {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("/")) return null;
    const body = trimmed.slice(1);
    const space = body.search(/\s/);
    if (space === -1) {
        return { command: body.toLowerCase(), args: "", hasArgs: false };
    }
    return {
        command: body.slice(0, space).toLowerCase(),
        args: body.slice(space).trim(),
        hasArgs: true,
    };
}

export function matchSlashCommands(query: string): SlashCommandDefinition[] {
    const normalized = query.replace(/^\//, "").trim().toLowerCase();
    if (!normalized) return [...SLASH_COMMAND_REGISTRY];

    return SLASH_COMMAND_REGISTRY.filter((command) => {
        const names = [command.name, ...(command.aliases ?? [])];
        return names.some((name) => name.startsWith(normalized));
    });
}

export function resolveSlashCommand(name: string): SlashCommandDefinition | null {
    const normalized = name.toLowerCase();
    return (
        SLASH_COMMAND_REGISTRY.find(
            (command) =>
                command.name === normalized || (command.aliases ?? []).includes(normalized),
        ) ?? null
    );
}

export function shouldShowSlashMenu(line: string): boolean {
    const parsed = parseSlashLine(line);
    return parsed !== null && !parsed.hasArgs;
}

/** Compact, width-aware menu used by the live terminal overlay. */
export function renderSlashMenu(line = "/", width = 80, limit = 8): string[] {
    const parsed = parseSlashLine(line);
    const query = parsed?.command ?? "";
    const matches = matchSlashCommands(query).slice(0, limit);
    const commandWidth = Math.min(
        20,
        Math.max(10, ...matches.map((command) => command.name.length + 2)),
    );
    const descriptionWidth = Math.max(12, width - commandWidth - 5);
    const rows = matches.map((command) => {
        const label = `/${command.name}`.padEnd(commandWidth);
        const description =
            command.description.length > descriptionWidth
                ? `${command.description.slice(0, descriptionWidth - 1)}…`
                : command.description;
        return `  ${label} ${description}`;
    });
    if (rows.length === 0) rows.push(`  No commands match "/${query}"`);
    return [
        `  Slash commands${query ? ` matching "/${query}"` : ""}`,
        ...rows,
        "  Tab to complete · /help for all",
    ];
}

function longestCommonPrefix(values: string[]): string {
    let prefix = values[0] ?? "";
    for (const value of values.slice(1)) {
        let i = 0;
        while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
        prefix = prefix.slice(0, i);
    }
    return prefix;
}

/**
 * Node readline completer. Returns `[hits, originalLine]`.
 *
 * Never returns more than one hit: with multiple hits readline prints a
 * multi-column completion list below the input and re-renders the prompt on
 * a new row, which desynchronizes the slash overlay's row accounting (the
 * erase then eats the wrong region and leaves a stale menu in scrollback).
 * The overlay already displays the matches, so an ambiguous Tab completes
 * the unambiguous common prefix — or does nothing.
 */
export function slashCompleter(line: string): [string[], string] {
    const parsed = parseSlashLine(line);
    if (!parsed || parsed.hasArgs) return [[], line];
    const hits = matchSlashCommands(parsed.command).flatMap((command) => {
        const names = [command.name, ...(command.aliases ?? [])];
        return names.filter((name) => name.startsWith(parsed.command)).map((name) => `/${name}`);
    });
    if (hits.length <= 1) return [hits, line];

    const prefix = longestCommonPrefix(hits);
    const current = `/${parsed.command}`;
    return prefix.length > current.length ? [[prefix], line] : [[], line];
}
