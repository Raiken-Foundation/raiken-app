#!/usr/bin/env node
// Must stay the first import: installs the console filter before any module
// whose init code nags (baseline-browser-mapping fires at import time).
import "./upstream-warnings";
import path from "node:path";
import { getRaikenVersion } from "@raiken/shared";
import chalk from "chalk";
import { Command, CommanderError } from "commander";
import dotenv from "dotenv";
import { CLI_EXIT, exitUsage, handleCliError } from "./errors";
import { cliExit } from "./repl/exit";

// Load .env from the current working directory (where the user runs raiken).
// Cheap (a local file read) so it stays eager, unlike the heavy imports below.
const projectRoot = process.cwd();
const envPath = path.join(projectRoot, ".env");
const result = dotenv.config({ path: envPath });

if (result.error) {
    // A missing .env is the common case (most projects don't have one) and
    // isn't actionable on its own — `checkApiKey()` already warns explicitly
    // when a command that needs AI actually runs without a key. Only surface
    // a genuinely unexpected failure (malformed file, permissions, …) here,
    // and keep it on stderr so `-p --json` one-shot mode leaves stdout clean.
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    if (errorCode !== "ENOENT") {
        console.error(chalk.yellow("⚠ Failed to load .env:"), result.error.message);
    }
}

/**
 * Claude Code-style welcome box: a single rounded card with the brand mark,
 * a one-line pitch, and the handful of things a new user actually needs
 * (help, resume, cwd) instead of a wall of shortcuts.
 */
async function printBanner(version: string): Promise<void> {
    const { renderBox, boxWidth } = await import("./repl/box");
    const p = chalk.hex("#a78bfa");
    const dim = chalk.gray;
    const width = boxWidth();

    const lines = [
        `${p("✻")} ${chalk.bold("Welcome to Raiken")} ${dim(`v${version}`)}`,
        dim("AI QA agent for developers"),
        "",
        `${dim("/help")} for commands  ${dim("·")}  ${dim("raiken resume")} to pick up a saved thread`,
        dim(`cwd: ${shortenPath(process.cwd(), width - 9)}`),
    ];

    console.log("");
    console.log(renderBox(lines, width));
    console.log("");
}

function shortenPath(p: string, max: number): string {
    if (p.length <= max) return p;
    return `…${p.slice(p.length - max + 1)}`;
}

/**
 * Dynamically imports `@raiken/core` — a multi-hundred-KB barrel pulling in
 * Playwright, better-sqlite3, Transformers.js, and LangGraph — so commands
 * that never touch AI/browser/DB (`--help`, `--version`, an unrecognized
 * command, `init`, `hooks`, …) don't pay that load cost just to start up.
 */
async function checkApiKey(): Promise<void> {
    const { getProvider, resolveAIConfig } = await import("@raiken/core");
    const resolved = resolveAIConfig(process.cwd());
    const provider = getProvider(resolved.provider);

    // Success is the common case and isn't worth a line every startup —
    // `raiken status` / `/status` already show provider, model, and key
    // state on demand. Only the actionable failure case prints here.
    if (provider.envVars.length === 0 || resolved.apiKey) return;

    const envHint = provider.envVars[0] ?? "AI_API_KEY";
    console.warn(chalk.yellow(`⚠ No ${provider.label} API key found. AI features will not work.`));
    console.warn(
        chalk.dim(
            `   Set ${envHint} in .env, run \`raiken config\`, or configure in Settings → AI Provider.`,
        ),
    );
    if (provider.apiKeyUrl) {
        console.warn(chalk.dim(`   Get a key at: ${provider.apiKeyUrl}`));
    }
}

const program = new Command();
program
    .name("raiken")
    .description("AI QA Agent for Developers")
    .version(getRaikenVersion(), "-v, --version");

// Throw instead of process.exit on argv-shape errors (unknown option, missing
// required arg, unknown subcommand, excess args) so the catch at the parse
// site can map them to the CLI's USAGE(2) contract instead of commander's 1.
// --help/--version carry exitCode 0 and pass through untouched.
program.exitOverride();

