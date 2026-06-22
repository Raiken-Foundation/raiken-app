import fs from "node:fs";
import path from "node:path";
import { type SyncResult, syncCurrentTicket } from "@raiken/core";
import chalk from "chalk";

interface SyncCommandOptions {
    ticket?: string;
}

export async function syncCommand(options: SyncCommandOptions): Promise<void> {
    const projectPath = process.cwd();

    // Load integration config from raiken.config.json
    let integrationConfig: Record<string, unknown> | undefined;
    let aiConfig: { apiKey?: string; model?: string; baseURL?: string } | undefined;

    try {
        const configPath = path.join(projectPath, "raiken.config.json");
        const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        integrationConfig = raw?.integrations;
        if (raw?.ai) {
            aiConfig = {
                apiKey: raw.ai.apiKey || process.env.OPENROUTER_API_KEY,
                model: raw.ai.model,
                baseURL: raw.ai.baseURL,
            };
        }
    } catch {
        // No config file, use defaults
    }

    if (!aiConfig?.apiKey) {
        aiConfig = {
            ...aiConfig,
            apiKey: process.env.OPENROUTER_API_KEY,
        };
    }

    console.log(chalk.cyan("\n🔄 Syncing with ticket system...\n"));

    const result = await syncCurrentTicket({
        projectPath,
        config: integrationConfig as Parameters<typeof syncCurrentTicket>[0]["config"],
        ticketId: options.ticket,
        ai: aiConfig,
    });

    printSyncResult(result);
}

function printSyncResult(result: SyncResult): void {
    console.log(chalk.dim(`Branch: ${result.branchName}`));
    console.log(chalk.dim(`Source: ${result.source}`));
    console.log();

    if (!result.ticket) {
        console.log(chalk.yellow("No ticket found for the current branch."));
        console.log(chalk.dim("  Tip: Use a branch name like feat/GH-42-description"));
        console.log(chalk.dim("  Or specify manually: raiken sync --ticket 42"));
        return;
    }

    const t = result.ticket;
    console.log(chalk.bold(`#${t.id}: ${t.title}`));
    console.log(chalk.dim(`  ${t.url}`));
    console.log(chalk.dim(`  Status: ${t.status}  |  Labels: ${t.labels.join(", ") || "none"}`));

    if (t.changedFiles && t.changedFiles.length > 0) {
        console.log(chalk.dim(`  Changed files: ${t.changedFiles.length}`));
    }
    console.log();

    if (!result.impact) {
        console.log(chalk.yellow("Could not analyze ticket impact."));
        return;
    }

    const impact = result.impact;

    console.log(chalk.cyan("Impact Analysis"));
    console.log(chalk.dim("─".repeat(50)));
    console.log(impact.summary);
    console.log();

    if (impact.affectedSourceFiles.length > 0) {
        console.log(chalk.bold("Affected source files:"));
        for (const f of impact.affectedSourceFiles.slice(0, 15)) {
            console.log(chalk.dim(`  ${f}`));
        }
        if (impact.affectedSourceFiles.length > 15) {
            console.log(chalk.dim(`  ... and ${impact.affectedSourceFiles.length - 15} more`));
        }
        console.log();
    }

    if (impact.affectedTestFiles.length > 0) {
        console.log(chalk.bold("Affected test files:"));
        const uniqueTests = [...new Set(impact.affectedTestFiles.map((t) => t.testFile))];
        for (const testFile of uniqueTests.slice(0, 10)) {
            const reasons = impact.affectedTestFiles
                .filter((t) => t.testFile === testFile)
                .map((t) => t.reason);
            const reasonStr = [...new Set(reasons)].join(", ");
            console.log(`  ${chalk.yellow("●")} ${testFile} ${chalk.dim(`(${reasonStr})`)}`);
        }
        console.log();
    }

    if (impact.suggestions.length > 0) {
        console.log(chalk.bold("Suggestions:"));
        for (const s of impact.suggestions) {
            const icon =
                s.action === "create_test"
                    ? chalk.green("+")
                    : s.action === "update_test"
                      ? chalk.yellow("~")
                      : s.action === "review_test"
                        ? chalk.blue("?")
                        : chalk.dim("-");
            const file = s.testFile ? chalk.dim(` → ${s.testFile}`) : "";
            console.log(`  ${icon} ${s.reason}${file}`);
            if (s.suggestedPrompt) {
                console.log(chalk.dim(`    Prompt: "${s.suggestedPrompt}"`));
            }
        }
        console.log();
    }

    console.log(chalk.dim(`Analyzed at ${impact.analyzedAt}`));
}
