/**
 * Discover Command
 *
 * Autonomously discover web application structure by crawling pages.
 */

import chalk from "chalk";
import ora from "ora";
import { SiteDiscovery } from "@raiken/core";
import type { DiscoveryStats } from "@raiken/core";

interface DiscoverOptions {
    maxPages?: string;
    maxDepth?: string;
    auth?: boolean;
    skipAuth?: boolean;
    continue?: boolean;
    status?: boolean;
}

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
    const maxPages = parseInt(options.maxPages || "100", 10);
    const maxDepth = parseInt(options.maxDepth || "5", 10);
    const pauseOnAuth = !options.skipAuth;

    console.log(chalk.cyan("\n🔍 Starting site discovery...\n"));
    console.log(chalk.dim(`  URL:       ${url}`));
    console.log(chalk.dim(`  Max pages: ${maxPages}`));
    console.log(chalk.dim(`  Max depth: ${maxDepth}`));
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
        pauseOnAuth,
    });

    let lastStats: DiscoveryStats | null = null;

    // Update spinner with progress
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

    // Listen for events
    discovery.on("page_discovered", () => {
        updateSpinner();
    });

    discovery.on("auth_blocked", (event: any) => {
        clearInterval(progressInterval);
        spinner.stop();

        const blocker = event.data.blocker;
        console.log(chalk.yellow("\n🛑 Authentication required"));
        console.log(chalk.dim(`   URL: ${blocker.url}`));
        console.log(
            chalk.dim(`   Type: ${blocker.blockerType.replace("_", " ")}`)
        );
        console.log();

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

        console.log(
            chalk.dim(
                "Discovery paused. Resume with 'raiken discover --continue'."
            )
        );
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
    });

    discovery.on("error", (event: any) => {
        clearInterval(progressInterval);
        spinner.fail(chalk.red("Discovery failed"));
        throw event.data.error;
    });

    // Start discovery
    try {
        await discovery.start();
    } catch (error) {
        clearInterval(progressInterval);
        throw error;
    } finally {
        await discovery.close();
    }
}

async function continueDiscovery(
    projectPath: string,
    options: DiscoverOptions
): Promise<void> {
    console.log(chalk.cyan("\n▶️  Resuming discovery...\n"));

    const discovery = new SiteDiscovery({
        startUrl: "", // Will be loaded from session
        projectPath,
        continueSession: true,
        pauseOnAuth: !options.skipAuth,
    });

    const spinner = ora({
        text: "Loading session...",
        spinner: "dots",
    }).start();

    let lastStats: DiscoveryStats | null = null;

    const updateSpinner = () => {
        const stats = discovery.getStats();
        lastStats = stats;
        const maxPages = 100; // TODO: Load from session
        const maxDepth = 5; // TODO: Load from session
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

    // Listen for events (same as startDiscovery)
    discovery.on("page_discovered", updateSpinner);

    discovery.on("auth_blocked", (event: any) => {
        clearInterval(progressInterval);
        spinner.stop();

        const blocker = event.data.blocker;
        console.log(chalk.yellow("\n🛑 Authentication required again"));
        console.log(chalk.dim(`   URL: ${blocker.url}`));
        console.log(
            chalk.dim(`   Type: ${blocker.blockerType.replace("_", " ")}`)
        );
        console.log();

        console.log(
            chalk.dim("Run 'raiken auth' to update authentication state.")
        );
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
                    `   Time elapsed:     ${Math.round(lastStats.elapsedMs / 1000)}s`
                )
            );
        }
    });

    discovery.on("error", (event: any) => {
        clearInterval(progressInterval);
        spinner.fail(chalk.red("Discovery failed"));
        throw event.data.error;
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
    const { CodeGraphDB } = await import("@raiken/core");
    const { SiteKnowledgeDB } = await import("@raiken/core");

    const db = new CodeGraphDB(projectPath);
    const siteDb = new SiteKnowledgeDB((db as any).db, projectPath);

    const session = siteDb.getLatestSession();
    const stats = siteDb.getStats();

    console.log(chalk.cyan("\n📊 Discovery Status\n"));

    if (!session) {
        console.log(chalk.dim("   No discovery sessions found."));
        console.log(chalk.dim("   Run 'raiken discover <url>' to start."));
        console.log();
        db.close();
        return;
    }

    console.log(chalk.white("Last Session:"));
    console.log(chalk.dim(`  Status:   ${session.status}`));
    console.log(chalk.dim(`  Started:  ${new Date(session.startedAt).toLocaleString()}`));
    if (session.completedAt) {
        console.log(
            chalk.dim(
                `  Completed: ${new Date(session.completedAt).toLocaleString()}`
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

    db.close();
}
