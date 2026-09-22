/**
 * Shared exit helpers so one-shot CLI commands and the REPL can share handlers
 * without `process.exit` tearing down an interactive session.
 *
 * One-shot: `cliExit` calls `process.exit` by default.
 * REPL: `withThrowExit` — throw `CliExitError` so the REPL loop continues.
 */

export class CliExitError extends Error {
    constructor(public readonly code: number) {
        super(`CLI exit ${code}`);
        this.name = "CliExitError";
    }
}

type ExitFn = (code?: number) => never;

let activeExit: ExitFn = (code = 0): never => {
    process.exit(code);
};

/** Exit the current CLI context (process, or throw inside the REPL). */
export function cliExit(code = 0): never {
    return activeExit(code);
}

/**
 * Run `fn` with `cliExit` throwing `CliExitError` instead of killing the process.
 * Used by the interactive REPL when reusing one-shot command handlers.
 */
export async function withThrowExit(fn: () => Promise<void>): Promise<number> {
    const prev = activeExit;
    let code = 0;
    activeExit = (c = 0): never => {
        throw new CliExitError(typeof c === "number" ? c : 0);
    };
    try {
        await fn();
    } catch (err) {
        if (err instanceof CliExitError) {
            code = err.code;
        } else {
            throw err;
        }
    } finally {
        activeExit = prev;
    }
    return code;
}
