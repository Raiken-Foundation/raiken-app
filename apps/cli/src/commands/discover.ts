/**
 * Discover Command
 *
 * Autonomously discover web application structure by crawling pages.
 */

import type { DiscoveryEvent, DiscoveryUxCallbacks } from "@raiken/core";
import {
    describeAuthStateProblem,
    getProjectApplication,
    getResumeContext,
    inspectAuthState,
    resolveAuthBlockersWithState,
    resolveSiteDiscoveryOptions,
} from "@raiken/core";
import { resolveAuthStorageStatePath } from "@raiken/shared/server";
import chalk from "chalk";
import ora from "ora";
import { exitUsage, mapErrorToCliExitCode, printCliError } from "../errors";
import { CliExitError, cliExit } from "../repl/exit";

export { getResumeContext, resolveAuthBlockersWithState };

interface DiscoverOptions {
    maxPages?: string;
    maxDepth?: string;
    timeout?: string;
    auth?: boolean;
    skipAuth?: boolean;
    continue?: boolean;
    status?: boolean;
}

export function resolveUsableDiscoveryAuthState(projectPath: string): string | null {
    const resolved = resolveAuthStorageStatePath(projectPath);
    if (!resolved) return null;
    const inspection = inspectAuthState(resolved);
    if (inspection.status === "valid") return resolved;
    console.warn(
        chalk.yellow(describeAuthStateProblem(inspection) ?? "Saved auth state is not usable."),
    );
    return null;
}

export function buildForegroundUx(params: {
    projectPath: string;
    spinner: ReturnType<typeof ora>;
    maxPages: number;
    maxDepth: number;
    /** False in --skip-auth mode: protected routes are skipped, never paused. */
    pauseOnAuth: boolean;
    showAuthOptions: boolean;
    authHeader: string;
    authHint: string;
    /** True when a saved auth storage state was loaded for this run. */
    hadAuthState: boolean;
}): { ux: DiscoveryUxCallbacks; progressInterval: ReturnType<typeof setInterval> } {
    const {
        projectPath,
        spinner,
        maxPages,
        maxDepth,
        pauseOnAuth,
        showAuthOptions,
        authHeader,
        authHint,
        hadAuthState,
    } = params;
    let lastSummary: {
        pagesDiscovered: number;
        linksFound: number;
        authBlockersFound: number;
    } | null = null;

    const updateSpinner = () => {
        const runtime = getProjectApplication(projectPath).discovery.getRuntimeState();
        lastSummary = {
            pagesDiscovered: runtime.pagesDiscovered,
            linksFound: runtime.linksFound,
            authBlockersFound: runtime.authBlockersFound,
        };
        spinner.text = chalk.dim(
            `Pages: ${runtime.pagesDiscovered}/${maxPages} | ` +
                `Links: ${runtime.linksFound} | ` +
                `Depth: ${runtime.currentDepth}/${maxDepth} | ` +
                `  ${runtime.currentUrl || "..."}`,
        );
    };

    const progressInterval = setInterval(updateSpinner, 500);

    const stopSpinner = () => {
        clearInterval(progressInterval);
        spinner.stop();
    };

    const ux: DiscoveryUxCallbacks = {
        onPageDiscovered: () => updateSpinner(),
        onAuthBlocked: (event: DiscoveryEvent) => {
            const blocker = (
                event.data as {
                    blocker: { url: string; category?: string; blockerType?: string };
                }
            ).blocker;
            if (!pauseOnAuth) {
                // Skip mode: the crawl deliberately continues past protected
                // routes — announcing "Authentication required / Discovery
                // paused" here was a lie (nothing paused). One quiet line.
                console.log(chalk.dim(`  Skipping protected route (auth): ${blocker.url}`));
                return;
            }
            stopSpinner();
            const label = blocker.blockerType ?? blocker.category ?? "auth_required";
            console.log(chalk.yellow(`\n${authHeader}`));
            console.log(chalk.dim(`   URL: ${blocker.url}`));
            console.log(chalk.dim(`   Type: ${label.replace(/_/g, " ")}`));
            if (hadAuthState) {
                console.log(
                    chalk.dim(
                        "   A saved session was loaded but the site still asked to log in — it may have expired. Run `raiken auth` to refresh it.",
                    ),
                );
            }
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
        },
        onBlockerDetected: (event: DiscoveryEvent) => {
            const blocker = (
                event.data as {
                    blocker: {
                        url: string;
                        category?: string;
                        severity?: string;
                        detectorId?: string | null;
                    };
                }
            ).blocker;
            if (blocker.category === "auth_required") return;
            if (blocker.severity && blocker.severity !== "pause") return;
            stopSpinner();
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
        },
        onSessionCompleted: () => {
            // lastSummary comes from the 500ms poll and can lag the final
            // events (e.g. an auth blocker recorded right at the end, which
            // made "Auth blockers" print 0 while the kb held 1). Refresh from
            // runtime state — listeners patch counters before this callback
            // fires — and never let a read failure sink a completed run.
            try {
                updateSpinner();
            } catch {
                /* keep the last polled summary */
            }
            stopSpinner();
            spinner.succeed(chalk.green("Discovery completed!"));
            if (lastSummary) {
                console.log();
                console.log(chalk.cyan("Summary:"));
                console.log(chalk.dim(`   Pages discovered: ${lastSummary.pagesDiscovered}`));
                console.log(chalk.dim(`   Links found:      ${lastSummary.linksFound}`));
                console.log(chalk.dim(`   Auth blockers:    ${lastSummary.authBlockersFound}`));
                console.log();
                console.log(chalk.dim("Site knowledge saved to .raiken/raiken.db"));
            }
        },
        onError: () => {
            stopSpinner();
            spinner.fail(chalk.red("Discovery failed"));
        },
    };

    return { ux, progressInterval };
}

