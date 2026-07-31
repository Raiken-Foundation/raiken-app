/**
 * Cross-surface slash-command metadata for commands whose semantics genuinely
 * match between the CLI REPL and the dashboard chat composer.
 *
 * Each adapter keeps its own registry and handlers — this module only shares
 * canonical names, aliases, and descriptions so the two surfaces don't drift.
 */

export interface SharedSlashCommandMetadata {
    /** Canonical command name (no leading slash). */
    name: string;
    aliases?: readonly string[];
    description: string;
    argsHint?: string;
}

/** Commands with the same meaning on CLI and dashboard (different UX, same intent). */
export const SHARED_SLASH_COMMAND_METADATA: readonly SharedSlashCommandMetadata[] = [
    {
        name: "help",
        aliases: ["?"],
        description: "Show every command and shortcut",
    },
    {
        name: "clear",
        description: "Clear conversation context and memory",
    },
    {
        name: "doctor",
        description: "Find flaky test anti-patterns",
        argsHint: "[options]",
    },
    {
        name: "test",
        description: "Run the Playwright suite or one spec",
        argsHint: "[file] [--json]",
    },
    {
        name: "discover",
        aliases: ["discovery"],
        description: "Crawl the app in the background",
        argsHint: "<url|status|--continue> [options]",
    },
    {
        name: "trace",
        description: "Map a stack trace to tests",
        argsHint: "[trace] [options]",
    },
    {
        name: "cover",
        description: "Draft a spec for a target",
        argsHint: "<target> [options]",
    },
    {
        name: "context",
        description: "Write a project context file",
        argsHint: "[options]",
    },
    {
        name: "sync",
        description: "Sync the current ticket",
        argsHint: "[--ticket <id>]",
    },
    {
        name: "ci",
        aliases: ["impact"],
        description: "Analyze changes and run affected tests",
        argsHint: "[options]",
    },
] as const;

const sharedByName = new Map(
    SHARED_SLASH_COMMAND_METADATA.flatMap((entry) => [
        [entry.name, entry] as const,
        ...(entry.aliases ?? []).map((alias) => [alias, entry] as const),
    ]),
);

/** Look up shared metadata by canonical name or alias. */
export function findSharedSlashMetadata(name: string): SharedSlashCommandMetadata | undefined {
    return sharedByName.get(name.toLowerCase());
}
