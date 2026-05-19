#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import dotenv from "dotenv";
import { getProvider, resolveAIConfig } from "@raiken/core";
import { startServer } from "./server";

// Load .env from the current working directory (where the user runs raiken)
const projectRoot = process.cwd();
const envPath = path.join(projectRoot, ".env");

// Load .env file
const result = dotenv.config({ path: envPath });

if (result.error) {
    // Only warn if the file doesn't exist - other errors are more serious
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
        console.log(chalk.dim("ℹ️  No .env file found in"), chalk.dim(projectRoot));
    } else {
        console.warn(chalk.yellow("⚠️  Failed to load .env:"), result.error.message);
    }
}

/**
 * 8-bit `[ R ]` brand mark, scaled down to a 5-line / 13-col ASCII glyph
 * so it fits comfortably above a terminal prompt without dominating the
 * screen. The leading `█` blocks render in chalk magenta to mirror the
 * dashboard's purple accent (#a78bfa); the brackets stay default fg so
 * the mark reads as `[ R ]` even on light-themed terminals.
 *
 * Drawn once on `raiken start` so testers immediately recognise the brand
 * matches the dashboard favicon they're about to open.
 */
function printBanner(version: string): void {
    const p = chalk.hex("#a78bfa");
    const dim = chalk.gray;
    const lines = [
        `${dim("[")}  ${p("█████")}  ${dim("]")}`,
        `${dim("[")}  ${p("█")}   ${p("█")}  ${dim("]")}`,
        `${dim("[")}  ${p("█████")}  ${dim("]")}`,
        `${dim("[")}  ${p("█")}  ${p("█")}   ${dim("]")}`,
        `${dim("[")}  ${p("█")}   ${p("█")}  ${dim("]")}`,
    ];
    console.log("");
    for (const line of lines) console.log("  " + line);
    console.log("");
    console.log(
        `  ${chalk.bold("raiken")} ${dim(`v${version}`)}  ${dim("·")}  ${dim("AI QA agent for developers")}`,
    );
    console.log("");
}

function checkApiKey() {
    const resolved = resolveAIConfig(process.cwd());
    const provider = getProvider(resolved.provider);

    if (resolved.apiKey) {
        const where =
            resolved.apiKeySource === "env"
                ? `env (${resolved.apiKeyEnvVar})`
                : "raiken.config.json";
        console.log(
            `🔐 ${provider.label} key configured (${resolved.apiKey.length} chars, from ${where})`,
        );
        console.log(chalk.dim(`   model: ${resolved.model}`));
    } else {
        const envHint = provider.envVars[0] ?? "AI_API_KEY";
        console.warn(
            chalk.yellow(`⚠️  No ${provider.label} API key found. AI features will not work.`),
        );
        console.log(
            chalk.dim(`   Set ${envHint} in .env, or configure in Settings → AI Provider.`),
        );
        if (provider.apiKeyUrl) {
            console.log(chalk.dim(`   Get a key at: ${provider.apiKeyUrl}`));
        }
    }
}

const resolveVersion = (): string => {
    try {
        const pkgPath = path.join(__dirname, "package.json");
        const raw = fs.readFileSync(pkgPath, "utf-8");
        const pkg = JSON.parse(raw) as { version?: string };
        return pkg.version || "0.0.0";
    } catch {
        return "0.0.0";
    }
};

const program = new Command();
program
    .name("raiken")
    .description("AI QA Agent for Developers")
    .version(resolveVersion(), "-v, --version");

