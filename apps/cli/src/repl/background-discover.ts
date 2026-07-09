/**
 * Background site discovery for the interactive REPL.
 *
 * Starts a crawl without blocking the prompt loop. Progress is written to
 * stderr; the status strip can poll `getBackgroundDiscoverStatus()`.
 */

import type { DiscoveryEvent, DiscoveryStats, SiteDiscovery } from "@raiken/core";
import { loadDiscoveryConfig, resolveAuthStorageStatePath } from "@raiken/shared";
import chalk from "chalk";
import { accent, dim } from "../agent-stream";

export type BackgroundDiscoverState =
    | { status: "idle" }
    | {
          status: "running" | "paused" | "completed" | "failed";
          startUrl: string;
          pages: number;
          maxPages: number;
          currentUrl?: string;
          error?: string;
          startedAt: number;
      };

let active: {
    discovery: SiteDiscovery;
    state: Exclude<BackgroundDiscoverState, { status: "idle" }>;
    done: Promise<void>;
} | null = null;

export function getBackgroundDiscoverStatus(): BackgroundDiscoverState {
    if (!active) return { status: "idle" };
    return { ...active.state };
}

export function isDiscoverRunning(): boolean {
    return active?.state.status === "running";
}

/**
 * Start a background crawl. Rejects if one is already running.
 * Returns immediately; the crawl continues in the background.
 */
export async function startBackgroundDiscover(params: {
    url: string;
    projectPath: string;
    maxPages?: number;
    maxDepth?: number;
    skipAuth?: boolean;
}): Promise<void> {
    if (active && (active.state.status === "running" || active.state.status === "paused")) {
        throw new Error(
            "Discovery already in progress. Wait for it to finish, or check /discover status.",
        );
    }

    const config = loadDiscoveryConfig(params.projectPath);
    const maxPages = params.maxPages ?? config.maxPages;
    const maxDepth = params.maxDepth ?? config.maxDepth;
    const storageStatePath = resolveAuthStorageStatePath(params.projectPath);

    const { SiteDiscovery } = await import("@raiken/core");
    const discovery = new SiteDiscovery({
        startUrl: params.url,
        projectPath: params.projectPath,
        maxPages,
        maxDepth,
        maxConcurrency: config.maxConcurrency,
        timeout: config.timeout,
        excludePatterns: config.excludePatterns,
        pauseOnAuth: params.skipAuth ? false : config.pauseOnAuth,
        storageStatePath,
        maxRunTimeMs: config.maxRunTimeMs,
    });

    const state: Exclude<BackgroundDiscoverState, { status: "idle" }> = {
        status: "running",
        startUrl: params.url,
        pages: 0,
        maxPages,
        startedAt: Date.now(),
    };

    const updateFromStats = () => {
        try {
            const stats: DiscoveryStats = discovery.getStats();
            state.pages = stats.pagesDiscovered;
            state.currentUrl = stats.currentUrl || state.currentUrl;
        } catch {
            /* ignore */
        }
    };

    discovery.on("page_discovered", () => {
        updateFromStats();
        process.stderr.write(
            dim(
                `   … discover ${state.pages}/${maxPages}${state.currentUrl ? `  ${state.currentUrl}` : ""}\n`,
            ),
        );
    });

    discovery.on("auth_blocked", (event: DiscoveryEvent) => {
        state.status = "paused";
        const blocker = (event.data as { blocker?: { url?: string } })?.blocker;
        process.stderr.write(
            chalk.yellow(
                `\n  ⏸ Discovery paused (auth)` +
                    dim(`  ${blocker?.url ?? ""}\n`) +
                    dim(
                        "     Run `raiken auth`, then `/discover --continue` or `raiken discover --continue`.\n",
                    ),
            ),
        );
    });

    discovery.on("blocker_detected", (event: DiscoveryEvent) => {
        const blocker = (
            event.data as { blocker?: { category?: string; severity?: string; url?: string } }
        )?.blocker;
        if (blocker?.category === "auth_required") return;
        if (blocker?.severity && blocker.severity !== "pause") return;
        state.status = "paused";
        process.stderr.write(
            chalk.yellow(
                `\n  ⏸ Discovery paused (${blocker?.category ?? "blocker"})` +
                    dim(`  ${blocker?.url ?? ""}\n`),
            ),
        );
    });

    discovery.on("session_completed", () => {
        updateFromStats();
        state.status = "completed";
        process.stderr.write(
            chalk.green(
                `\n  ✓ Discovery complete${dim(`  ·  ${state.pages} pages  ·  ${params.url}\n`)}`,
            ),
        );
    });

    discovery.on("error", (event: DiscoveryEvent) => {
        state.status = "failed";
        const err = (event.data as { error?: Error })?.error;
        state.error = err?.message ?? "unknown error";
        process.stderr.write(chalk.red(`\n  ✗ Discovery failed: ${state.error}\n`));
    });

    const done = (async () => {
        try {
            await discovery.start();
            if (state.status === "running") {
                updateFromStats();
                state.status = "completed";
            }
        } catch (err) {
            if (state.status === "running") {
                state.status = "failed";
                state.error = err instanceof Error ? err.message : String(err);
                process.stderr.write(chalk.red(`\n  ✗ Discovery failed: ${state.error}\n`));
            }
        } finally {
            try {
                await discovery.close();
            } catch {
                /* ignore */
            }
            setTimeout(() => {
                if (active?.discovery === discovery && active.state.status !== "running") {
                    active = null;
                }
            }, 30_000).unref();
        }
    })();

    active = { discovery, state, done };

    console.log(accent("\n  Discovery started in background") + dim(`  ·  ${params.url}`));
    console.log(dim("  Keep chatting — progress prints below. Status also shows in the strip.\n"));
}

