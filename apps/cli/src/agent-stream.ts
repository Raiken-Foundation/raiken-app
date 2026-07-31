import { splitAgentStreamChunk } from "@raiken/shared";
import chalk from "chalk";

export const accent = chalk.hex("#a78bfa");
export const dim = chalk.gray;

export interface SplitHITLOptions {
    /** Called for progress events instead of (or in addition to) printing. */
    onProgress?: (label: string, detail?: string | null) => void;
    /** When true, skip the default stderr progress print (caller handles it). */
    suppressProgressPrint?: boolean;
}

/**
 * Pull `<!--HITL:{...}-->` and `<!--EVENT:...-->` markers out of a streamed
 * chunk, returning clean text plus any HITL payload. Progress events are
 * printed as dim lines to `stderr` (so they never pollute `stdout`, keeping
 * piped/`--json` output clean) unless `onProgress` + `suppressProgressPrint`
 * are set. Tool events are skipped (rendered separately).
 */
export function splitHITL(
    chunk: string,
    options: SplitHITLOptions = {},
): { text: string; hitl: Record<string, unknown> | null } {
    const { text, hitl, progress } = splitAgentStreamChunk(chunk);
    for (const evt of progress) {
        options.onProgress?.(evt.label, evt.detail);
        if (!options.suppressProgressPrint) {
            process.stderr.write(dim(`   … ${evt.label}${evt.detail ? ` ${evt.detail}` : ""}\n`));
        }
    }
    return { text, hitl };
}

/**
 * Render a live tool-call line so the user sees the agent working the DOM.
 * Written to `stderr` so it's visible interactively but never mixed into
 * `stdout` (which carries the agent's actual answer for piping). Styled to
 * match the interactive REPL's `⏺` tool-call bullets.
 */
export function renderToolCall(toolName: string, args: unknown): void {
    const a = (args ?? {}) as Record<string, unknown>;
    const detail =
        (typeof a.url === "string" && a.url) ||
        (typeof a.selector === "string" && a.selector) ||
        (Array.isArray(a.selector) && a.selector.join(" | ")) ||
        (typeof a.query === "string" && a.query) ||
        (typeof a.path === "string" && a.path) ||
        (typeof a.filePath === "string" && a.filePath) ||
        "";
    const value =
        typeof a.value === "string"
            ? dim(
                  ` = "${
                      toolName === "fillInput" || toolName === "typeText" ? "[REDACTED]" : a.value
                  }"`,
              )
            : "";
    const bullet = chalk.hex("#a78bfa")("⏺");
    process.stderr.write(
        `  ${bullet} ${chalk.bold.white(toolName)}${detail ? `  ${dim(detail)}` : ""}${value}\n`,
    );
}

/**
 * Temporarily route the core engine's `console.log/info/debug` diagnostics to
 * `stderr` for the duration of a run, so `stdout` carries only the agent's
 * response (or JSON). Returns a restore function. `warn`/`error` already go to
 * `stderr` by default and are left untouched.
 */
export function routeDiagnosticsToStderr(): () => void {
    const original = {
        log: console.log,
        info: console.info,
        debug: console.debug,
    };
    const toStderr = (...args: unknown[]): void => {
        process.stderr.write(
            `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`,
        );
    };
    console.log = toStderr;
    console.info = toStderr;
    console.debug = toStderr;
    return () => {
        console.log = original.log;
        console.info = original.info;
        console.debug = original.debug;
    };
}
