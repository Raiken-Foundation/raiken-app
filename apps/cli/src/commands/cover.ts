/**
 * `raiken cover <target>` — draft a Playwright test from an acceptance
 * criterion (`AC-2`), a code symbol (`LoginForm`), or a free-text scenario.
 *
 * Triggered locally or by the `/raiken cover ...` GitHub workflow.
 */

import * as path from "node:path";
import {
    type CoverEvent,
    type CoverResult,
    getProvider,
    resolveAIConfig,
    runCover,
} from "@raiken/core";
import { loadIntegrationsConfig } from "@raiken/shared/server";
import chalk from "chalk";
import { CLI_EXIT, mapErrorToCliExitCode, safeCliErrorMessage } from "../errors";
import { cliExit } from "../repl/exit";

interface CoverCommandOptions {
    ticket?: string;
    output?: string;
    dir?: string;
    dryRun?: boolean;
    json?: boolean;
    allowUngrounded?: boolean;
    fixConfig?: boolean;
}

export async function coverCommand(target: string, options: CoverCommandOptions): Promise<void> {
    const projectPath = process.cwd();

    if (!target || !target.trim()) {
        console.error(
            chalk.red(
                'Missing target. Usage: raiken cover <AC-N | symbolName | "free-text scenario">',
            ),
        );
        cliExit(CLI_EXIT.USAGE);
    }

    const integrationConfig = loadIntegrationsConfig(projectPath);
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
            allowUngrounded: options.allowUngrounded === true,
            fixConfig: options.fixConfig === true,
            onProgress: options.json
                ? undefined
                : (message) => console.log(chalk.dim(`  ${message}`)),
            onEvent: options.json ? undefined : (event) => logEvent(event),
        });
    } catch (err) {
        console.error(chalk.red(`\n✗ raiken cover failed: ${safeCliErrorMessage(err)}`));
        cliExit(mapErrorToCliExitCode(err));
    }

    if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (result.needsReview) cliExit(CLI_EXIT.RUNTIME_FAILURE);
        return;
    }

    const relativePath = path.relative(projectPath, result.outputPath);
    console.log();
    if (result.blocked || result.needsReview) {
        console.log(
            chalk.yellow(
                result.blocked
                    ? `✗ Wrote ${relativePath} — draft is blocked and cannot run as written`
                    : `⚠ Wrote ${relativePath} — draft needs edits before it can run`,
            ),
        );
        for (const reason of result.reviewReasons) {
            console.log(chalk.yellow(`   - ${reason}`));
        }
    } else {
        console.log(chalk.green(`✓ Wrote ${relativePath}`));
    }
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
    if (result.todoNotes > 0) {
        console.log(
            chalk.dim(`   ${result.todoNotes} optional TODO note(s) in comments — not blocking`),
        );
    }
    if (result.grounding && result.grounding.sourceGrounded.length > 0) {
        console.log(
            chalk.dim(
                `   ${result.grounding.sourceGrounded.length} selector(s) grounded in source markup (state not captured live)`,
            ),
        );
    }
    console.log();
    // A blocked draft cannot be collected or parsed, so `raiken test` on it
    // reports something misleading ("No tests found", a compile error) that
    // reads as a broken spec. Send people at the blocker instead.
    if (result.blocked) {
        const configBlocked = result.reviewReasons.some((reason) => /testMatch/i.test(reason));
        console.log(
            chalk.dim(
                configBlocked
                    ? `Fix the config first: ${chalk.bold("raiken doctor --fix")} (or re-run cover with ${chalk.bold("--fix-config")}). Running it now reports "No tests found".`
                    : "Fix the blocking items above — this draft cannot run as written.",
            ),
        );
    } else {
        console.log(
            result.needsReview
                ? chalk.dim(
                      `Fix the items above, then run with ${chalk.bold(`raiken test ${relativePath}`)}.`,
                  )
                : chalk.dim(
                      `Review the draft and run with ${chalk.bold(`raiken test ${relativePath}`)}.`,
                  ),
        );
    }
    if (result.needsReview) cliExit(CLI_EXIT.RUNTIME_FAILURE);
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
        case "knowledge_ensured":
            if (event.status === "ready" && event.discovered) {
                console.log(
                    chalk.dim(
                        `  knowledge: auto-discovered from ${event.seedUrl ?? "seed URL"}`,
                    ),
                );
            }
            break;
        case "evidence_gathered": {
            const parts = [
                event.baseURL ? `baseURL ${event.baseURL}` : null,
                event.pages > 0 ? `${event.pages} discovered page(s)` : null,
                event.snapshots > 0 ? `${event.snapshots} snapshot(s)` : null,
                event.sourceSelectors > 0 ? `${event.sourceSelectors} source selector(s)` : null,
            ].filter(Boolean);
            console.log(
                chalk.dim(
                    parts.length > 0
                        ? `  evidence: ${parts.join(", ")}`
                        : "  evidence: none found — run `raiken discover` / `raiken index` for grounded drafts",
                ),
            );
            break;
        }
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
