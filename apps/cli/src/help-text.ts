/**
 * Grouped `raiken --help`.
 *
 * Commander prints subcommands as one flat list in registration order. At 25
 * commands that reads as an inventory rather than a way in: `cover` and
 * `doctor` — the two a newcomer needs on day one — sit between `ci` and
 * `eval` with equal weight, and nothing says which order to run anything in.
 *
 * Groups below are named after the task the reader has, not the module the
 * command lives in, and the file ends with the first-run sequence so the
 * answer to "what do I type now" is on screen without reading the README.
 */

import chalk from "chalk";

export interface HelpEntry {
    /** How the command is typed, including its most-used argument. */
    invocation: string;
    summary: string;
}

export interface HelpGroup {
    title: string;
    entries: HelpEntry[];
}

const entry = (invocation: string, summary: string): HelpEntry => ({ invocation, summary });

export const HELP_GROUPS: HelpGroup[] = [
    {
        title: "Set up",
        entries: [
            entry("init", "Set up Raiken in this project"),
            entry("config [provider|key]", "Choose the AI provider, model, and API key"),
            entry("status", "What is configured, indexed, discovered, remembered"),
            entry("doctor [--fix]", "Check the environment; fix common config problems"),
        ],
    },
    {
        title: "Teach Raiken your app",
        entries: [
            entry("discover [url]", "Crawl the app; record pages, links, and forms"),
            entry("auth", "Log in, save the session, and crawl behind it"),
            entry("knowledge", "Inspect what discovery recorded (alias: kb)"),
            entry("index", "Build the code graph and keyword search index"),
        ],
    },
    {
        title: "The behavior contract",
        entries: [
            entry(
                "contract",
                "Observed behavior vs ticket requirements: capture, import, verify, materialize",
            ),
            entry("mcp", "Expose the contract as MCP tools for coding agents"),
        ],
    },
    {
        title: "Write and run tests",
        entries: [
            entry("cover <scenario>", "Draft a spec from a scenario, AC, or symbol"),
            entry("test [file]", "Run the suite or one spec (--watch, --list, --fix)"),
            entry("repair [file]", "AI-fix a failing spec; shows a diff before writing"),
            entry("report [file]", "Run and write an HTML report with screenshots"),
            entry("show-trace [path]", "Open a Playwright trace (newest when omitted)"),
        ],
    },
    {
        title: "Dashboard",
        entries: [entry("start", "Dashboard at http://localhost:7101")],
    },
    {
        title: "CI and analysis",
        entries: [
            entry("ci", "Impact analysis + affected tests, JUnit/JSON output"),
            entry("sync", "Sync with the ticket system and analyse impact"),
            entry("trace [stack]", "Which tests most likely reproduce a stack trace"),
            entry("context", "Write raiken.ctx.md for IDE AI agents"),
            entry("search <query>", "Semantic code search"),
            entry("eval <suite>", "Agent eval suites and flakiness scoring"),
        ],
    },
    {
        title: "Housekeeping",
        entries: [
            entry("memory", "What the agent has learned about this project"),
            entry("sessions", "List saved one-shot agent sessions (see `raiken -p`)"),
        ],
    },
];

const ONE_SHOT_LINES: HelpEntry[] = [
    entry('raiken -p "test the login flow"', "stream the answer"),
    entry('raiken -p "cover checkout" --json', "machine-readable result"),
    entry('raiken -p "..." --run', "run it; exit code = pass/fail"),
];

const ONE_SHOT_FLAGS =
    "--json  --stream-json  --run  --no-save  --no-diagnose  --headed  " +
    "--timeout <ms>  --allow-ungrounded";

/** Longest invocation across every section, so one column serves them all. */
const COLUMN = Math.max(
    ...HELP_GROUPS.flatMap((group) => group.entries.map((item) => item.invocation.length)),
    ...ONE_SHOT_LINES.map((item) => item.invocation.length),
);

function formatEntry(item: HelpEntry): string {
    return `  ${chalk.cyan(item.invocation.padEnd(COLUMN))}  ${item.summary}`;
}

/**
 * The grouped body appended under commander's usage/options block. Commander
 * renders the flat command list itself; `bin.ts` suppresses that for the root
 * command so this replaces it rather than duplicating it.
 */
export function renderMainHelp(): string {
    const sections = HELP_GROUPS.map(
        (group) => `${chalk.bold(group.title)}\n${group.entries.map(formatEntry).join("\n")}`,
    );

    sections.push(
        `${chalk.bold("One-shot (non-interactive)")}\n` +
            `${ONE_SHOT_LINES.map(formatEntry).join("\n")}\n` +
            `  ${chalk.dim(`flags: ${ONE_SHOT_FLAGS}`)}`,
    );

    sections.push(
        `${chalk.bold("First run")}\n` +
            [
                "raiken init",
                "raiken doctor --fix",
                "raiken discover http://localhost:3000",
                "raiken contract capture http://localhost:3000",
                "raiken contract import --file requirements.md",
                "raiken contract verify",
            ]
                .map((line) => `  ${chalk.dim(line)}`)
                .join("\n") +
            `\n\n  ${chalk.dim(
                "Anything behind a login: run `raiken auth` first — it crawls the signed-in app too.",
            )}\n  ${chalk.dim(
                "Need a classic spec? `raiken cover \"user can add an item to the cart\"` then `raiken test e2e/<draft>.spec.ts`.",
            )}\n  ${chalk.dim("`raiken <command> --help` for that command's flags.")}`,
    );

    return `\n${sections.join("\n\n")}\n`;
}