// Non-interactive one-shot mode (à la `claude -p`) is handled BEFORE commander
// parses, so its flags (--json, --run, …) don't have to be declared globally —
// declaring them globally collides with the identically-named options on
// subcommands like `status`/`ci`/`discover`. See runOneShotFromArgv() below.
program.addHelpText(
    "after",
    "\nOne-shot (non-interactive):\n" +
        '  $ raiken -p "test the login flow"          run one request and stream the answer\n' +
        '  $ raiken -p "cover checkout" --json         emit a machine-readable JSON result\n' +
        '  $ raiken -p "..." --stream-json             emit NDJSON events (start/tool/text/done)\n' +
        '  $ raiken -p "..." --run                     run the generated test (exit code = pass/fail)\n' +
        "     flags: --json  --stream-json  --run  --no-save  --headed  --timeout <ms>\n" +
        "\nSessions:\n" +
        "  $ raiken sessions                           list saved sessions\n" +
        "  $ raiken resume                             reopen the latest saved session\n" +
        '  $ raiken resume "login-flow"                reopen a named session\n',
);

program
    .command("start")
    .description("Start the Raiken Dashboard & Agent")
    .option("-p, --port <number>", "Port to run on", "7101")
    .option(
        "--remote",
        "Expose the dashboard on the local network (requires a session token)",
        false,
    )
    .action(async (options) => {
        const port = parseInt(options.port, 10);
        if (Number.isNaN(port) || port < 1 || port > 65535) {
            console.error(
                chalk.red(`Invalid port: "${options.port}". Must be a number between 1 and 65535.`),
            );
            cliExit(CLI_EXIT.USAGE);
        }
        await printBanner(getRaikenVersion());
        await checkApiKey();
        console.log(chalk.cyan("Initializing Raiken..."));
        try {
            const { startServer } = await import("./server");
            await startServer({ port, remote: options.remote });
        } catch (error) {
            handleCliError(error, {
                label: "Failed to start Raiken",
            });
        }
    });

// Default action: bare `raiken` launches the interactive testing agent (live
// browser). One-shot (`raiken -p`) is intercepted before commander parses.
program.action(async () => {
    await printBanner(getRaikenVersion());
    await checkApiKey();
    try {
        const { chatCommand } = await import("./commands/chat");
        await chatCommand();
    } catch (error) {
        handleCliError(error, {
            label: "Failed to start Raiken",
        });
    }
});

program
    .command("resume [name]")
    .description("Resume a saved interactive session (latest if name omitted)")
    .action(async (name: string | undefined) => {
        await printBanner(getRaikenVersion());
        await checkApiKey();
        try {
            const { chatCommand } = await import("./commands/chat");
            await chatCommand({ resume: name?.trim() ? name.trim() : true });
        } catch (error) {
            handleCliError(error, {
                label: "Failed to resume session",
            });
        }
    });

program
    .command("sessions")
    .description("List saved interactive sessions (resumable with `raiken resume <name>`)")
    .option("--json", "Emit the session list as JSON", false)
    .action(async (options) => {
        try {
            const { sessionsCommand } = await import("./commands/sessions");
            await sessionsCommand(options);
        } catch (error) {
            handleCliError(error, {
                label: "raiken sessions failed",
            });
        }
    });

program
    .command("init")
    .description("Initialize Raiken in the current project")
    .option("-f, --force", "Overwrite existing configuration files", false)
    .option("-y, --yes", "Accept auto-detected defaults for every prompt (non-interactive)", false)
    .option(
        "--skip-browsers",
        "Skip downloading Playwright browser binaries (CI containers usually pre-install them)",
        false,
    )
    .action(async (options) => {
        try {
            const { initializeProject } = await import("./initializer");
            await initializeProject(process.cwd(), {
                force: options.force,
                nonInteractive: options.yes,
                skipBrowsers: options.skipBrowsers,
            });
        } catch (error) {
            handleCliError(error, {
                label: "Failed to initialize project",
            });
        }
    });

