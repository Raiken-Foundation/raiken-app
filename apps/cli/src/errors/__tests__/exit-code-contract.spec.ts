import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "../../../../../");

const COMMANDS_DIR = "apps/cli/src/commands";

/**
 * Every shipped command, discovered from disk rather than listed by hand — a
 * new command must opt into the policy, not silently escape the scan.
 */
function productionCommandFiles(): string[] {
    const entries = fs
        .readdirSync(path.join(WORKSPACE_ROOT, COMMANDS_DIR))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => `${COMMANDS_DIR}/${name}`);
    return ["apps/cli/src/bin.ts", "apps/cli/src/server.ts", ...entries];
}

const PRODUCTION_COMMAND_FILES = productionCommandFiles();

/**
 * Both spellings of a hardcoded status. `process.exitCode = 1` bypasses
 * `CLI_EXIT` just as surely as `process.exit(1)`, and is how `raiken index`
 * previously reported a failure with a code nothing else agreed on.
 */
const LITERAL_EXIT_PATTERN = /\bprocess\.exit\s*\(\s*[0-9]+\s*\)|\bprocess\.exitCode\s*=\s*[0-9]+/;
const UNSAFE_ERROR_PATTERN =
    /(?:err|error) instanceof Error\s*\?\s*(?:err|error)\.message|String\(\s*err\s*\)|detail:\s*String\(/;
const ERROR_BOUNDARY_FILES = [
    ...PRODUCTION_COMMAND_FILES,
    "apps/cli/src/repl/chat/agent-turn.ts",
    "apps/cli/src/repl/chat/hitl.ts",
    "apps/cli/src/repl/chat/run-chat-repl.ts",
    "apps/cli/src/repl/chat/slash/handlers/discovery.ts",
];
/** Bin wrappers must not pin exit codes — typed errors map via mapErrorToCliExitCode. */
const HANDLE_CLI_EXIT_OVERRIDE = /handleCliError\([\s\S]*?exitCode\s*:/;

/**
 * Explicit pre-validation exits in bin.ts (not handleCliError) — fixed USAGE(2)
 * because the failure is argv/shape validation before any command runs:
 * invalid port, invalid one-shot --timeout, and the exitOverride catch that
 * maps commander argv errors (unknown option, missing arg, unknown subcommand)
 * to USAGE instead of commander's default 1. Unknown top-level commands go
 * through exitUsage() (which prints a did-you-mean), not a literal cliExit.
 */
const BIN_FIXED_USAGE_EXIT_COUNT = 3;

describe("CLI exit-code contract scan", () => {
    it("production commands do not use numeric exit literals", () => {
        const violations: string[] = [];
        for (const rel of PRODUCTION_COMMAND_FILES) {
            const abs = path.join(WORKSPACE_ROOT, rel);
            const source = fs.readFileSync(abs, "utf-8");
            for (const [idx, line] of source.split("\n").entries()) {
                if (LITERAL_EXIT_PATTERN.test(line)) {
                    violations.push(`${rel}:${idx + 1}: ${line.trim()}`);
                }
            }
        }
        expect(violations).toEqual([]);
    });

    it("bin handleCliError wrappers do not override exitCode", () => {
        const abs = path.join(WORKSPACE_ROOT, "apps/cli/src/bin.ts");
        const source = fs.readFileSync(abs, "utf-8");
        expect(source).not.toMatch(HANDLE_CLI_EXIT_OVERRIDE);
    });

    it("bin pre-validation exits use CLI_EXIT.USAGE only", () => {
        const abs = path.join(WORKSPACE_ROOT, "apps/cli/src/bin.ts");
        const source = fs.readFileSync(abs, "utf-8");
        const usageCalls = source.match(/cliExit\(CLI_EXIT\.USAGE\)/g) ?? [];
        expect(usageCalls.length).toBe(BIN_FIXED_USAGE_EXIT_COUNT);
    });

    it("CLI command and REPL boundaries do not emit raw error strings", () => {
        const violations: string[] = [];
        for (const rel of ERROR_BOUNDARY_FILES) {
            const abs = path.join(WORKSPACE_ROOT, rel);
            const source = fs.readFileSync(abs, "utf-8");
            for (const [idx, line] of source.split("\n").entries()) {
                if (UNSAFE_ERROR_PATTERN.test(line)) {
                    violations.push(`${rel}:${idx + 1}: ${line.trim()}`);
                }
            }
        }
        expect(violations).toEqual([]);
    });
});

describe("CLI exit-code policy constants", () => {
    it("documents GNU-compatible timeout/cancel codes", async () => {
        const { CLI_EXIT } = await import("../exit-codes");
        expect(CLI_EXIT.TIMEOUT).toBe(124);
        expect(CLI_EXIT.CANCELLED).toBe(130);
    });

    it("documents the full policy table", async () => {
        const { CLI_EXIT } = await import("../exit-codes");
        expect(CLI_EXIT.SUCCESS).toBe(0);
        expect(CLI_EXIT.RUNTIME_FAILURE).toBe(1);
        expect(CLI_EXIT.USAGE).toBe(2);
        expect(CLI_EXIT.CONFIG_AUTH).toBe(3);
        expect(CLI_EXIT.BUSY_CONFLICT).toBe(4);
    });
});
