import { redactSecrets, serializeSafeClientError } from "@raiken/core";
import chalk from "chalk";
import { cliExit } from "../cli/exit";
import { CLI_EXIT, type CliExitCode, mapErrorToCliExitCode } from "./exit-codes";

export interface RenderCliErrorOptions {
    /** Short label printed before the message (e.g. "Discovery failed"). */
    label?: string;
    /** When true, include retry hint for retryable errors. */
    showRetryHint?: boolean;
}

/** Return only the redacted client-safe message for inline CLI rendering. */
export function safeCliErrorMessage(error: unknown): string {
    if (typeof error === "string") return redactSecrets(error);
    return serializeSafeClientError(error).message;
}

/** Render a safe user-facing CLI error line (never includes stack/secrets). */
export function renderCliError(error: unknown, options: RenderCliErrorOptions = {}): string {
    const safe = serializeSafeClientError(error);
    const label = options.label ? `${options.label}: ` : "";
    let line = `${label}${safe.message}`;
    if (options.showRetryHint && safe.retryable) {
        line += chalk.dim(" (retryable)");
    }
    return line;
}

/** Log a safe error to stderr with optional label. */
export function printCliError(error: unknown, options: RenderCliErrorOptions = {}): void {
    const safe = serializeSafeClientError(error);
    if (options.label) {
        console.error(chalk.red(`${options.label}:`), safe.message);
        return;
    }
    console.error(chalk.red(safe.message));
}

/**
 * Handle an error at a CLI command boundary: print safe message and exit via
 * {@link mapErrorToCliExitCode}. Typed {@link RaikenError} categories drive the
 * exit code (usage=2, config/auth=3, busy=4, timeout=124, cancelled=130).
 *
 * Pass `exitCode` only when the command contract requires a fixed code
 * independent of error category (rare — prefer `cliExit(CLI_EXIT.*)` in the
 * command itself for outcome-based exits like test pass/fail).
 */
export function handleCliError(
    error: unknown,
    options: RenderCliErrorOptions & { exitCode?: CliExitCode } = {},
): never {
    printCliError(error, options);
    return cliExit(options.exitCode ?? mapErrorToCliExitCode(error));
}

/** Exit with usage/validation policy code after printing a message. */
export function exitUsage(message: string): never {
    console.error(chalk.red(message));
    return cliExit(CLI_EXIT.USAGE);
}

/** Exit with config/auth policy code after printing a message. */
export function exitConfigAuth(message: string): never {
    console.error(chalk.red(message));
    return cliExit(CLI_EXIT.CONFIG_AUTH);
}

/** Exit with busy/conflict policy code after printing a message. */
export function exitBusyConflict(message: string): never {
    console.error(chalk.red(message));
    return cliExit(CLI_EXIT.BUSY_CONFLICT);
}

export { CLI_EXIT, mapErrorToCliExitCode, type CliExitCode };