/**
 * Numeric limits must fail loudly: commander passes raw strings, and
 * `Number("abc")` silently became NaN limits that then flowed into the
 * crawler config (unlike `start -p`, which validates and exits 2).
 */
function validateNumericOptions(options: DiscoverOptions): void {
    const checks: Array<[string | undefined, string, (n: number) => boolean]> = [
        [options.maxPages, "--max-pages", (n) => n >= 1],
        [options.maxDepth, "--max-depth", (n) => n >= 0],
        [options.timeout, "--timeout", (n) => n >= 1],
    ];
    for (const [raw, flag, valid] of checks) {
        if (raw === undefined) continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || !valid(n)) {
            exitUsage(
                `Invalid ${flag}: "${raw}". Must be a number ${flag === "--max-depth" ? "≥ 0" : "≥ 1"}.`,
            );
        }
    }
}

export async function discoverCommand(
    url: string | undefined,
    options: DiscoverOptions,
): Promise<void> {
    const projectPath = process.cwd();

    try {
        if (options.status) {
            await showDiscoveryStatus(projectPath);
            return;
        }
        validateNumericOptions(options);
        if (options.continue) {
            await continueDiscovery(projectPath, options);
            return;
        }
        if (!url) {
            // A usage error, printed as one — exitUsage gives a clean
            // exit(2) with usage text, not a generic failure label.
            exitUsage(
                "A URL is required to start a new discovery.\nUsage: raiken discover <url> [options]",
            );
        }
        await startDiscovery(url, projectPath, options);
    } catch (error) {
        // Usage exits thrown via cliExit (REPL `withThrowExit`) must pass
        // through — re-mapping them here would mask a clean exit(2) as
        // "An unexpected error occurred."
        if (error instanceof CliExitError) throw error;
        printCliError(error, { label: "Discovery failed" });
        cliExit(mapErrorToCliExitCode(error));
    }
}