/** Resume a paused session in the background. */
export async function continueBackgroundDiscover(projectPath: string): Promise<void> {
    if (active && active.state.status === "running") {
        throw new Error("Discovery is already running.");
    }

    const config = loadDiscoveryConfig(projectPath);
    const storageStatePath = resolveAuthStorageStatePath(projectPath);
    const { SiteDiscovery } = await import("@raiken/core");
    const discovery = new SiteDiscovery({
        startUrl: "",
        projectPath,
        continueSession: true,
        pauseOnAuth: config.pauseOnAuth,
        maxConcurrency: config.maxConcurrency,
        timeout: config.timeout,
        excludePatterns: config.excludePatterns,
        storageStatePath,
        maxRunTimeMs: config.maxRunTimeMs,
    });

    const state: Exclude<BackgroundDiscoverState, { status: "idle" }> = {
        status: "running",
        startUrl: "(resume)",
        pages: 0,
        maxPages: config.maxPages,
        startedAt: Date.now(),
    };

    discovery.on("session_completed", () => {
        state.status = "completed";
        process.stderr.write(chalk.green("\n  ✓ Discovery resume complete\n"));
    });
    discovery.on("error", (event: DiscoveryEvent) => {
        state.status = "failed";
        state.error = (event.data as { error?: Error })?.error?.message ?? "error";
        process.stderr.write(chalk.red(`\n  ✗ Discovery failed: ${state.error}\n`));
    });

    const done = (async () => {
        try {
            await discovery.start();
            if (state.status === "running") state.status = "completed";
        } catch (err) {
            state.status = "failed";
            state.error = err instanceof Error ? err.message : String(err);
        } finally {
            try {
                await discovery.close();
            } catch {
                /* ignore */
            }
            setTimeout(() => {
                if (active?.discovery === discovery) active = null;
            }, 30_000).unref();
        }
    })();

    active = { discovery, state, done };
    console.log(accent("\n  Resuming discovery in background\n"));
}

/** Format a compact status chip for the status strip. */
export function formatDiscoverChip(state: BackgroundDiscoverState): string | null {
    if (state.status === "idle") return null;
    if (state.status === "running") {
        return `discover ${state.pages}/${state.maxPages}`;
    }
    if (state.status === "paused") return "discover paused";
    if (state.status === "completed") return `discovered ${state.pages}`;
    if (state.status === "failed") return "discover failed";
    return null;
}

/** Test helper — clear singleton state between unit tests. */
export function __resetBackgroundDiscoverForTests(): void {
    active = null;
}
