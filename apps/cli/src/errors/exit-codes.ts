import type { RaikenErrorCategory } from "@raiken/core";
import { isRaikenError, normalizeToRaikenError } from "@raiken/core";

/**
 * Canonical CLI exit codes — one policy for scripts and the REPL.
 *
 * 0   success
 * 1   runtime / test failure
 * 2   usage / validation
 * 3   config / auth
 * 4   busy / conflict
 * 124 timeout (GNU convention)
 * 130 cancelled (128 + SIGINT)
 */
export const CLI_EXIT = {
    SUCCESS: 0,
    RUNTIME_FAILURE: 1,
    USAGE: 2,
    CONFIG_AUTH: 3,
    BUSY_CONFLICT: 4,
    TIMEOUT: 124,
    CANCELLED: 130,
} as const;

export type CliExitCode = (typeof CLI_EXIT)[keyof typeof CLI_EXIT];

const CATEGORY_EXIT: Record<RaikenErrorCategory, CliExitCode> = {
    validation: CLI_EXIT.USAGE,
    config: CLI_EXIT.CONFIG_AUTH,
    auth: CLI_EXIT.CONFIG_AUTH,
    not_found: CLI_EXIT.RUNTIME_FAILURE,
    conflict: CLI_EXIT.BUSY_CONFLICT,
    cancelled: CLI_EXIT.CANCELLED,
    timeout: CLI_EXIT.TIMEOUT,
    external: CLI_EXIT.RUNTIME_FAILURE,
    persistence: CLI_EXIT.RUNTIME_FAILURE,
    internal: CLI_EXIT.RUNTIME_FAILURE,
};

/** Map a domain error (or unknown) to the CLI exit policy. */
export function mapErrorToCliExitCode(error: unknown): CliExitCode {
    const raiken = normalizeToRaikenError(error);
    if (raiken.category === "cancelled") return CLI_EXIT.CANCELLED;
    if (raiken.category === "timeout") return CLI_EXIT.TIMEOUT;
    return CATEGORY_EXIT[raiken.category];
}

/** Map an explicit exit intent (e.g. test pass/fail) through the policy. */
export function cliExitForRuntimeFailure(passed: boolean): CliExitCode {
    return passed ? CLI_EXIT.SUCCESS : CLI_EXIT.RUNTIME_FAILURE;
}

/** True when the error is already a typed Raiken error at the seam. */
export function isTypedCliError(error: unknown): boolean {
    return isRaikenError(error);
}