program
    .command("config [provider-or-key]")
    .description(
        "Configure the AI provider, key, model, and endpoint (same settings as the dashboard)",
    )
    .option(
        "--provider <id>",
        "AI provider id (openrouter, openai, anthropic, google, groq, mistral, deepseek, xai, together, perplexity, ollama, custom)",
    )
    .option("--api-key <key>", "API key to store in raiken.config.json")
    .option("--model <id>", "Model identifier")
    .option("--base-url <url>", "Base URL override (for custom / self-hosted endpoints)")
    .option(
        "--unset-key",
        "Remove the saved API key (falls back to an environment variable, if any)",
        false,
    )
    .option("--list", "Show the provider catalog and current AI configuration", false)
    .option("--json", "Emit machine-readable JSON", false)
    .action(async (section, options) => {
        try {
            const { configCommand } = await import("./commands/config");
            await configCommand(section, options);
        } catch (error) {
            handleCliError(error, {
                label: "raiken config failed",
            });
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
        await checkApiKey();
        try {
            const { discoverCommand } = await import("./commands/discover");
            await discoverCommand(url, options);
        } catch (error) {
            handleCliError(error, {
                label: "Discovery failed",
            });
        }
    });

program
    .command("auth")
    .description("Authenticate to save browser session state")
    .option("--url <url>", "URL to navigate to for authentication")
    .option("--script <path>", "Run this project-local custom login script")
    .option("--manual", "Ignore the configured login script and use an interactive browser", false)
    .option("--headed", "Show the browser while running a custom login script", false)
    .option("--timeout <ms>", "Custom login script timeout in milliseconds")
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
        "Copy an existing Playwright storage-state JSON into the configured auth state path",
    )
    .action(async (options) => {
        try {
            const { authCommand } = await import("./commands/auth");
            await authCommand(options);
        } catch (error) {
            handleCliError(error, {
                label: "Authentication failed",
            });
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
            handleCliError(error, {
                label: "raiken ci failed",
            });
        }
    });

program
    .command("doctor")
    .description(
        "Check the test environment (Playwright, browsers, webServer script, baseURL) " +
            "and lint the suite for flake-prone anti-patterns",
    )
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
            handleCliError(error, {
                label: "raiken doctor failed",
            });
        }
    });

program
    .command("organize")
    .description(
        "Propose (and, on confirmation, apply) an AI-assisted reorganization of the test " +
            "directory into feature/suite folders, plus a raiken.config.json cleanup",
    )
    .option("-y, --yes", "Apply without prompting for confirmation", false)
    .option("--tests-only", "Only propose test-file reorganization, skip config cleanup", false)
    .option("--config-only", "Only propose raiken.config.json cleanup, skip test files", false)
    .option("--json", "Emit the plan (and, if applied, the result) as JSON", false)
    .action(async (options) => {
        try {
            const { organizeCommand } = await import("./commands/organize");
            await organizeCommand(options);
        } catch (error) {
            handleCliError(error, {
                label: "raiken organize failed",
            });
        }
    });

program
    .command("eval")
    .description(
        "Run agent eval scenarios: 'playground' (fixture ground-truth suite, from the raiken " +
            "repo), 'benchmark' (accuracy regression gates against the playground-auth " +
            "fixture) or 'flakiness <testFile>' (run a spec N times, score stability)",
    )
    .argument("<suite>", "Eval suite: playground | benchmark | flakiness")
    .argument("[target]", "Suite argument (flakiness: the spec file to exercise)")
    .option("--repeat <n>", "Attempts per scenario", "1")
    .option("--filter <substring>", "Only run scenarios whose id contains this")
    .option("--runs <n>", "flakiness: consecutive runs to compare", "3")
    .option("--expect-tests <n>", "flakiness: fail unless each run reports exactly this many tests")
    .option("--dir <path>", "playground/benchmark: directory containing the fixture apps")
    .option("--out <path>", "Also write the JSON report to this file")
    .option("--json", "Emit the report as JSON on stdout", false)
    .option("--keep-work-dirs", "Keep per-attempt temp directories for debugging", false)
    .action(async (suite, target, options) => {
        try {
            const { evalCommand } = await import("./commands/eval");
            await evalCommand(suite, target, options);
        } catch (error) {
            handleCliError(error, {
                label: "raiken eval failed",
            });
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
            handleCliError(error, {
                label: "raiken context failed",
            });
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
            handleCliError(error, {
                label: "raiken cover failed",
            });
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
            handleCliError(error, {
                label: "raiken trace failed",
            });
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
            handleCliError(error, {
                label: "raiken hooks install failed",
            });
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
            handleCliError(error, {
                label: "raiken hooks uninstall failed",
            });
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
            handleCliError(error, {
                label: "raiken hooks status failed",
            });
        }
    });

program
    .command("status")
    .description(
        "Show project setup at a glance: AI, code graph, search index, tests, site knowledge, memory",
    )
    .option("--json", "Emit the status as JSON", false)
    .action(async (options) => {
        try {
            const { statusCommand } = await import("./commands/status");
            await statusCommand(options);
        } catch (error) {
            handleCliError(error, {
                label: "raiken status failed",
            });
        }
    });

program
    .command("index")
    .description("Build the code graph (and, with --embeddings, the semantic search index)")
    .option("--embeddings", "Also generate the vector index that powers `raiken search`", false)
    .option("--force", "Regenerate embeddings even if they already exist", false)
    .action(async (options) => {
        try {
            const { indexCommand } = await import("./commands/indexer");
            await indexCommand(options);
        } catch (error) {
            handleCliError(error, {
                label: "raiken index failed",
            });
        }
    });

