/**
 * `raiken cover <target>` — draft a Playwright test from an acceptance
 * criterion (`AC-2`), a code symbol (`LoginForm`), or a free-text scenario.
 *
 * Triggered locally or by the `/raiken cover ...` GitHub workflow.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
    type CoverEvent,
    type CoverResult,
    getProvider,
    resolveAIConfig,
    runCover,
} from "@raiken/core";
import chalk from "chalk";
import { cliExit } from "../repl/exit";

interface CoverCommandOptions {
    ticket?: string;
    output?: string;
    dir?: string;
    dryRun?: boolean;
    json?: boolean;
}

export async function coverCommand(target: string, options: CoverCommandOptions): Promise<void> {
    const projectPath = process.cwd();

    if (!target || !target.trim()) {
        console.error(
            chalk.red(
                'Missing target. Usage: raiken cover <AC-N | symbolName | "free-text scenario">',
            ),
        );
        cliExit(2);
    }

    const integrationConfig = loadIntegrationConfig(projectPath);
    // Use the shared provider-aware resolver so `cover` honors the configured
    // provider + provider-specific env vars (e.g. ANTHROPIC_API_KEY), not just
    // OPENROUTER_API_KEY / the raw `ai` block.
    const resolved = resolveAIConfig(projectPath);
    const ai = resolved;
    const provider = getProvider(resolved.provider);

    if (!options.dryRun && provider.envVars.length > 0 && !ai.apiKey) {
        console.warn(
            chalk.yellow(
                `⚠ No ${provider.label} API key found (${provider.envVars[0]} / raiken.config.json). ` +
                    "Falling back to scaffold mode (--dry-run).",
            ),
        );
    }

    if (!options.json) {
        console.log(chalk.cyan(`\nraiken cover — drafting test for "${target}"\n`));
    }

    let result: CoverResult;
    try {
        result = await runCover({
            projectPath,
            target,
            ticketId: options.ticket,
            outputPath: options.output,
            testDirectory: options.dir,
            integrations: integrationConfig,
            ai,
            dryRun: options.dryRun === true,
            onEvent: options.json ? undefined : (event) => logEvent(event),
        });
    } catch (err) {
        console.error(
            chalk.red(`\n✗ raiken cover failed: ${err instanceof Error ? err.message : err}`),
        );
        cliExit(2);
    }

    if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }

    console.log();
    console.log(chalk.green(`✓ Wrote ${path.relative(projectPath, result.outputPath)}`));
    if (result.usedModel) {
        console.log(chalk.dim(`   model: ${result.usedModel}`));
    } else {
        console.log(chalk.dim("   mode:  scaffold (no LLM call)"));
    }
    if (result.ticket) {
        console.log(chalk.dim(`   ticket: ${result.ticket.id} — ${result.ticket.title}`));
    }
    if (result.sourceFiles.length > 0) {
        console.log(chalk.dim(`   context: ${result.sourceFiles.length} source file(s)`));
    }
    console.log();
    console.log(
        chalk.dim(
            "Review the draft, replace TODOs, and run with " +
                `${chalk.bold(`npx playwright test ${path.relative(projectPath, result.outputPath)}`)}.`,
        ),
    );
}

// ---------------------------------------------------------------------------
// Event logging
// ---------------------------------------------------------------------------

function logEvent(event: CoverEvent): void {
    switch (event.type) {
        case "target_resolved":
            console.log(chalk.dim(`  resolved: kind=${event.kind}`));
            break;
        case "ticket_loaded":
            console.log(chalk.dim(`  ticket: ${event.ticketId} — ${event.title}`));
            break;
        case "symbols_resolved":
            for (const m of event.matches) {
                console.log(chalk.dim(`  symbol: ${m.name} — ${m.file}`));
            }
            break;
        case "llm_started":
            console.log(chalk.dim("  calling LLM…"));
            break;
        case "llm_finished":
            console.log(chalk.dim(`  LLM returned ${event.bytes} bytes`));
            break;
        case "file_written":
            // Final summary handles this; suppress the noisy mid-stream log.
            break;
    }
}

// ---------------------------------------------------------------------------
// Config loaders
// ---------------------------------------------------------------------------

function loadIntegrationConfig(projectPath: string) {
    try {
        const raw = JSON.parse(
            fs.readFileSync(path.join(projectPath, "raiken.config.json"), "utf-8"),
        );
        return raw?.integrations;
    } catch {
        return undefined;
    }
}
