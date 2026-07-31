import { exitUsage } from "../errors";

export interface DestructiveConfirmOptions {
    /** Skip the prompt entirely (scripts / CI). */
    force?: boolean;
    /**
     * Injected prompt for surfaces where inquirer can't run (the REPL owns
     * readline raw mode — spawning inquirer there double-echoes keys and
     * desyncs the terminal). Standalone CLI leaves this unset and gets the
     * inquirer prompt.
     */
    confirm?: (message: string) => Promise<boolean>;
}

/**
 * Gate a destructive one-shot action behind an explicit confirmation:
 *   - `--force` runs immediately (the scriptable path);
 *   - an interactive TTY gets a y/N prompt;
 *   - anything else (piped stdin, no --force) is a usage error — a
 *     destructive command must never silently run where nobody can answer.
 */
export async function confirmDestructive(
    action: string,
    options: DestructiveConfirmOptions = {},
): Promise<boolean> {
    if (options.force) return true;
    if (options.confirm) return options.confirm(action);
    if (!process.stdin.isTTY) {
        exitUsage(
            `${action} is destructive and stdin is not interactive. Re-run with --force to confirm.`,
        );
    }
    const { confirm } = await import("@inquirer/prompts");
    return confirm({ message: `${action}?`, default: false });
}