program
    .command("search <query>")
    .description("Semantic (embeddings) code search — find code by meaning")
    .option("--limit <number>", "Maximum results", "10")
    .option("--type <type>", "Restrict to a chunk type: function | class | file | type")
    .option("--json", "Emit results as JSON", false)
    .action(async (query, options) => {
        try {
            const { searchCommand } = await import("./commands/search");
            await searchCommand(query, options);
        } catch (error) {
            handleCliError(error, {
                label: "raiken search failed",
            });
        }
    });

program
    .command("knowledge [section] [arg]")
    .alias("kb")
    .description(
        "Inspect discovered site knowledge: [overview] | pages | links | blockers | page <url> | clear",
    )
    .option("--limit <number>", "Max rows for list sections", "50")
    .option("--json", "Emit the section as JSON", false)
    .option("-f, --force", "Skip the confirmation prompt for `clear` (scripts / CI)", false)
    .action(async (section, arg, options) => {
        try {
            const { knowledgeCommand } = await import("./commands/knowledge");
            await knowledgeCommand(section, arg, options);
        } catch (error) {
            handleCliError(error, {
                label: "raiken knowledge failed",
            });
        }
    });

program
    .command("memory [action]")
    .description("Inspect what the agent has learned about this project ([show] | clear)")
    .option("--json", "Emit memory as JSON", false)
    .option("-f, --force", "Skip the confirmation prompt for `clear` (scripts / CI)", false)
    .action(async (action, options) => {
        try {
            const { memoryCommand } = await import("./commands/memory");
            await memoryCommand(action, options);
        } catch (error) {
            handleCliError(error, {
                label: "raiken memory failed",
            });
        }
    });

program
    .command("test [file]")
    .description("Run the Playwright suite (or a single spec) and report pass/fail")
    .option("--json", "Emit the run summary as JSON", false)
    .option("--headed", "Run with visible browser windows", false)
    .option("--debug", "Step through the test in the Playwright inspector", false)
    .option("--grep <pattern>", "Only run tests whose title matches (Playwright -g)")
    .option("--workers <n>", "Parallel workers (default: 1)")
    .option("--project <name>", "Only run one Playwright project (browser) from the config")
    .option("--retries <n>", "Retry failing tests N times")
    .option("--update-snapshots", "Update snapshots instead of comparing them", false)
    .option("--list", "List tests without running them", false)
    .option("--watch", "Re-run on every project change until Ctrl+C", false)
    .option(
        "--only-flaky",
        "Run only the quarantined specs (quarantine.testFiles in raiken.config.json)",
        false,
    )
    .option("--fix", "After a failure, run the AI repair flow (diff + confirm)", false)
    .action(async (file, options) => {
        try {
            const { testCommand } = await import("./commands/test");
            await testCommand(file, options);
        } catch (error) {
            handleCliError(error, {
                label: "raiken test failed",
            });
        }
    });

program
    .command("repair [file]")
    .description(
        "AI-repair a failing spec: runs it, shows the fix as a diff, writes after confirmation",
    )
    .option("--apply", "Write the fix without prompting (scripts / CI)", false)
    .option("--json", "Emit the repair outcome as JSON (implies no prompt)", false)
    .option("--no-interpret", "Skip the diagnosis step and go straight to the fix")
    .option(
        "--no-verify",
        "Skip re-running the spec after the fix is written (verification is on by default; unattended --apply reverts a fix that fails it)",
    )
    .action(async (file, options) => {
        try {
            const { repairCommand } = await import("./commands/repair");
            await repairCommand(file, options);
        } catch (error) {
            handleCliError(error, {
                label: "raiken repair failed",
            });
        }
    });

program
    .command("show-trace [path]")
    .description("Open a Playwright trace.zip in the trace viewer (newest when omitted)")
    .option("--json", "Emit the outcome as JSON", false)
    .action(async (tracePath, options) => {
        try {
            const { showTraceCommand } = await import("./commands/show-trace");
            await showTraceCommand(tracePath, options);
        } catch (error) {
            handleCliError(error, {
                label: "raiken show-trace failed",
            });
        }
    });

