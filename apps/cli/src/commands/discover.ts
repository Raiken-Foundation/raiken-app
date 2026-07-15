/**
 * Discover Command
 *
 * Autonomously discover web application structure by crawling pages.
 */

import type {
    DiscoveryBlocker,
    DiscoveryEvent,
    DiscoverySession,
    DiscoveryStats,
    SiteDiscovery,
} from "@raiken/core";
import { loadDiscoveryConfig, resolveAuthStorageStatePath } from "@raiken/shared";
import chalk from "chalk";
import ora from "ora";
import { cliExit } from "../repl/exit";

interface DiscoverOptions {
    maxPages?: string;
    maxDepth?: string;
    timeout?: string;
    auth?: boolean;
    skipAuth?: boolean;
    continue?: boolean;
    status?: boolean;
}

const parseNumber = (value: string | number | undefined, fallback: number): number => {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Resolve context needed to decide whether a `--continue` resume should
 * purge Crawlee's persistent queue and restart from `startUrl` instead of
 * blindly draining the stale pre-auth queue (see `purgeQueueOnResume`
 * usage below). Bundles the session + blocker lookups into one DB
 * connection since both are always needed together here.
 */
export const getResumeContext = async (
    projectPath: string,
): Promise<{ session: DiscoverySession | null; pendingAuthBlockers: DiscoveryBlocker[] }> => {
    const { CodeGraphDB, SiteKnowledgeDB } = await import("@raiken/core");
    const db = new CodeGraphDB(projectPath);
    try {
        const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
        const session = siteDb.getActiveSession();
        const pendingAuthBlockers = siteDb
            .getUnresolvedBlockers()
            .filter((b) => b.category === "auth_required");
        return { session, pendingAuthBlockers };
    } finally {
        db.close();
    }
};

/**
 * Mark the given auth blockers resolved via fresh storage state. Opens its
 * own short-lived DB connection (mirrors the pattern used throughout this
 * file rather than threading a shared handle through).
 */
export const resolveAuthBlockersWithState = async (
    projectPath: string,
    blockers: DiscoveryBlocker[],
    storageStatePath: string,
): Promise<void> => {
    if (blockers.length === 0) return;
    const { CodeGraphDB, SiteKnowledgeDB } = await import("@raiken/core");
    const db = new CodeGraphDB(projectPath);
    try {
        const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
        for (const blocker of blockers) {
            if (blocker.id) {
                siteDb.markBlockerResolved(blocker.id, {
                    resolution: "provide_state",
                    resolvedVia: "cli_continue",
                    storageStatePath,
                });
            }
        }
    } finally {
        db.close();
    }
};

const attachDiscoveryListeners = (params: {
    discovery: SiteDiscovery;
    spinner: ReturnType<typeof ora>;
    maxPages: number;
    maxDepth: number;
    showAuthOptions: boolean;
    authHeader: string;
    authHint: string;
    onCompleted?: (stats: DiscoveryStats | null) => void;
}) => {
    const {
        discovery,
        spinner,
        maxPages,
        maxDepth,
        showAuthOptions,
        authHeader,
        authHint,
        onCompleted,
    } = params;

    let lastStats: DiscoveryStats | null = null;

    const updateSpinner = () => {
        const stats = discovery.getStats();
        lastStats = stats;
        const elapsed = Math.round(stats.elapsedMs / 1000);
        spinner.text = chalk.dim(
            `Pages: ${stats.pagesDiscovered}/${maxPages} | ` +
                `Links: ${stats.linksFound} | ` +
                `Depth: ${stats.currentDepth}/${maxDepth} | ` +
                `Elapsed: ${elapsed}s\n` +
                `  ${stats.currentUrl || "..."}`,
        );
    };

    const progressInterval = setInterval(updateSpinner, 500);

    discovery.on("page_discovered", updateSpinner);

    discovery.on("auth_blocked", (event: DiscoveryEvent) => {
        clearInterval(progressInterval);
        spinner.stop();

        const blocker = (
            event.data as {
                blocker: { url: string; category?: string; blockerType?: string };
            }
        ).blocker;
        const label = blocker.blockerType ?? blocker.category ?? "auth_required";
        console.log(chalk.yellow(`\n${authHeader}`));
        console.log(chalk.dim(`   URL: ${blocker.url}`));
        console.log(chalk.dim(`   Type: ${label.replace(/_/g, " ")}`));
        console.log();

        if (showAuthOptions) {
            console.log(chalk.cyan("Options:"));
            console.log(
                chalk.white("  1."),
                chalk.dim("Run"),
                chalk.white("raiken auth"),
                chalk.dim("to log in"),
            );
            console.log(
                chalk.white("  2."),
                chalk.dim("Run"),
                chalk.white("raiken discover --skip-auth"),
                chalk.dim("to skip protected routes"),
            );
            console.log(chalk.white("  3."), chalk.dim("Press Ctrl+C to cancel"));
            console.log();
        }

        console.log(chalk.dim(authHint));
    });

    // Non-auth blockers (captcha, error_page, manual) also pause discovery
    // but never fire `auth_blocked`. Pre-fix the spinner just hung silently
    // until the user Ctrl-C'd, with no indication of what happened. We
    // listen on the generic `blocker_detected` event and skip the
    // auth_required case (already handled above) so the messages don't
    // double-print.
    discovery.on("blocker_detected", (event: DiscoveryEvent) => {
        const blocker = (
            event.data as {
                blocker: {
                    url: string;
                    category?: string;
                    severity?: string;
                    detectorId?: string | null;
                    evidenceJson?: string | null;
                };
            }
        ).blocker;

        if (blocker.category === "auth_required") return;
        // Only pause-severity blockers stop the crawl. Skip/log-only
        // blockers shouldn't interrupt the spinner because the crawl
        // keeps going.
        if (blocker.severity && blocker.severity !== "pause") return;

        clearInterval(progressInterval);
        spinner.stop();

        const category = blocker.category ?? "unknown";
        const detector = blocker.detectorId ?? `${category}:detected`;
        const headers: Record<string, string> = {
            captcha: "Captcha challenge detected",
            error_page: "Error page returned",
            manual: "Manually paused",
            rate_limit: "Rate limit hit",
            anti_bot: "Anti-bot challenge detected",
        };
        const header = headers[category] ?? `Discovery paused (${category})`;

        console.log(chalk.yellow(`\n${header}`));
        console.log(chalk.dim(`   URL:      ${blocker.url}`));
        console.log(chalk.dim(`   Detector: ${detector}`));
        console.log();

        // Category-specific guidance. Each branch tells the user the
        // shortest path to unblock — running `raiken auth` won't help
        // here (that's H2 territory), so we surface the right tool.
        if (category === "captcha" || category === "anti_bot") {
            console.log(chalk.cyan("Next steps:"));
            console.log(
                chalk.white("  1."),
                chalk.dim(
                    "Open the dashboard and request a browser handoff to solve the challenge",
                ),
            );
            console.log(
                chalk.white("  2."),
                chalk.dim("Or skip this blocker and continue with"),
                chalk.white("raiken discover --continue"),
            );
            console.log();
        } else if (category === "error_page" || category === "rate_limit") {
            console.log(chalk.cyan("Next steps:"));
            console.log(
                chalk.white("  1."),
                chalk.dim("Verify the target server is reachable and not throttling requests"),
            );
            console.log(
                chalk.white("  2."),
                chalk.dim("Resume with"),
                chalk.white("raiken discover --continue"),
                chalk.dim("once resolved"),
            );
            console.log();
        }

        console.log(chalk.dim("Discovery paused. Resume with 'raiken discover --continue'."));
    });

    discovery.on("session_completed", () => {
        clearInterval(progressInterval);
        spinner.succeed(chalk.green("Discovery completed!"));

        if (lastStats) {
            console.log();
            console.log(chalk.cyan("Summary:"));
            console.log(chalk.dim(`   Pages discovered: ${lastStats.pagesDiscovered}`));
            console.log(chalk.dim(`   Links found:      ${lastStats.linksFound}`));
            console.log(chalk.dim(`   Auth blockers:    ${lastStats.authBlockersFound}`));
            console.log(
                chalk.dim(`   Time elapsed:     ${Math.round(lastStats.elapsedMs / 1000)}s`),
            );
            console.log();
            console.log(chalk.dim("Site knowledge saved to .raiken/raiken.db"));
        }

        onCompleted?.(lastStats);
    });

    discovery.on("error", () => {
        clearInterval(progressInterval);
        spinner.fail(chalk.red("Discovery failed"));
        // `discovery.start()` rejects with this same formatted error. Never
        // throw from EventEmitter listeners: doing so recursively re-enters
        // the crawler catch path and collapses useful causes into a generic
        // AggregateError ("Received one or more errors").
    });

    return { updateSpinner, progressInterval };
};

export async function discoverCommand(
    url: string | undefined,
    options: DiscoverOptions,
): Promise<void> {
    const projectPath = process.cwd();

    try {
        // Handle --status flag
        if (options.status) {
            await showDiscoveryStatus(projectPath);
            return;
        }

        // Handle --continue flag
        if (options.continue) {
            await continueDiscovery(projectPath, options);
            return;
        }

        // Start new discovery
        if (!url) {
            console.error(chalk.red("Error: URL is required for new discovery"));
            console.log(chalk.dim("Usage: raiken discover <url> [options]"));
            cliExit(1);
        }

        await startDiscovery(url, projectPath, options);
    } catch (error) {
        console.error(chalk.red("\n✗ Discovery failed:"), (error as Error).message);
        cliExit(1);
    }
}

async function startDiscovery(
    url: string,
    projectPath: string,
    options: DiscoverOptions,
): Promise<void> {
    const config = loadDiscoveryConfig(projectPath);
    const maxPages = parseNumber(options.maxPages, config.maxPages);
    const maxDepth = parseNumber(options.maxDepth, config.maxDepth);
    const timeout = parseNumber(options.timeout, config.timeout);
    const maxConcurrency = config.maxConcurrency;
    const excludePatterns = config.excludePatterns;
    const pauseOnAuth = options.skipAuth ? false : config.pauseOnAuth;

    if (options.auth) {
        const { authCommand } = await import("./auth");
        await authCommand({ url });
    }

    console.log(chalk.cyan("\nStarting site discovery...\n"));
    console.log(chalk.dim(`  URL:       ${url}`));
    console.log(chalk.dim(`  Max pages: ${maxPages}`));
    console.log(chalk.dim(`  Max depth: ${maxDepth}`));
    console.log(chalk.dim(`  Timeout:   ${timeout}ms`));
    console.log(chalk.dim(`  Auth mode: ${pauseOnAuth ? "pause" : "skip"}\n`));

    const spinner = ora({
        text: "Initializing crawler...",
        spinner: "dots",
    }).start();

    const storageStatePath = resolveAuthStorageStatePath(projectPath);
    if (storageStatePath) {
        console.log(chalk.dim(`  Auth:      ${storageStatePath}\n`));
    }

    const { SiteDiscovery } = await import("@raiken/core");
    const discovery = new SiteDiscovery({
        startUrl: url,
        projectPath,
        maxPages,
        maxDepth,
        maxConcurrency,
        timeout,
        excludePatterns,
        pauseOnAuth,
        storageStatePath,
        maxRunTimeMs: config.maxRunTimeMs,
    });

    const { progressInterval } = attachDiscoveryListeners({
        discovery,
        spinner,
        maxPages,
        maxDepth,
        showAuthOptions: true,
        authHeader: "Authentication required",
        authHint: "Discovery paused. Resume with 'raiken discover --continue'.",
    });

    // Start discovery
    try {
        await discovery.start();
    } catch (error) {
        clearInterval(progressInterval);
        // Make sure the spinner doesn't stay frozen on its last "Initializing
        // crawler..." text when the run throws before any listener fires.
        if (spinner.isSpinning) spinner.fail(chalk.red("Discovery failed"));
        throw error;
    } finally {
        clearInterval(progressInterval);
        // The session_completed listener calls .succeed(); the catch above
        // calls .fail(). This is the safety net for the rare path where
        // neither fires (e.g. a blocker_detected listener stopped the
        // spinner but discovery.start() then resolved cleanly).
        if (spinner.isSpinning) spinner.stop();
        await discovery.close();
    }
}

async function continueDiscovery(projectPath: string, options: DiscoverOptions): Promise<void> {
    console.log(chalk.cyan("\nResuming discovery...\n"));

    const config = loadDiscoveryConfig(projectPath);
    const { session, pendingAuthBlockers } = await getResumeContext(projectPath);
    const maxPages = session?.maxPages ?? parseNumber(options.maxPages, config.maxPages);
    const maxDepth = session?.maxDepth ?? parseNumber(options.maxDepth, config.maxDepth);
    const timeout = parseNumber(options.timeout, config.timeout);
    const maxConcurrency = config.maxConcurrency;
    const excludePatterns = config.excludePatterns;

    const storageStatePath = resolveAuthStorageStatePath(projectPath);

    // Mirror the dashboard's `provide_state` / `clear`-with-fresh-state
    // behavior (see `resolveDiscoveryBlocker` in router.ts): if this
    // session paused on an auth wall and storage state now resolves (e.g.
    // the user ran `raiken auth` in between the pause and this
    // `--continue`), the crawler's persisted queue only reflects the
    // *unauthenticated* link graph — resuming it verbatim would replay the
    // login page's links forever and never discover what's actually behind
    // auth. Purge the queue and restart from `startUrl` so the post-login
    // DOM gets crawled fresh, and mark the blocker(s) resolved so status
    // views stop reporting them as pending.
    const purgeQueueOnResume = Boolean(storageStatePath) && pendingAuthBlockers.length > 0;
    if (purgeQueueOnResume && storageStatePath) {
        await resolveAuthBlockersWithState(projectPath, pendingAuthBlockers, storageStatePath);
        console.log(
            chalk.dim(
                `  Fresh auth state found — restarting from ${session?.startUrl ?? "the original start URL"} to re-crawl the authenticated app.\n`,
            ),
        );
    }

    const { SiteDiscovery } = await import("@raiken/core");
    const discovery = new SiteDiscovery({
        startUrl: "",
        projectPath,
        continueSession: true,
        purgeQueueOnResume,
        pauseOnAuth: options.skipAuth ? false : config.pauseOnAuth,
        maxConcurrency,
        timeout,
        excludePatterns,
        storageStatePath,
        maxRunTimeMs: config.maxRunTimeMs,
    });

    const spinner = ora({
        text: "Loading session...",
        spinner: "dots",
    }).start();

    const { progressInterval } = attachDiscoveryListeners({
        discovery,
        spinner,
        maxPages,
        maxDepth,
        showAuthOptions: false,
        authHeader: "Authentication required again",
        authHint: "Run 'raiken auth' to update authentication state.",
    });

    try {
        await discovery.start();
    } catch (error) {
        clearInterval(progressInterval);
        if (spinner.isSpinning) spinner.fail(chalk.red("Discovery failed"));
        throw error;
    } finally {
        clearInterval(progressInterval);
        if (spinner.isSpinning) spinner.stop();
        await discovery.close();
    }
}

async function showDiscoveryStatus(projectPath: string): Promise<void> {
    const { DiscoveryQueryService } = await import("@raiken/core");
    const discovery = new DiscoveryQueryService(projectPath);

    try {
        const session = discovery.getLatestSession();
        const stats = discovery.getStats();

        console.log(chalk.cyan("\nDiscovery Status\n"));

        if (!session) {
            console.log(chalk.dim("   No discovery sessions found."));
            console.log(chalk.dim("   Run 'raiken discover <url>' to start."));
            console.log();
            return;
        }

        const startedAt = Number(session.startedAt);
        const completedAt = session.completedAt ? Number(session.completedAt) : null;

        console.log(chalk.white("Last Session:"));
        console.log(chalk.dim(`  Status:   ${session.status}`));
        if (Number.isFinite(startedAt)) {
            console.log(chalk.dim(`  Started:  ${new Date(startedAt).toLocaleString()}`));
        }
        if (completedAt && Number.isFinite(completedAt)) {
            console.log(chalk.dim(`  Completed: ${new Date(completedAt).toLocaleString()}`));
        }
        if (session.blockedAtUrl) {
            console.log(chalk.dim(`  Blocked:  ${session.blockedAtUrl}`));
        }
        console.log();

        console.log(chalk.white("Statistics:"));
        console.log(chalk.dim(`  Pages discovered:     ${stats.pagesCount}`));
        console.log(chalk.dim(`  Links found:          ${stats.linksCount}`));
        console.log(chalk.dim(`  Verified links:       ${stats.verifiedLinksCount}`));
        console.log(chalk.dim(`  Broken links:         ${stats.brokenLinksCount}`));
        console.log(chalk.dim(`  Auth blockers:        ${stats.authBlockersCount}`));
        console.log(chalk.dim(`  Unresolved blockers:  ${stats.unresolvedBlockersCount}`));
        console.log();

        if (session.status === "paused") {
            console.log(
                chalk.yellow("Session is paused. Resume with 'raiken discover --continue'."),
            );
        }
    } finally {
        discovery.close();
    }
}
