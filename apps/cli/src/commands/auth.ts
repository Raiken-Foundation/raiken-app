/**
 * Auth Command
 *
 * Drops the user into a real Chromium window, watches the browsing session for
 * signs that login completed (new cookies, localStorage entries, or a redirect
 * away from a login-looking URL), then snapshots the storage state and marks
 * outstanding auth blockers resolved. The dashboard's discovery server picks
 * the change up on its next poll and resumes the paused crawl automatically.
 *
 * Manual fallbacks:
 *   - Press Enter at any time to save the current state immediately.
 *   - Close the browser to abort cleanly; any existing state is left as-is.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import {
    acquireProjectOperation,
    clearAuthLivenessCache,
    HandoffBlockerResolutionError,
    type InteractiveAuthHandoffReason,
    resolveHandoffBlockers,
    runCustomLoginScript,
    runInteractiveAuthHandoff,
    writeValidatedAuthState,
} from "@raiken/core";
import { loadAuthConfig, resolveAuthStorageStateDestination } from "@raiken/shared/server";
import chalk from "chalk";
import ora from "ora";
import { dim } from "../agent-stream";
import { CLI_EXIT, exitConfigAuth, exitUsage, safeCliErrorMessage } from "../errors";
import { cliExit } from "../cli/exit";

export interface ManualSaveWatcher {
    promise: Promise<void>;
    cancel: () => void;
}

export interface AuthOptions {
    url?: string;
    cookie?: string;
    domain?: string;
    storage?: string[];
    fromStateFile?: string;
    manual?: boolean;
    script?: string;
    timeout?: string | number;
    headed?: boolean;
    /** Write .raiken/login.ts from the last observed login form. */
    writeLoginScript?: boolean;
    /** `--no-discover`: keep the saved session without crawling behind it. */
    discover?: boolean;
    /**
     * REPL integration hook. Standalone auth creates its own readline watcher;
     * the interactive shell supplies one backed by its existing interface so
     * two readline instances never compete for stdin.
     */
    createManualSaveWatcher?: () => ManualSaveWatcher;
}

interface PlaywrightStorageStateShape {
    cookies: Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
        expires: number;
        httpOnly: boolean;
        secure: boolean;
        sameSite: "Strict" | "Lax" | "None";
    }>;
    origins: Array<{
        origin: string;
        localStorage: Array<{ name: string; value: string }>;
    }>;
}

export function shouldRunCustomLogin(
    options: Pick<AuthOptions, "manual" | "script">,
    configuredScript: string | undefined,
): boolean {
    return !options.manual && Boolean(options.script || configuredScript);
}