program
    .command("report [file]")
    .description("Run tests and write a detailed HTML report with screenshots")
    .option(
        "--from <json>",
        "Build from an existing Playwright OR `raiken ci` results JSON (skip running)",
    )
    .option("--format <formats>", "Comma-separated: html,markdown,json (default html,json)")
    .option("--output <dir>", "Output directory (default test-reports)")
    .option("--open", "Open the HTML report when done", false)
    .option("--json", "Emit the report result as JSON", false)
    .option("--no-embed-screenshots", "Link screenshots by path instead of embedding as data URIs")
    .action(async (file, options) => {
        try {
            const { reportCommand } = await import("./commands/report");
            await reportCommand(file, options);
        } catch (error) {
            handleCliError(error, {
                label: "raiken report failed",
            });
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
        await checkApiKey();
        try {
            const { syncCommand } = await import("./commands/sync");
            await syncCommand(options);
        } catch (error) {
            handleCliError(error, {
                label: "Sync failed",
            });
        }
    });

/**
 * One-shot dispatch. When the user leads with `-p`/`--print`, run a single
 * non-interactive agent request and exit, bypassing commander entirely so its
 * flags never collide with the subcommands' identically-named options.
 * `-p` must be the first argument (so `raiken start -p 7101` is unaffected).
 */
async function runOneShotFromArgv(argv: string[]): Promise<void> {
    const flag = (name: string): boolean => argv.includes(name);
    const valueAfter = (name: string): string | undefined => {
        const i = argv.indexOf(name);
        return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[i + 1] : undefined;
    };

    // The prompt is the first positional token after `-p`/`--print` that isn't a
    // flag; if absent it's read from piped stdin inside the command.
    const printIdx = argv.findIndex((a) => a === "-p" || a === "--print");
    const next = argv[printIdx + 1];
    const prompt = next && !next.startsWith("-") ? next : "";

    let timeoutMs: number | undefined;
    const timeoutRaw = valueAfter("--timeout");
    if (timeoutRaw !== undefined) {
        const parsed = Number(timeoutRaw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            console.error(
                chalk.red(`Invalid --timeout: "${timeoutRaw}". Must be a positive number of ms.`),
            );
            cliExit(CLI_EXIT.USAGE);
        }
        timeoutMs = parsed;
    }

    // Match the REPL/startup experience while keeping machine-readable
    // one-shot output on stdout clean (checkApiKey writes guidance to stderr).
    await checkApiKey();

    const { runOneShotCommand } = await import("./commands/oneshot");
    await runOneShotCommand({
        prompt,
        json: flag("--json"),
        streamJson: flag("--stream-json"),
        save: !flag("--no-save"),
        run: flag("--run"),
        headed: flag("--headed"),
        timeoutMs,
    });
}

/** Classic Levenshtein distance — drives the did-you-mean suggestion. */
function levenshtein(a: string, b: string): number {
    const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = dp[j];
            dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = tmp;
        }
    }
    return dp[b.length];
}

function closestCommand(input: string, candidates: string[]): string | undefined {
    let best: string | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
        const distance = levenshtein(input, candidate);
        // A typed prefix is a strong signal ("tes" → "test") even past distance 1.
        const score = candidate.startsWith(input) ? Math.min(distance, 1) : distance;
        if (score < bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return bestScore <= 3 ? best : undefined;
}

const knownCommands = new Set(program.commands.flatMap((cmd) => [cmd.name(), ...cmd.aliases()]));

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "-p" || cliArgs[0] === "--print") {
    runOneShotFromArgv(cliArgs).catch((error) => {
        handleCliError(error, { label: "Raiken one-shot failed" });
    });
} else {
    // Bare `raiken` launches the REPL; a leading positional must be a real
    // command, otherwise commander reports a misleading "too many arguments".
    const firstArg = cliArgs[0];
    if (firstArg && !firstArg.startsWith("-") && !knownCommands.has(firstArg)) {
        const suggestion = closestCommand(firstArg, [...knownCommands]);
        exitUsage(
            `Unknown command: "${firstArg}".` +
                (suggestion ? `\nDid you mean \`raiken ${suggestion}\`?` : "") +
                "\nRun `raiken --help` to see available commands.",
        );
    }
    try {
        program.parse(process.argv);
    } catch (error) {
        // exitOverride: commander has already printed its own message. Help
        // (explicit --help or a bare command group like `raiken hooks`) and
        // --version are success paths; every other commander error is an
        // argv-shape failure → USAGE(2) per contract.
        if (error instanceof CommanderError) {
            const isHelp = error.code.startsWith("commander.help");
            if (!isHelp && error.exitCode !== 0) cliExit(CLI_EXIT.USAGE);
        } else {
            throw error;
        }
    }
}
