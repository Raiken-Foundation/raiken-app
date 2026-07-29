#!/usr/bin/env node
import path from "node:path";
import { getRaikenVersion } from "@raiken/shared/lib/version";
import chalk from "chalk";
import { Command } from "commander";
import dotenv from "dotenv";

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
            process.exit(1);
        }
        await printBanner(getRaikenVersion());
        await checkApiKey();
        console.log(chalk.cyan("Initializing Raiken..."));
        try {
            const { startServer } = await import("./server");
            await startServer({ port, remote: options.remote });
        } catch (error) {
            console.error(
                chalk.red("Failed to start Raiken:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(1);
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
        console.error(
            chalk.red("Failed to start Raiken:"),
            error instanceof Error ? error.message : error,
        );
        process.exit(1);
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
            console.error(
                chalk.red("Failed to resume session:"),
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
            console.error(
                chalk.red("\n ✗ Failed to initialize project:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(1);
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
            console.error(
                chalk.red("\n ✗ raiken config failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
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
            console.error(
                chalk.red("\n ✗ Discovery failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(1);
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
            console.error(
                chalk.red("\n ✗ Authentication failed:"),
                error instanceof Error ? error.message : error,
            );
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
                chalk.red("\n ✗ raiken ci failed:"),
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
                chalk.red("\n ✗ raiken doctor failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
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
            console.error(
                chalk.red("\n ✗ raiken organize failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
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
            console.error(
                chalk.red("\n ✗ raiken eval failed:"),
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
                chalk.red("\n ✗ raiken context failed:"),
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
                chalk.red("\n ✗ raiken cover failed:"),
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
                chalk.red("\n ✗ raiken trace failed:"),
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
                chalk.red("\n ✗ raiken hooks install failed:"),
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
                chalk.red("\n ✗ raiken hooks uninstall failed:"),
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
                chalk.red("\n ✗ raiken hooks status failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
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
            console.error(
                chalk.red("\n ✗ raiken status failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
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
            console.error(
                chalk.red("\n ✗ raiken index failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
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
            console.error(
                chalk.red("\n ✗ raiken search failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
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
    .action(async (section, arg, options) => {
        try {
            const { knowledgeCommand } = await import("./commands/knowledge");
            await knowledgeCommand(section, arg, options);
        } catch (error) {
            console.error(
                chalk.red("\n ✗ raiken knowledge failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
        }
    });

program
    .command("memory [action]")
    .description("Inspect what the agent has learned about this project ([show] | clear)")
    .option("--json", "Emit memory as JSON", false)
    .action(async (action, options) => {
        try {
            const { memoryCommand } = await import("./commands/memory");
            await memoryCommand(action, options);
        } catch (error) {
            console.error(
                chalk.red("\n ✗ raiken memory failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
        }
    });

program
    .command("test [file]")
    .description("Run the Playwright suite (or a single spec) and report pass/fail")
    .option("--json", "Emit the run summary as JSON", false)
    .action(async (file, options) => {
        try {
            const { testCommand } = await import("./commands/test");
            await testCommand(file, options);
        } catch (error) {
            console.error(
                chalk.red("\n ✗ raiken test failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(2);
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
            console.error(
                chalk.red("\n ✗ raiken report failed:"),
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
        await checkApiKey();
        try {
            const { syncCommand } = await import("./commands/sync");
            await syncCommand(options);
        } catch (error) {
            console.error(
                chalk.red("\n ✗ Sync failed:"),
                error instanceof Error ? error.message : error,
            );
            process.exit(1);
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
            process.exit(1);
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

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "-p" || cliArgs[0] === "--print") {
    runOneShotFromArgv(cliArgs).catch((error) => {
        console.error(
            chalk.red("Raiken one-shot failed:"),
            error instanceof Error ? error.message : error,
        );
        process.exit(1);
    });
} else {
    program.parse(process.argv);
}