async function startDiscovery(
    url: string,
    projectPath: string,
    options: DiscoverOptions,
): Promise<void> {
    const resolved = resolveSiteDiscoveryOptions({
        projectPath,
        startUrl: url,
        overrides: {
            maxPages: options.maxPages,
            maxDepth: options.maxDepth,
            timeout: options.timeout,
            skipAuth: options.skipAuth,
        },
        resolveStorageState: false,
    });
    const { maxPages, maxDepth, timeout, pauseOnAuth } = resolved;

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

    const spinner = ora({ text: "Initializing crawler...", spinner: "dots" }).start();
    const storageStatePath = resolveUsableDiscoveryAuthState(projectPath);
    if (storageStatePath) {
        console.log(chalk.dim(`  Auth:      ${storageStatePath}\n`));
    }

    const { ux, progressInterval } = buildForegroundUx({
        projectPath,
        spinner,
        maxPages,
        maxDepth,
        pauseOnAuth: resolved.pauseOnAuth,
        showAuthOptions: true,
        authHeader: "Authentication required",
        authHint: "Discovery paused. Resume with 'raiken discover --continue'.",
        hadAuthState: Boolean(storageStatePath),
    });

    const app = getProjectApplication(projectPath);
    try {
        await app.discovery.runForeground(
            {
                startUrl: url,
                overrides: {
                    maxPages: options.maxPages,
                    maxDepth: options.maxDepth,
                    timeout: options.timeout,
                    skipAuth: options.skipAuth,
                    storageStatePath,
                },
                resolveStorageState: false,
                storageStatePath,
            },
            ux,
        );
    } catch (error) {
        clearInterval(progressInterval);
        if (spinner.isSpinning) spinner.fail(chalk.red("Discovery failed"));
        throw error;
    } finally {
        clearInterval(progressInterval);
        if (spinner.isSpinning) spinner.stop();
    }
}

async function continueDiscovery(projectPath: string, options: DiscoverOptions): Promise<void> {
    console.log(chalk.cyan("\nResuming discovery...\n"));

    const { session, pendingAuthBlockers } = await getResumeContext(projectPath);
    const resolved = resolveSiteDiscoveryOptions({
        projectPath,
        startUrl: "",
        preferSessionLimits: true,
        session,
        overrides: {
            maxPages: options.maxPages,
            maxDepth: options.maxDepth,
            timeout: options.timeout,
            skipAuth: options.skipAuth,
        },
        resolveStorageState: false,
    });
    const { maxPages, maxDepth } = resolved;

    const storageStatePath = resolveUsableDiscoveryAuthState(projectPath);
    const purgeQueueOnResume = Boolean(storageStatePath) && pendingAuthBlockers.length > 0;
    if (purgeQueueOnResume && storageStatePath) {
        console.log(
            chalk.dim(
                `  Fresh auth state found — restarting from ${session?.startUrl ?? "the original start URL"} to re-crawl the authenticated app.\n`,
            ),
        );
    }

    const spinner = ora({ text: "Loading session...", spinner: "dots" }).start();
    const { ux, progressInterval } = buildForegroundUx({
        projectPath,
        spinner,
        maxPages,
        maxDepth,
        pauseOnAuth: resolved.pauseOnAuth,
        showAuthOptions: false,
        authHeader: "Authentication required again",
        authHint: "Run 'raiken auth' to update authentication state.",
        hadAuthState: Boolean(storageStatePath),
    });

    const app = getProjectApplication(projectPath);
    try {
        await app.discovery.runContinueForeground(
            {
                overrides: {
                    maxPages: options.maxPages,
                    maxDepth: options.maxDepth,
                    timeout: options.timeout,
                    skipAuth: options.skipAuth,
                    storageStatePath,
                },
                resolveStorageState: false,
                storageStatePath,
                purgeQueueOnResume,
                resolvePendingAuthWithState: purgeQueueOnResume,
            },
            ux,
        );
    } catch (error) {
        clearInterval(progressInterval);
        if (spinner.isSpinning) spinner.fail(chalk.red("Discovery failed"));
        throw error;
    } finally {
        clearInterval(progressInterval);
        if (spinner.isSpinning) spinner.stop();
    }
}

export async function showDiscoveryStatus(projectPath: string): Promise<void> {
    const app = getProjectApplication(projectPath);
    const session = app.discovery.getSessionView();
    const stats = app.discovery.getStats();

    console.log(chalk.cyan("\nDiscovery Status\n"));

    if (!session) {
        console.log(chalk.dim("   No discovery sessions found."));
        console.log(chalk.dim("   Run 'raiken discover <url>' to start."));
        console.log();
        return;
    }

    console.log(chalk.white("Last Session:"));
    console.log(chalk.dim(`  Status:   ${session.status}`));
    if (session.startedAt) {
        console.log(chalk.dim(`  Started:  ${new Date(session.startedAt).toLocaleString()}`));
    }
    if (session.completedAt) {
        console.log(chalk.dim(`  Completed: ${new Date(session.completedAt).toLocaleString()}`));
    }
    if (session.blockedAtUrl && session.status === "paused") {
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
        console.log(chalk.yellow("Session is paused. Resume with 'raiken discover --continue'."));
    }
}
