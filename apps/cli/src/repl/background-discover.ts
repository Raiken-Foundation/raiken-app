/**
 * Background site discovery for the interactive REPL.
 *
 * Starts a crawl without blocking the prompt loop. Progress is written to
 * stderr; the status strip can poll `getBackgroundDiscoverStatus()`.
 */

import type { DiscoveryEvent, DiscoveryUxCallbacks } from "@raiken/core";
import {
    type BackgroundDiscoverState,
    getProjectApplication,
    __resetBackgroundDiscoverForTests as resetCoreBackground,
} from "@raiken/core";
import chalk from "chalk";
import { accent, dim } from "../agent-stream";

export type { BackgroundDiscoverState };

/**
 * Most `"warning"` events (per-request failures, off-origin redirects) are
 * dashboard-timeline-only by design — printing every one inline would flood
 * the REPL for a crawl with a handful of broken links. `checkpoint_failed`
 * is the exception.
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

function replUx(maxPages: number, startUrl: string): DiscoveryUxCallbacks {
    return {
        onPageDiscovered: (_event) => {
            const app = getProjectApplication(process.cwd());
            const state = app.discovery.getBackgroundStatus();
            if (state.status === "idle") return;
            process.stderr.write(
                dim(
                    `   … discover ${state.pages}/${maxPages}${state.currentUrl ? `  ${state.currentUrl}` : ""}\n`,
                ),
            );
        },
        onAuthBlocked: (event) => {
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
        },
        onBlockerDetected: (event) => {
            const blocker = (
                event.data as { blocker?: { category?: string; severity?: string; url?: string } }
            )?.blocker;
            if (blocker?.category === "auth_required") return;
            if (blocker?.severity && blocker.severity !== "pause") return;
            process.stderr.write(
                chalk.yellow(
                    `\n  ⏸ Discovery paused (${blocker?.category ?? "blocker"})` +
                        dim(`  ${blocker?.url ?? ""}\n`),
                ),
            );
        },
        onSessionPaused: (event) => {
            const app = getProjectApplication(process.cwd());
            const state = app.discovery.getBackgroundStatus();
            if (state.status === "paused") {
                const reason = (event.data as { reason?: string })?.reason;
                const label =
                    reason === "wall_clock_cap" ? "paused (time limit reached)" : "paused";
                process.stderr.write(
                    chalk.yellow(
                        `\n  ⏸ Discovery ${label}` +
                            dim(
                                `  ·  ${state.pages} pages  ·  ${state.links} links\n` +
                                    "     Run `/discover --continue` to keep going.\n",
                            ),
                    ),
                );
            }
        },
        onSessionCompleted: () => {
            const app = getProjectApplication(process.cwd());
            const state = app.discovery.getBackgroundStatus();
            if (state.status === "idle") return;
            process.stderr.write(
                chalk.green(
                    `\n  ✓ Discovery complete${dim(
                        `  ·  ${state.pages} pages  ·  ${state.links} links  ·  ${startUrl}\n`,
                    )}`,
                ),
            );
        },
        onError: (event) => {
            const err = (event.data as { error?: Error })?.error;
            printDiscoveryFailure(err?.message ?? "unknown error");
        },
        onWarning: printIfActionable,
    };
}

export function getBackgroundDiscoverStatus(): BackgroundDiscoverState {
    return getProjectApplication(process.cwd()).discovery.getBackgroundStatus();
}

export function isDiscoverRunning(): boolean {
    return getProjectApplication(process.cwd()).discovery.isBackgroundRunning();
}

export async function startBackgroundDiscover(params: {
    url: string;
    projectPath: string;
    maxPages?: number;
    maxDepth?: number;
    timeout?: number;
    skipAuth?: boolean;
}): Promise<void> {
    const app = getProjectApplication(params.projectPath);
    const resolved = await app.discovery.startBackground(
        {
            url: params.url,
            overrides: {
                maxPages: params.maxPages,
                maxDepth: params.maxDepth,
                timeout: params.timeout,
                skipAuth: params.skipAuth,
            },
        },
        replUx(params.maxPages ?? 100, params.url),
    );
    void resolved.done.catch(() => {
        /* errors surfaced via onError */
    });
    console.log(accent("\n  Discovery started in background") + dim(`  ·  ${params.url}`));
    console.log(dim("  Keep chatting — progress prints below. Status also shows in the strip.\n"));
}

export async function continueBackgroundDiscover(
    projectPath: string,
    options: { skipAuth?: boolean } = {},
): Promise<void> {
    const app = getProjectApplication(projectPath);
    const resolved = await app.discovery.continueBackground(options, replUx(100, "(resume)"));
    void resolved.done.catch(() => {
        /* errors surfaced via onError */
    });
    console.log(accent("\n  Resuming discovery in background\n"));
}

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
    resetCoreBackground();
}
