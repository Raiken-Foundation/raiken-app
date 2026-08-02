import {
    AgentMemory,
    createProjectApplication,
    isRunScopedPreference,
} from "@raiken/core";
import chalk from "chalk";
import { accent, dim, routeDiagnosticsToStderr } from "../agent-stream";
import { exitUsage } from "../errors";
import { confirmDestructive } from "./confirm-destructive";

interface MemoryOptions {
    json?: boolean;
    /** Include run/session working state (goal, pause reason, last exploration). */
    all?: boolean;
    /** Skip the confirmation prompt for destructive actions (scripts / CI). */
    force?: boolean;
    /** REPL-injected confirm prompt (inquirer can't run inside the REPL). */
    confirm?: (message: string) => Promise<boolean>;
}

/** Group a flat preference map into human-friendly sections for display. */
function categorize(prefs: Record<string, string>): Record<string, [string, string][]> {
    const groups: Record<string, [string, string][]> = {
        Project: [],
        "Learned actions": [],
        "Learned selectors": [],
        Session: [],
        Other: [],
    };
    for (const [key, value] of Object.entries(prefs)) {
        if (isRunScopedPreference(key)) groups.Session.push([key, value]);
        else if (key.startsWith("action_path:")) groups["Learned actions"].push([key, value]);
        else if (key.startsWith("selector:")) groups["Learned selectors"].push([key, value]);
        else if (key.includes("base_url") || key.includes("project") || key === "test_directory")
            groups.Project.push([key, value]);
        else groups.Other.push([key, value]);
    }
    return groups;
}

/**
 * `raiken memory [clear]` — inspect (or reset) what the agent has learned about
 * this project: the base URL, remembered authenticated entry, action paths, and
 * learned selectors. Makes the agent's persistent memory transparent instead of
 * a black box.
 *
 * By default only durable knowledge is shown. Run/session markers
 * (`paused_reason`, `active_goal`, last exploration, …) used to look like
 * lasting preferences — pass `--all` to include them.
 */
export async function memoryCommand(
    sub: string | undefined,
    options: MemoryOptions,
): Promise<void> {
    const projectPath = process.cwd();

    const action = (sub || "").toLowerCase();

    if (action === "clear") {
        const ok = await confirmDestructive(
            "Reset agent working memory (goal, remembered exploration, pause + observed login) for this project",
            { force: options.force, confirm: options.confirm },
        );
        if (!ok) {
            console.log(dim("\n  Clear cancelled.\n"));
            return;
        }
        createProjectApplication(projectPath).chat.clearAgentMemory();
        console.log(
            chalk.green("\n  ✓ Reset agent working memory") +
                dim(" (goal, remembered exploration, pause + observed login).\n"),
        );
        return;
    }

    // "show" is the documented default action (bare `raiken memory`) — accept
    // it explicitly; anything else is a usage error.
    if (action && action !== "show") {
        exitUsage(
            `Unknown memory action: '${sub}'\nUsage: raiken memory [show|clear] [--all] [--json] [--force]`,
        );
    }

    // Route diagnostics to stderr BEFORE initialize() so --json stdout stays
    // clean for scripting. initialize(false): this command renders its own UI.
    const restore = options.json ? routeDiagnosticsToStderr() : null;
    const mem = AgentMemory.getInstance(projectPath);
    mem.initialize(false);
    const prefs = options.all ? mem.getAllPreferences() : mem.getDurablePreferences();

    if (options.json) {
        restore?.();
        process.stdout.write(`${JSON.stringify(prefs, null, 2)}\n`);
        return;
    }

    const keys = Object.keys(prefs).filter((key) => prefs[key] !== "");
    if (keys.length === 0) {
        console.log(
            dim(
                options.all
                    ? "\n  Agent memory is empty. It fills in as you run the agent.\n"
                    : "\n  No durable agent memory yet. Run the agent, or pass --all to include session state.\n",
            ),
        );
        return;
    }

    const title = options.all ? "Agent memory (all)" : "Agent memory";
    console.log(accent(`\n  ${title}`) + dim(`  ·  ${keys.length} entries`));
    const groups = categorize(Object.fromEntries(keys.map((key) => [key, prefs[key] ?? ""])));
    for (const [group, entries] of Object.entries(groups)) {
        if (entries.length === 0) continue;
        console.log(accent(`\n  ${group}`));
        for (const [key, value] of entries) {
            const shown = value.length > 100 ? `${value.slice(0, 100)}…` : value;
            console.log(`  ${dim("•")} ${chalk.white(key)} ${dim("=")} ${dim(shown)}`);
        }
    }
    if (!options.all) {
        console.log(dim("\n  Session state hidden — pass --all to include it."));
    }
    console.log(dim("\n  Reset with `raiken memory clear`.\n"));
}
