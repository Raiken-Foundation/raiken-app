/**
 * `raiken organize` — dry-run report (and, on confirmation, apply) an
 * AI-assisted reorganization of the test directory into feature/suite
 * folders, plus a deterministic `raiken.config.json` cleanup.
 */

import { applyOrganizePlan, type OrganizeResult, resolveAIConfig, runOrganize } from "@raiken/core";
import chalk from "chalk";
import { cliExit } from "../repl/exit";

interface OrganizeCommandOptions {
    yes?: boolean;
    testsOnly?: boolean;
    configOnly?: boolean;
    json?: boolean;
    /**
     * Injected by the REPL (`/organize` in chat.ts): inquirer's own prompt
     * spawns a second readline on stdin while the REPL's readline is still
     * attached — every keypress gets double-echoed and raw mode is left
     * desynced when inquirer tears down. Standalone `raiken organize` leaves
     * this unset and gets the inquirer prompt.
     */
    confirm?: (message: string) => Promise<boolean>;
}

export async function organizeCommand(options: OrganizeCommandOptions): Promise<void> {
    const projectPath = process.cwd();
    const includeTests = !options.configOnly;
    const includeConfig = !options.testsOnly;

    const resolvedAI = resolveAIConfig(projectPath);
    const result = await runOrganize({
        projectPath,
        includeTests,
        includeConfig,
        ai: { apiKey: resolvedAI.apiKey, model: resolvedAI.model, baseURL: resolvedAI.baseURL },
    });

    const hasChanges = hasProposedChanges(result);

    if (options.json && !options.yes) {
        process.stdout.write(`${JSON.stringify(redactSecrets(result), null, 2)}\n`);
    } else if (!options.json) {
        printReport(result);
    }

    if (!hasChanges) {
        if (options.json && options.yes) {
            process.stdout.write(`${JSON.stringify({ plan: result, apply: null }, null, 2)}\n`);
        } else if (!options.json) {
            console.log(chalk.green("\n✓ Nothing to organize."));
        }
        return;
    }

    // `--json` is a scripting/CI surface: never block on an interactive
    // prompt there. Applying still requires an explicit `--yes`, same as
    // the human path — `--json` alone only ever produces the plan.
    if (options.json && !options.yes) return;

    const confirmed = options.yes
        ? true
        : await (options.confirm ? options.confirm("Apply these changes?") : confirmApply());
    if (!confirmed) {
        if (!options.json) console.log(chalk.dim("\nNo changes applied."));
        return;
    }

    const applyResult = await applyOrganizePlan(projectPath, result);

    if (options.json) {
        process.stdout.write(
            `${JSON.stringify({ plan: redactSecrets(result), apply: applyResult }, null, 2)}\n`,
        );
    } else {
        console.log();
        if (applyResult.movedFiles > 0) {
            console.log(chalk.green(`✓ Moved ${applyResult.movedFiles} test file(s).`));
        }
        if (applyResult.rewrittenImportFiles > 0) {
            console.log(
                chalk.green(
                    `✓ Rewrote relative imports in ${applyResult.rewrittenImportFiles} file(s).`,
                ),
            );
        }
        if (applyResult.configWritten) {
            console.log(chalk.green("✓ Updated raiken.config.json."));
        }
        for (const err of applyResult.errors) {
            console.log(chalk.red(`✗ ${err}`));
        }
    }

    cliExit(applyResult.errors.length > 0 ? 1 : 0);
}

function hasProposedChanges(result: OrganizeResult): boolean {
    const hasMoves = (result.testPlan?.moves.length ?? 0) > 0;
    const hasConfigChanges = (result.configCleanup?.changes.length ?? 0) > 0;
    return hasMoves || hasConfigChanges;
}

/**
 * The organize result embeds a cleaned raiken.config.json, which carries the
 * plaintext AI API key. JSON is a scripting surface — logs, CI dashboards —
 * so the key must never be echoed there.
 */
function redactSecrets<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map((item) => redactSecrets(item)) as unknown as T;
    }
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            if (
                (key === "apiKey" || key === "api_key" || key.toLowerCase().endsWith("apikey")) &&
                typeof item === "string" &&
                item.length > 0
            ) {
                out[key] = "sk-…(redacted)";
            } else {
                out[key] = redactSecrets(item);
            }
        }
        return out as unknown as T;
    }
    return value;
}

async function confirmApply(): Promise<boolean> {
    const { confirm } = await import("@inquirer/prompts");
    return confirm({ message: "Apply these changes?", default: false });
}

function printReport(result: OrganizeResult): void {
    console.log(chalk.cyan(`\nraiken organize — ${result.testDirectory}/\n`));

    if (result.configCleanup) {
        printConfigCleanup(result.configCleanup);
    }

    if (result.testPlan) {
        printTestPlan(result.testPlan);
    }
}

function printConfigCleanup(cleanup: NonNullable<OrganizeResult["configCleanup"]>): void {
    console.log(chalk.bold("raiken.config.json"));
    if (cleanup.skipped && cleanup.changes.length === 0) {
        console.log(chalk.dim("  (no raiken.config.json found — skipped)\n"));
        return;
    }
    if (cleanup.changes.length === 0) {
        console.log(chalk.dim("  Clean — no changes proposed.\n"));
        return;
    }
    for (const change of cleanup.changes) {
        console.log(`  ${chalk.yellow("~")} ${chalk.dim(change.path)}`);
        console.log(`     ${change.description}`);
    }
    console.log();
}

function printTestPlan(plan: NonNullable<OrganizeResult["testPlan"]>): void {
    console.log(chalk.bold("Test organization"));
    console.log(chalk.dim(`  ${plan.summary}`));

    if (plan.moves.length > 0) {
        console.log();
        for (const move of plan.moves) {
            console.log(`  ${chalk.yellow("→")} ${move.from}`);
            console.log(`    ${chalk.dim("->")} ${move.to}`);
            console.log(`    ${chalk.dim(move.reason)}`);
        }
    }

    if (plan.warnings.length > 0) {
        console.log();
        for (const warning of plan.warnings) {
            const location = warning.file ? `${warning.file}: ` : "";
            console.log(`  ${chalk.yellow("!")} ${location}${warning.message}`);
        }
    }

    if (plan.usedModel) {
        console.log(chalk.dim(`\n  model: ${plan.usedModel}`));
    }
    console.log();
}
