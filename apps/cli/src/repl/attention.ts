/**
 * REPL startup attention banner.
 *
 * The goal of this session is "the system gets out of the user's way" —
 * which cuts both ways: it should also stop being *silently* in the way.
 * Before this, a paused discovery session, an unresolved auth blocker, or a
 * missing AI key from a previous session only surfaced as a confusing
 * failure mid-turn ("no pages found", a cryptic LLM auth error) with no clue
 * that something was left over from before. This module gathers anything
 * worth flagging up front, once, at REPL startup.
 */
import * as fs from "node:fs";
import {
    createProjectApplication,
    formatActiveWorkflowAttention,
    getConfigPath,
    getProvider,
    resolveAIConfig,
    WorkflowStore,
} from "@raiken/core";
import chalk from "chalk";
import { dim } from "../agent-stream";

/**
 * Gather human-readable attention items for the REPL startup banner.
 * Never throws — each check is independently best-effort so a DB that
 * hasn't been created yet (fresh project) or an unreadable config file
 * degrades to "say nothing about that check" instead of blocking startup.
 */
export async function gatherAttentionItems(
    projectPath: string,
    bootstrapWarnings: string[] = [],
): Promise<string[]> {
    const items: string[] = [];

    const initialized = fs.existsSync(getConfigPath(projectPath));
    if (!initialized) {
        items.push(
            "This project has not been initialized — run `raiken init` to set up test defaults, " +
                "generated-file ignores, and its AI provider.",
        );
    }

    // Before init there is no project-level provider choice yet. Showing an
    // additional OpenRouter-key warning at this point is both redundant and
    // misleading, so defer provider readiness until after initialization.
    if (initialized) {
        try {
            const ai = resolveAIConfig(projectPath);
            const provider = getProvider(ai.provider);
            if (provider.envVars.length > 0 && !ai.apiKey) {
                items.push(
                    `${provider.label} needs an API key before Raiken can run. Use \`/config\` to set ` +
                        `one for this project, set ${provider.envVars[0]}, or open dashboard Settings.`,
                );
            }
        } catch {
            /* config unreadable — surfaced elsewhere (bootstrap), skip here */
        }
    }

    try {
        const app = createProjectApplication(projectPath);
        const session = app.discovery.getSessionView();
        const stats = app.discovery.getStats();
        if (session?.status === "paused") {
            items.push(
                `Discovery paused at ${session.startUrl} (${session.pagesDiscovered} pages, ` +
                    `${session.linksFound} links) — run \`/discover --continue\` to keep going.`,
            );
        } else if (session?.status === "failed") {
            items.push(
                `Last discovery run failed for ${session.startUrl} — run \`/discover ${session.startUrl}\` to retry.`,
            );
        } else if (stats && stats.unresolvedBlockersCount > 0) {
            // Only reached when the session itself isn't paused/failed (both
            // branches above already imply blockers) — an older session that
            // otherwise completed but left blockers unresolved.
            items.push(
                `${stats.unresolvedBlockersCount} unresolved discovery blocker(s) — run ` +
                    "`/knowledge blockers` to see them, or `/discover --continue`.",
            );
        }
    } catch {
        /* discovery DB not initialized yet (fresh project) — nothing to report */
    }

    try {
        const workflows = await new WorkflowStore(projectPath).listActive();
        items.push(...workflows.slice(0, 3).map(formatActiveWorkflowAttention));
        if (workflows.length > 3) {
            items.push(`${workflows.length - 3} additional test workflows need attention.`);
        }
    } catch {
        /* workflow directory missing or unreadable — nothing to report */
    }

    items.push(...bootstrapWarnings);

    return items;
}

/** Render the gathered items as a compact warning block. No-op when empty. */
export function renderAttentionBanner(items: string[]): void {
    if (items.length === 0) return;
    console.log(chalk.yellow("\n  ⚠ Needs attention"));
    for (const item of items) {
        console.log(`    ${dim("·")} ${item}`);
    }
}
