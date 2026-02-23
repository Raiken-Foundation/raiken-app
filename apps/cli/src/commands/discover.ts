/**
 * Discover Command
 *
 * Autonomously discover web application structure by crawling pages.
 */

import chalk from "chalk";
import ora from "ora";
import { SiteDiscovery } from "@raiken/core";
import type { DiscoveryStats, DiscoverySession, DiscoveryEvent } from "@raiken/core";
import { loadDiscoveryConfig } from "@raiken/shared";

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

const getActiveDiscoverySession = async (
    projectPath: string
): Promise<DiscoverySession | null> => {
    const { CodeGraphDB, SiteKnowledgeDB } = await import("@raiken/core");
    const db = new CodeGraphDB(projectPath);
    const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
    const session = siteDb.getActiveSession();
    db.close();
    return session;
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
                `  ${stats.currentUrl || "..."}`
        );
    };

    const progressInterval = setInterval(updateSpinner, 500);

    discovery.on("page_discovered", updateSpinner);

    discovery.on("auth_blocked", (event: DiscoveryEvent) => {
        clearInterval(progressInterval);
        spinner.stop();

        const blocker = (event.data as { blocker: { url: string; blockerType: string } }).blocker;
        console.log(chalk.yellow(`\n🛑 ${authHeader}`));
        console.log(chalk.dim(`   URL: ${blocker.url}`));
        console.log(
            chalk.dim(`   Type: ${blocker.blockerType.replace("_", " ")}`)
        );
        console.log();

        if (showAuthOptions) {
            console.log(chalk.cyan("Options:"));
            console.log(
                chalk.white("  1."),
                chalk.dim("Run"),
                chalk.white("raiken auth"),
                chalk.dim("to log in")
            );
            console.log(
                chalk.white("  2."),
                chalk.dim("Run"),
                chalk.white("raiken discover --skip-auth"),
                chalk.dim("to skip protected routes")
            );
            console.log(
                chalk.white("  3."),
                chalk.dim("Press Ctrl+C to cancel")
            );
            console.log();
        }

        console.log(chalk.dim(authHint));
    });

    discovery.on("session_completed", () => {
        clearInterval(progressInterval);
        spinner.succeed(chalk.green("Discovery completed!"));

        if (lastStats) {
            console.log();
            console.log(chalk.cyan("📊 Summary:"));
            console.log(
                chalk.dim(`   Pages discovered: ${lastStats.pagesDiscovered}`)
            );
            console.log(chalk.dim(`   Links found:      ${lastStats.linksFound}`));
            console.log(
                chalk.dim(
                    `   Auth blockers:    ${lastStats.authBlockersFound}`
                )
            );
            console.log(
                chalk.dim(
                    `   Time elapsed:     ${Math.round(lastStats.elapsedMs / 1000)}s`
                )
            );
            console.log();
            console.log(
                chalk.dim("✨ Site knowledge saved to .raiken/raiken.db")
            );
        }

        onCompleted?.(lastStats);
    });

    discovery.on("error", (event: DiscoveryEvent) => {
        clearInterval(progressInterval);
        spinner.fail(chalk.red("Discovery failed"));
        throw (event.data as { error: Error }).error;
    });

    return { updateSpinner, progressInterval };
};

export async function discoverCommand(
    url: string | undefined,
    options: DiscoverOptions
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
            console.error(
                chalk.red("❌ Error: URL is required for new discovery")
            );
            console.log(
                chalk.dim("Usage: raiken discover <url> [options]")
            );
            process.exit(1);
        }

        await startDiscovery(url, projectPath, options);
    } catch (error) {
        console.error(
            chalk.red("\n❌ Discovery failed:"),
            (error as Error).message
        );
        process.exit(1);
    }
}

async function startDiscovery(
    url: string,
    projectPath: string,
    options: DiscoverOptions
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

    console.log(chalk.cyan("\n🔍 Starting site discovery...\n"));
    console.log(chalk.dim(`  URL:       ${url}`));
    console.log(chalk.dim(`  Max pages: ${maxPages}`));
    console.log(chalk.dim(`  Max depth: ${maxDepth}`));
    console.log(chalk.dim(`  Timeout:   ${timeout}ms`));
    console.log(chalk.dim(`  Auth mode: ${pauseOnAuth ? "pause" : "skip"}\n`));

    const spinner = ora({
        text: "Initializing crawler...",
        spinner: "dots",
    }).start();

    const discovery = new SiteDiscovery({
        startUrl: url,
        projectPath,
        maxPages,
        maxDepth,
        maxConcurrency,
        timeout,
        excludePatterns,
        pauseOnAuth,
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
        throw error;
    } finally {
        clearInterval(progressInterval);
        await discovery.close();
    }
}

async function continueDiscovery(
    projectPath: string,
    options: DiscoverOptions
): Promise<void> {
    console.log(chalk.cyan("\n▶️  Resuming discovery...\n"));

    const config = loadDiscoveryConfig(projectPath);
    const session = await getActiveDiscoverySession(projectPath);
    const maxPages = session?.maxPages ?? parseNumber(options.maxPages, config.maxPages);
    const maxDepth = session?.maxDepth ?? parseNumber(options.maxDepth, config.maxDepth);
    const timeout = parseNumber(options.timeout, config.timeout);
    const maxConcurrency = config.maxConcurrency;
    const excludePatterns = config.excludePatterns;

    const discovery = new SiteDiscovery({
        startUrl: "",
        projectPath,
        continueSession: true,
        pauseOnAuth: options.skipAuth ? false : config.pauseOnAuth,
        maxConcurrency,
        timeout,
        excludePatterns,
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
        throw error;
    } finally {
        await discovery.close();
    }
}

async function showDiscoveryStatus(projectPath: string): Promise<void> {
    const { DiscoveryQueryService } = await import("@raiken/core");
    const discovery = new DiscoveryQueryService(projectPath);

    try {
        const session = discovery.getLatestSession();
        const stats = discovery.getStats();

        console.log(chalk.cyan("\n📊 Discovery Status\n"));

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
            console.log(
                chalk.dim(
                    `  Completed: ${new Date(completedAt).toLocaleString()}`
                )
            );
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
        console.log(
            chalk.dim(`  Unresolved blockers:  ${stats.unresolvedBlockersCount}`)
        );
        console.log();

        if (session.status === "paused") {
            console.log(
                chalk.yellow("⏸️  Session is paused. Resume with 'raiken discover --continue'.")
            );
        }
    } finally {
        discovery.close();
    }
}
