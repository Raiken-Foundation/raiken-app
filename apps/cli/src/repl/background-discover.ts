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
          links: number;
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

/**
 * Most `"warning"` events (per-request failures, off-origin redirects) are
 * dashboard-timeline-only by design — printing every one inline would flood
 * the REPL for a crawl with a handful of broken links. `checkpoint_failed`
 * is the exception: it means resuming this session later may silently lose
 * unvisited pages, which the CLI user directly acts on via `--continue`, so
 * it's worth a one-line interruption.
 */
export function printIfActionable(event: DiscoveryEvent): void {
    const data = event.data as { code?: string; message?: string };
    if (data.code !== "checkpoint_failed" || !data.message) return;
    process.stderr.write(chalk.yellow(`\n  ! ${data.message}\n`));
}

function printDiscoveryFailure(message: string): void {
    const details = message
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `     ${line}`)
        .join("\n");
    process.stderr.write(`${chalk.red("\n  ✗ Discovery failed")}\n${details}\n`);
}

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
    timeout?: number;
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
        timeout: params.timeout ?? config.timeout,
        excludePatterns: config.excludePatterns,
        pauseOnAuth: params.skipAuth ? false : config.pauseOnAuth,
        storageStatePath,
        maxRunTimeMs: config.maxRunTimeMs,
    });

    const state: Exclude<BackgroundDiscoverState, { status: "idle" }> = {
        status: "running",
        startUrl: params.url,
        pages: 0,
        links: 0,
        maxPages,
        startedAt: Date.now(),
    };

    const updateFromStats = () => {
        try {
            const stats: DiscoveryStats = discovery.getStats();
            state.pages = stats.pagesDiscovered;
            state.links = stats.linksFound;
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

    discovery.on("session_paused", (event: DiscoveryEvent) => {
        // `blocker_detected`/`auth_blocked` already move state to "paused"
        // with their own message. This is the fallback for pauses that
        // don't stem from a blocker — currently only the wall-clock cap —
        // so a capped crawl reports itself as "paused", not silently as
        // "completed" once `start()` resolves below.
        if (state.status === "paused") return;
        updateFromStats();
        state.status = "paused";
        const reason = (event.data as { reason?: string })?.reason;
        const label = reason === "wall_clock_cap" ? "paused (time limit reached)" : "paused";
        process.stderr.write(
            chalk.yellow(
                `\n  ⏸ Discovery ${label}` +
                    dim(
                        `  ·  ${state.pages} pages  ·  ${state.links} links\n` +
                            "     Run `/discover --continue` to keep going.\n",
                    ),
            ),
        );
    });

    discovery.on("session_completed", () => {
        updateFromStats();
        state.status = "completed";
        process.stderr.write(
            chalk.green(
                `\n  ✓ Discovery complete${dim(
                    `  ·  ${state.pages} pages  ·  ${state.links} links  ·  ${params.url}\n`,
                )}`,
            ),
        );
    });

    discovery.on("error", (event: DiscoveryEvent) => {
        state.status = "failed";
        const err = (event.data as { error?: Error })?.error;
        state.error = err?.message ?? "unknown error";
        printDiscoveryFailure(state.error);
    });

    discovery.on("warning", (event: DiscoveryEvent) => {
        printIfActionable(event);
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
                printDiscoveryFailure(state.error);
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
export async function continueBackgroundDiscover(
    projectPath: string,
    options: { skipAuth?: boolean } = {},
): Promise<void> {
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
        pauseOnAuth: options.skipAuth ? false : config.pauseOnAuth,
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
        links: 0,
        maxPages: config.maxPages,
        startedAt: Date.now(),
    };

    const updateResumeStats = () => {
        const stats = discovery.getStats();
        state.pages = stats.pagesDiscovered;
        state.links = stats.linksFound;
        state.currentUrl = stats.currentUrl || state.currentUrl;
    };
    discovery.on("page_discovered", updateResumeStats);
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
    discovery.on("session_paused", (event: DiscoveryEvent) => {
        if (state.status === "paused") return;
        updateResumeStats();
        state.status = "paused";
        const reason = (event.data as { reason?: string })?.reason;
        const label = reason === "wall_clock_cap" ? "paused (time limit reached)" : "paused";
        process.stderr.write(
            chalk.yellow(
                `\n  ⏸ Discovery ${label}` +
                    dim(
                        `  ·  ${state.pages} pages  ·  ${state.links} links\n` +
                            "     Run `/discover --continue` to keep going.\n",
                    ),
            ),
        );
    });
    discovery.on("session_completed", () => {
        updateResumeStats();
        state.status = "completed";
        process.stderr.write(
            chalk.green(
                `\n  ✓ Discovery resume complete${dim(
                    `  ·  ${state.pages} pages  ·  ${state.links} links\n`,
                )}`,
            ),
        );
    });
    discovery.on("error", (event: DiscoveryEvent) => {
        state.status = "failed";
        state.error = (event.data as { error?: Error })?.error?.message ?? "error";
        printDiscoveryFailure(state.error);
    });
    discovery.on("warning", (event: DiscoveryEvent) => {
        printIfActionable(event);
    });

    const done = (async () => {
        try {
            await discovery.start();
            if (state.status === "running") {
                updateResumeStats();
                state.status = "completed";
            }
        } catch (err) {
            if (state.status !== "failed") {
                state.status = "failed";
                state.error = err instanceof Error ? err.message : String(err);
                printDiscoveryFailure(state.error);
            }
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
        return `discover ${state.pages}/${state.maxPages} · ${state.links} links`;
    }
    if (state.status === "paused") return "discover paused";
    if (state.status === "completed") return `discovered ${state.pages} · ${state.links} links`;
    if (state.status === "failed") return "discover failed";
    return null;
}

/** Test helper — clear singleton state between unit tests. */
export function __resetBackgroundDiscoverForTests(): void {
    active = null;
}