program
    .command("start")
    .description("Start the Raiken Dashboard & Agent")
    .option("-p, --port <number>", "Port to run on", "7101")
    .action(async (options) => {
        const port = parseInt(options.port, 10);
        if (isNaN(port) || port < 1 || port > 65535) {
            console.error(
                chalk.red(`Invalid port: "${options.port}". Must be a number between 1 and 65535.`),
            );
            process.exit(1);
        }
        printBanner(resolveVersion());
        checkApiKey();
        console.log(chalk.cyan("Initializing Raiken..."));
        try {
            await startServer(port);
        } catch (error) {
            console.error(
                chalk.red("Failed to start Raiken:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(1);
        }
    });

program
    .command("init")
    .description("Initialize Raiken in the current project")
    .option("-f, --force", "Overwrite existing configuration files", false)
    .option("-y, --yes", "Accept auto-detected defaults for every prompt (non-interactive)", false)
    .action(async (options) => {
        try {
            const { initializeProject } = await import("./initializer");
            await initializeProject(process.cwd(), {
                force: options.force,
                nonInteractive: options.yes,
            });
        } catch (error) {
            console.error(chalk.red("\n ❌ Failed to initialize project:"), error);
            process.exit(1);
        }
    });

program
    .command("discover [url]")
    .description("Autonomously discover web application structure")
    .option("--max-pages <number>", "Maximum pages to discover", "100")
    .option("--max-depth <number>", "Maximum navigation depth", "5")
    .option("--timeout <number>", "Timeout per page in milliseconds", "30000")
    .option("--auth", "Prompt for authentication before discovery")
    .option("--skip-auth", "Skip authentication-required routes")
    .option("--continue", "Resume a paused discovery session")
    .option("--status", "Show discovery statistics")
    .action(async (url, options) => {
        checkApiKey();
        try {
            const { discoverCommand } = await import("./commands/discover");
            await discoverCommand(url, options);
        } catch (error) {
            console.error(chalk.red("\n ❌ Discovery failed:"), error);
            process.exit(1);
        }
    });

program
    .command("auth")
    .description("Authenticate to save browser session state")
    .option("--url <url>", "URL to navigate to for authentication")
    .option(
        "--cookie <pairs>",
        'Skip the browser and import cookies directly (e.g. "sid=abc; csrf=xyz"). Requires --domain.',
    )
    .option(
        "--domain <host>",
        "Domain to scope imported cookies / localStorage entries to (e.g. app.example.com)",
    )
    .option(
        "--storage <key=value>",
        "Add a localStorage entry on the imported origin (repeatable). Requires --domain.",
        (value: string, prev: string[] = []) => [...prev, value],
        [] as string[],
    )
    .option(
        "--from-state-file <path>",
        "Copy an existing Playwright storage-state JSON into .raiken/auth-state.json",
    )
    .action(async (options) => {
        try {
            const { authCommand } = await import("./commands/auth");
            await authCommand(options);
        } catch (error) {
            console.error(chalk.red("\n ❌ Authentication failed:"), error);
            process.exit(1);
        }
    });

program
    .command("ci")
    .description("Run impact analysis + affected tests and emit JUnit/JSON reports")
    .option("--base <ref>", "Base git ref for the diff (default: origin/main or HEAD~1)")
    .option("--head <ref>", "Head git ref for the diff", "HEAD")
    .option("--staged", "Diff the staged index against HEAD (for pre-commit hooks)", false)
    .option("--output-dir <path>", "Directory for emitted reports", ".raiken/ci")
    .option("--format <format>", "Report format: junit | json | both", "both")
    .option("--confidence <number>", "Min confidence (0..1) for an affected test", "0.5")
    .option("--max-tests <number>", "Cap the number of tests executed")
    .option("--timeout <number>", "Per-test timeout in ms", "60000")
    .option("--skip-run", "Compute impact only; do not execute tests", false)
    .option("--json", "Emit a machine-readable summary to stdout", false)
    .action(async (options) => {
        try {
            const { ciCommand } = await import("./commands/ci");
            await ciCommand(options);
        } catch (error) {
            console.error(
                chalk.red("\n ❌ raiken ci failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
        }
    });

program
    .command("doctor")
    .description("Lint the test suite for flake-prone anti-patterns (waitForTimeout, .only, …)")
    .option("--dir <path>", "Test directory to scan (default: from raiken.config.json or 'e2e')")
    .option(
        "--fail-on <severity>",
        "Exit non-zero on this severity or higher (error|warning|info)",
        "error",
    )
    .option("--json", "Emit findings as JSON", false)
    .action(async (options) => {
        try {
            const { doctorCommand } = await import("./commands/doctor");
            await doctorCommand(options);
        } catch (error) {
            console.error(
                chalk.red("\n ❌ raiken doctor failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
        }
    });

program
    .command("context")
    .description("Write raiken.ctx.md — a portable project snapshot for IDE AI agents")
    .option("--output <path>", "Output file path", "raiken.ctx.md")
    .option("--max-rows <number>", "Cap rows per section", "25")
    .option("--no-impact", "Skip the pending-changes / affected-tests section")
    .option("--json", "Emit the result metadata as JSON", false)
    .action(async (options) => {
        try {
            const { contextCommand } = await import("./commands/context");
            await contextCommand(options);
        } catch (error) {
            console.error(
                chalk.red("\n ❌ raiken context failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
        }
    });

program
    .command("cover <target>")
    .description(
        "Draft a Playwright test from an AC reference (AC-2), a symbol, or a free-text scenario",
    )
    .option("-t, --ticket <id>", "Ticket/issue ID (auto-detected from branch when omitted)")
    .option("-o, --output <path>", "Explicit output file path")
    .option("--dir <path>", "Test directory (overrides raiken.config.json)")
    .option("--dry-run", "Skip the LLM call and write a TODO scaffold", false)
    .option("--json", "Emit the result as JSON", false)
    .action(async (target, options) => {
        try {
            const { coverCommand } = await import("./commands/cover");
            await coverCommand(target, options);
        } catch (error) {
            console.error(
                chalk.red("\n ❌ raiken cover failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
        }
    });

program
    .command("trace [stackTrace]")
    .description("Given a stack trace, list the existing tests most likely to reproduce it")
    .option("-f, --file <path>", "Read trace from a file")
    .option("--min-confidence <number>", "Minimum confidence (0..1)", "0")
    .option("--limit <number>", "Maximum matches to return", "20")
    .option("--json", "Emit the result as JSON", false)
    .action(async (stackTrace, options) => {
        try {
            const { traceCommand } = await import("./commands/trace");
            await traceCommand(stackTrace, options);
        } catch (error) {
            console.error(
                chalk.red("\n ❌ raiken trace failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
        }
    });

const hooks = program
    .command("hooks")
    .description("Install / uninstall git hooks that run raiken locally");

hooks
    .command("install")
    .description("Install a git hook that runs raiken on commit/push")
    .option("--type <type>", "Hook type: pre-commit | pre-push", "pre-commit")
    .option("--skip-run", "Don't actually run tests in the hook (impact only)")
    .option("--husky", "Force install under .husky/ even if no husky setup exists")
    .action(async (options) => {
        try {
            const { hooksInstallCommand } = await import("./commands/hooks");
            await hooksInstallCommand(options);
        } catch (error) {
            console.error(
                chalk.red("\n ❌ raiken hooks install failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
        }
    });

hooks
    .command("uninstall")
    .description("Remove the raiken-managed block from a git hook")
    .option("--type <type>", "Hook type: pre-commit | pre-push", "pre-commit")
    .action(async (options) => {
        try {
            const { hooksUninstallCommand } = await import("./commands/hooks");
            await hooksUninstallCommand(options);
        } catch (error) {
            console.error(
                chalk.red("\n ❌ raiken hooks uninstall failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
        }
    });

hooks
    .command("status")
    .description("Show which git hooks are installed and which are raiken-managed")
    .action(async () => {
        try {
            const { hooksStatusCommand } = await import("./commands/hooks");
            await hooksStatusCommand();
        } catch (error) {
            console.error(
                chalk.red("\n ❌ raiken hooks status failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
        }
    });

program
    .command("sync")
    .description("Sync with ticket system and analyze test impact")
    .option(
        "-t, --ticket <id>",
        "Ticket/issue ID to analyze (auto-detected from branch if omitted)",
    )
    .action(async (options) => {
        checkApiKey();
        try {
            const { syncCommand } = await import("./commands/sync");
            await syncCommand(options);
        } catch (error) {
            console.error(
                chalk.red("\n ❌ Sync failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(1);
        }
    });

program.parse(process.argv);