export async function authCommand(options: AuthOptions): Promise<void> {
    const projectPath = process.cwd();

    if (options.writeLoginScript) {
        const { writeLoginScriptFromEvidence, recordLoginFlowFromEvidence } = await import(
            "@raiken/core"
        );
        recordLoginFlowFromEvidence(projectPath);
        const written = writeLoginScriptFromEvidence(projectPath);
        if (!written) {
            console.error(
                chalk.red(
                    "\n✗ No observed login form on disk. Run the agent against a login page first, " +
                        "or complete an interactive auth once so fields are recorded.\n",
                ),
            );
            cliExit(CLI_EXIT.USAGE);
        }
        console.log(
            chalk.green(`\n✓ Wrote login script ${path.relative(projectPath, written.path)}`),
        );
        if (written.patchedConfig) {
            console.log(
                chalk.dim(
                    "   Set auth.customLoginScript to .raiken/login.ts in raiken.config.json",
                ),
            );
        } else {
            console.log(
                chalk.dim(
                    '   Add to raiken.config.json: "auth": { "customLoginScript": ".raiken/login.ts" }',
                ),
            );
        }
        console.log(chalk.dim("   Re-run: raiken auth\n"));
        return;
    }

    // Honour `auth.storageStatePath` from raiken.config.json — pre-fix this
    // hardcoded `.raiken/auth-state.json` and silently ignored the configured
    // path, which meant `raiken discover` would load auth state from the
    // configured path while `raiken auth` wrote to the legacy default. The
    // result was that any project with a custom `storageStatePath` could
    // never refresh its auth state via the CLI.
    const authStatePath = resolveAuthStorageStateDestination(projectPath);
    const authStateDir = path.dirname(authStatePath);

    if (!fs.existsSync(authStateDir)) {
        fs.mkdirSync(authStateDir, { recursive: true });
    }

    // Headless import paths: skip launching a browser entirely. Useful for CI,
    // SSH sessions, or anyone who already has a session token / cookie they
    // can paste in. Each branch builds a Playwright-compatible storageState
    // and writes it to the same auth-state.json the discover command reads.
    if (options.fromStateFile) {
        await importFromStateFile(options.fromStateFile, authStatePath, projectPath);
        await discoverWithSession(projectPath, options, 0);
        return;
    }

    if (options.cookie || (options.storage && options.storage.length > 0)) {
        await importFromFlags(options, authStatePath, projectPath);
        await discoverWithSession(projectPath, options, 0);
        return;
    }

    const configuredScript = loadAuthConfig(projectPath).customLoginScript;
    if (shouldRunCustomLogin(options, configuredScript)) {
        const timeoutMs =
            options.timeout === undefined
                ? undefined
                : Number.parseInt(String(options.timeout), 10);
        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
            exitUsage("Invalid --timeout. Must be a positive number of milliseconds.");
        }
        const scriptSpinner = ora({
            text: "Running custom login script...",
            spinner: "dots",
        }).start();
        try {
            const result = await runCustomLoginScript({
                projectPath,
                scriptPath: options.script,
                storageStatePath: authStatePath,
                url: options.url,
                timeoutMs,
                headed: options.headed,
            });
            const resolvedBlockers = await markAuthBlockersResolved(
                projectPath,
                result.storageStatePath,
            );
            scriptSpinner.succeed(chalk.green("Custom login completed"));
            console.log(chalk.dim(`   Script:          ${result.scriptPath}`));
            console.log(chalk.dim(`   File:            ${result.storageStatePath}`));
            console.log(chalk.dim(`   Cookies:         ${result.cookies}`));
            console.log(chalk.dim(`   Storage origins: ${result.origins}`));
            if (resolvedBlockers > 0) {
                console.log(chalk.dim(`   Blockers cleared: ${resolvedBlockers}`));
            }
            console.log();
            await discoverWithSession(projectPath, options, resolvedBlockers);
            return;
        } catch (error) {
            scriptSpinner.fail(chalk.red("Custom login failed"));
            throw error;
        }
    }

    // The interactive browser flow needs a human to log in and (for manual
    // saves) an Enter key to press. With a non-TTY stdin the readline watcher
    // EOFs instantly and saves an empty session — the exact "contains no
    // cookies or origins" failure mode. Fail fast with the non-interactive
    // options instead of launching a browser nobody can drive.
    if (!process.stdin.isTTY && !options.createManualSaveWatcher) {
        exitConfigAuth(
            "Interactive auth needs a terminal, but stdin is not a TTY (headless run).\n" +
                "Provide credentials non-interactively instead:\n" +
                "  --script <path>          custom login script (auth.customLoginScript)\n" +
                '  --cookie "<pairs>"        import cookies directly (requires --domain)\n' +
                "  --storage <key=value>    import localStorage entries (requires --domain)\n" +
                "  --from-state-file <path> copy an existing Playwright storage-state JSON",
        );
    }

    console.log(chalk.cyan("\nStarting authentication flow...\n"));

    const url = options.url ?? "about:blank";

    const spinner = ora({ text: "Launching browser...", spinner: "dots" }).start();

    const operation = await acquireProjectOperation(projectPath, "browser");
    // Set once the session is on disk. The crawl runs after the operation is
    // released, since it needs the browser slot this block still holds.
    let savedBlockers: number | null = null;
    try {
        let browserLaunched = false;
        let watchSpinner: ReturnType<typeof ora> | null = null;

        let handoffResult: Awaited<ReturnType<typeof runInteractiveAuthHandoff>>;
        try {
            handoffResult = await runInteractiveAuthHandoff({
                projectPath,
                url,
                storageStatePath: authStatePath,
                headless: false,
                category: "auth_required",
                createManualCompletionWatcher: options.createManualSaveWatcher ?? waitForEnterKey,
                blockerResolution: { kind: "auth_command" },
                onBrowserReady: () => {
                    browserLaunched = true;
                    spinner.succeed(chalk.green("Browser launched"));
                    if (url !== "about:blank") {
                        console.log(chalk.dim(`Navigating to ${url}…\n`));
                    }
                    console.log(chalk.yellow("Log in to your application in the browser window."));
                    console.log(
                        chalk.dim(
                            "   Raiken will detect the successful login and save automatically.",
                        ),
                    );
                    console.log(
                        chalk.dim(
                            "   Press Enter to save manually, or close the browser to abort.\n",
                        ),
                    );
                    watchSpinner = ora({
                        text: "Waiting for login…",
                        spinner: "dots",
                    }).start();
                },
                onProgress: (snapshot) => {
                    if (!watchSpinner) return;
                    if (snapshot.phase === "confirming") {
                        watchSpinner.text = `Login detected — confirming (${snapshot.stableHits}/${snapshot.stabilityPolls})…`;
                    } else if (snapshot.phase === "waiting") {
                        watchSpinner.text = `Waiting for login… (${snapshot.cookies} cookies, ${snapshot.origins} origins)`;
                    }
                },
            });
        } catch (error) {
            const message = safeCliErrorMessage(error);
            if (message.includes("Playwright is not installed")) {
                spinner.fail(chalk.red("Playwright is not installed. Run: npx playwright install"));
                cliExit(CLI_EXIT.RUNTIME_FAILURE);
            }
            if (!browserLaunched) {
                spinner.fail(chalk.red("Failed to launch browser"));
            }
            throw error;
        } finally {
            watchSpinner?.stop();
        }

        const {
            storageState,
            reason: savedReason,
            persisted,
            blockersResolved: resolvedBlockers,
            blockerResolutionWarning,
            errorMessage,
        } = handoffResult;

        if (savedReason === "error" || !storageState) {
            console.log(
                chalk.red(
                    `\n✗ ${errorMessage ?? "Could not read browser session state. Auth aborted."}`,
                ),
            );
            cliExit(CLI_EXIT.RUNTIME_FAILURE);
        }

        // The handoff only writes session state once login is confirmed, so a
        // closed browser or an expired timer leaves any previously saved state
        // untouched rather than replacing it with a half-finished session.
        if (!persisted) {
            console.log();
            console.log(chalk.yellow(`✗ ${describeUnsavedHandoff(savedReason)}`));
            console.log(chalk.dim(`   Existing auth state at ${authStatePath} is unchanged.`));
            console.log(
                chalk.dim("   Re-run `raiken auth` and press Enter once you are logged in.\n"),
            );
            cliExit(savedReason === "timeout" ? CLI_EXIT.TIMEOUT : CLI_EXIT.CANCELLED);
        }

        const cookieCount = storageState.cookies.length;
        const originCount = storageState.origins.length;

        console.log();
        if (savedReason === "manual") {
            console.log(chalk.green("✓ Saved (manual)"));
        } else {
            console.log(chalk.green("✓ Login detected — saved automatically"));
        }
        console.log(chalk.dim(`   File:           ${authStatePath}`));
        console.log(chalk.dim(`   Cookies:        ${cookieCount}`));
        console.log(chalk.dim(`   Storage origins: ${originCount}`));
        if (resolvedBlockers > 0) {
            console.log(
                chalk.dim(
                    `   Blockers cleared: ${resolvedBlockers} (dashboard will resume discovery automatically)`,
                ),
            );
        }
        if (blockerResolutionWarning) {
            console.log(chalk.yellow(`⚠ ${blockerResolutionWarning}`));
        }
        console.log();

        // A manual save can still capture nothing if Enter was pressed too early.
        if (cookieCount === 0 && originCount === 0) {
            console.log(
                chalk.yellow(
                    "⚠ Saved state is empty — no cookies or storage entries were captured.",
                ),
            );
            console.log(
                chalk.dim("   Re-run `raiken auth` and complete the login before exiting.\n"),
            );
            console.log(
                chalk.dim(
                    "   Non-interactive runs: use --cookie/--storage, --from-state-file, or a custom login script instead.\n",
                ),
            );
            cliExit(CLI_EXIT.RUNTIME_FAILURE);
        }
        savedBlockers = resolvedBlockers;
    } finally {
        await operation.release();
    }

    if (savedBlockers !== null) {
        await discoverWithSession(projectPath, options, savedBlockers);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Crawl the app with the session we just saved.
 *
 * A session on disk teaches Raiken nothing on its own: cover drafts from
 * captured pages, so without this step the next `raiken cover "log in and …"`
 * still only knows the signed-out app — while looking, to the user, completely
 * set up. Requiring people to know that a second command exists is the trap
 * this closes.
 *
 * Best-effort: the session is already saved, so a crawl failure (app not
 * running, no baseURL) is a warning with the manual command, never an error.
 */
async function discoverWithSession(
    projectPath: string,
    options: AuthOptions,
    resolvedBlockers: number,
): Promise<void> {
    if (options.discover === false) return;
    // Clearing blockers hands a paused crawl back to whoever started it; a
    // second crawl here would only contend for the discovery lock.
    if (resolvedBlockers > 0) return;

    const { resolveDiscoverSeedUrl, runBoundedDiscover, hasAuthenticatedSiteKnowledge } =
        await import("@raiken/core");

    // Playwright's baseURL is the app under test; the login URL and the
    // imported cookie's domain are fallbacks for projects without one.
    const seedUrl =
        (await resolveDiscoverSeedUrl(projectPath)) ??
        originOf(options.url) ??
        originOf(options.domain);
    if (!seedUrl) {
        console.log(
            chalk.dim(
                "Next: raiken discover <url> — cover drafts from crawled pages, so nothing " +
                    "behind the login is known until the app is crawled with this session.\n",
            ),
        );
        return;
    }

    const spinner = ora({
        text: `Discovering ${seedUrl} with the new session...`,
        spinner: "dots",
    }).start();
    // The state just imported is scoped to a specific origin; when the crawl
    // seed (usually Playwright's baseURL) is a different origin, the session
    // cannot apply and the crawl is silently signed out. Say so before the
    // crawl instead of letting the "Crawled, but nothing was captured" branch
    // deliver the news without the why.
    try {
        const { describeStorageStateOriginMismatch } = await import("@raiken/core");
        const mismatch = describeStorageStateOriginMismatch(projectPath, seedUrl);
        if (mismatch) {
            spinner.warn(chalk.yellow(mismatch));
            console.log(dim(`   Session is saved. Run: raiken discover ${seedUrl}\n`));
            return;
        }
    } catch {
        /* best-effort warning — never block the crawl on it */
    }
    try {
        await runBoundedDiscover(projectPath, seedUrl);
    } catch (error) {
        spinner.warn(chalk.yellow("Could not crawl with the new session"));
        console.log(chalk.dim(`   ${safeCliErrorMessage(error)}`));
        console.log(chalk.dim(`   Session is saved. Run: raiken discover ${seedUrl}\n`));
        return;
    }

    if (hasAuthenticatedSiteKnowledge(projectPath)) {
        spinner.succeed(chalk.green("Captured pages behind the login"));
        console.log(chalk.dim("   Cover can now draft post-login tests from real pages.\n"));
        return;
    }
    spinner.warn(chalk.yellow("Crawled, but nothing behind the login was captured"));
    console.log(
        chalk.dim(
            `   The session may not apply to ${seedUrl}. Post-login drafts stay unverified.\n`,
        ),
    );
}

/**
 * Origin of a login URL or imported domain, used as a crawl seed when
 * Playwright has no baseURL. Bare hosts (`app.example.com`) are rejected
 * rather than guessed at, since the scheme decides which app gets crawled.
 */
function originOf(url: string | undefined): string | null {
    if (!url || url === "about:blank") return null;
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

export function describeUnsavedHandoff(reason: InteractiveAuthHandoffReason): string {
    if (reason === "timeout") return "Timed out before login completed — nothing was saved.";
    if (reason === "abort") return "Auth cancelled — nothing was saved.";
    if (reason === "browser-closed")
        return "Browser closed before login completed — nothing was saved.";
    return "Login was not confirmed — nothing was saved.";
}

/**
 * Watcher that resolves when the user presses Enter, with an explicit
 * `cancel()` to release the underlying readline interface when another
 * race winner (auto-detect or browser-closed) fires first.
 */
function waitForEnterKey(): ManualSaveWatcher {
    let rl: readline.Interface | null = null;
    const promise = new Promise<void>((resolve) => {
        rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        const finish = () => {
            try {
                rl?.close();
            } catch {
                // already closed
            }
            try {
                process.stdin.unref?.();
            } catch {
                // unref isn't supported on every stream type; best effort.
            }
            resolve();
        };
        rl.once("line", finish);
        rl.once("close", finish);
    });
    return {
        promise,
        cancel: () => {
            try {
                rl?.close();
            } catch {
                // already closed
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Headless import paths (no browser)
// ---------------------------------------------------------------------------

async function importFromStateFile(src: string, dest: string, projectPath: string): Promise<void> {
    const resolved = path.isAbsolute(src) ? src : path.resolve(projectPath, src);
    if (!fs.existsSync(resolved)) {
        console.error(chalk.red(`\n✗ State file not found: ${resolved}`));
        cliExit(CLI_EXIT.USAGE);
    }
    let parsed: PlaywrightStorageStateShape;
    try {
        const raw = fs.readFileSync(resolved, "utf-8");
        parsed = JSON.parse(raw) as PlaywrightStorageStateShape;
    } catch (err) {
        console.error(chalk.red(`\n✗ Could not parse ${resolved}: ${(err as Error).message}`));
        cliExit(CLI_EXIT.RUNTIME_FAILURE);
    }
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
        console.error(
            chalk.red(
                "\n✗ File doesn't look like a Playwright storage state (missing cookies/origins arrays).",
            ),
        );
        cliExit(CLI_EXIT.RUNTIME_FAILURE);
    }

    writeValidatedAuthState(dest, parsed);
    clearAuthLivenessCache(projectPath);
    await markAuthBlockersResolved(projectPath, dest);

    console.log(chalk.green("\n✓ Imported storage state"));
    console.log(chalk.dim(`   From: ${resolved}`));
    console.log(chalk.dim(`   To:   ${dest}`));
    console.log(chalk.dim(`   Cookies:        ${parsed.cookies.length}`));
    console.log(chalk.dim(`   Storage origins: ${parsed.origins.length}\n`));
}

async function importFromFlags(
    options: AuthOptions,
    dest: string,
    projectPath: string,
): Promise<void> {
    if (!options.domain) {
        console.error(
            chalk.red(
                "\n✗ --domain is required when using --cookie or --storage (e.g. --domain app.example.com or --domain http://127.0.0.1:8123).",
            ),
        );
        cliExit(CLI_EXIT.USAGE);
    }
    // Accept bare hosts ("app.example.com"), host:port ("127.0.0.1:8123"),
    // or full URLs ("http://staging.internal:8080/"). A schemeless value is
    // assumed https; an explicit scheme is honoured — it drives both the
    // storage origin and the cookie `secure` flag, so plain-http LAN/staging
    // hosts no longer get secure-only cookies that Chromium silently drops.
    const rawDomain = options.domain.trim().replace(/^\.+/, "");
    const parsedDomain = (() => {
        const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawDomain)
            ? rawDomain
            : `https://${rawDomain}`;
        try {
            return new URL(withScheme);
        } catch {
            return null;
        }
    })();
    if (!parsedDomain || !parsedDomain.hostname) {
        console.error(chalk.red(`\n✗ --domain "${options.domain}" is not a valid host or URL.`));
        cliExit(CLI_EXIT.USAGE);
    }
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawDomain)) {
        console.log(
            chalk.dim(
                `  Assuming https:// for "${rawDomain}" — pass --domain http://<host>:<port> if the app runs over plain http.\n`,
            ),
        );
    }
    const scheme = parsedDomain.protocol === "http:" ? "http" : "https";
    const host = parsedDomain.hostname.replace(/^\[|\]$/g, "");
    const domain = parsedDomain.host;
    // RFC 6265: cookie domains never carry a port, and the leading-dot
    // "domain cookie" form only makes sense for registrable names — IP
    // literals and single-label hosts (localhost, staging) must be host-only.
    const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
    const isSingleLabel = !host.includes(".");
    const cookieDomain = isIpLiteral || isSingleLabel ? host : `.${host}`;
    const origin = `${scheme}://${parsedDomain.host}`;
    const secureCookies = scheme === "https";

    const cookies: PlaywrightStorageStateShape["cookies"] = [];
    if (options.cookie) {
        for (const pair of options.cookie.split(";")) {
            const trimmed = pair.trim();
            if (!trimmed) continue;
            const eq = trimmed.indexOf("=");
            if (eq <= 0) continue;
            const name = trimmed.slice(0, eq).trim();
            const value = trimmed.slice(eq + 1).trim();
            if (!name) continue;
            cookies.push({
                name,
                value,
                domain: cookieDomain,
                path: "/",
                expires: -1,
                httpOnly: false,
                secure: secureCookies,
                sameSite: "Lax",
            });
        }
    }

    const localStorage: Array<{ name: string; value: string }> = [];
    for (const entry of options.storage ?? []) {
        const eq = entry.indexOf("=");
        if (eq <= 0) {
            console.warn(chalk.yellow(`⚠ Ignoring malformed --storage entry: ${entry}`));
            continue;
        }
        const name = entry.slice(0, eq).trim();
        const value = entry.slice(eq + 1);
        if (!name) continue;
        localStorage.push({ name, value });
    }

    if (cookies.length === 0 && localStorage.length === 0) {
        console.error(chalk.red("\n✗ No cookies or storage entries to import."));
        cliExit(CLI_EXIT.USAGE);
    }

    const state: PlaywrightStorageStateShape = {
        cookies,
        origins: localStorage.length > 0 ? [{ origin, localStorage }] : [],
    };

    writeValidatedAuthState(dest, state);
    clearAuthLivenessCache(projectPath);
    await markAuthBlockersResolved(projectPath, dest);

    console.log(chalk.green("\n✓ Imported auth state"));
    console.log(chalk.dim(`   File:           ${dest}`));
    console.log(chalk.dim(`   Domain:         ${domain}`));
    console.log(chalk.dim(`   Cookies:        ${cookies.length}`));
    console.log(chalk.dim(`   Storage origins: ${state.origins.length}\n`));
}

async function markAuthBlockersResolved(projectPath: string, statePath: string): Promise<number> {
    clearAuthLivenessCache(projectPath);
    try {
        return resolveHandoffBlockers(projectPath, {
            storageStatePath: statePath,
            strategy: { kind: "auth_command" },
        });
    } catch (error) {
        if (error instanceof HandoffBlockerResolutionError) {
            console.log(chalk.yellow(`⚠ ${error.message}`));
            return error.blockersResolved;
        }
        throw error;
    }
}
