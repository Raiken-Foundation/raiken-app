/**
 * Slash-command completer for the readline REPL.
 * Filters the known command list as the user types `/do` → `/doctor`, etc.
 */

export const SLASH_COMMANDS = [
    "goto",
    "click",
    "fill",
    "type",
    "press",
    "snapshot",
    "url",
    "back",
    "reload",
    "screenshot",
    "status",
    "discover",
    "knowledge",
    "kb",
    "search",
    "index",
    "memory",
    "tests",
    "test",
    "cover",
    "ci",
    "doctor",
    "trace",
    "context",
    "sync",
    "auth",
    "mode",
    "plan",
    "verbose",
    "sessions",
    "save",
    "resume",
    "clear",
    "help",
    "exit",
] as const;

/**
 * Node readline completer. Returns `[hits, originalLine]`.
 * Only activates when the line starts with `/`.
 */
export function slashCompleter(line: string): [string[], string] {
    if (!line.startsWith("/")) return [[], line];

    const rest = line.slice(1);
    // Complete the command token only (before first space).
    if (rest.includes(" ")) return [[], line];

    const hits = SLASH_COMMANDS.filter((c) => c.startsWith(rest.toLowerCase())).map((c) => `/${c}`);
    return [hits.length ? hits : SLASH_COMMANDS.map((c) => `/${c}`), line];
}
