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
 *   - Close the browser to abort cleanly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { looksLikeLoginUrl } from "@raiken/core";
import { resolveAuthStorageStateDestination } from "@raiken/shared";
import chalk from "chalk";
import ora from "ora";
import { cliExit } from "../repl/exit";

interface AuthOptions {
    url?: string;
    cookie?: string;
    domain?: string;
    storage?: string[];
    fromStateFile?: string;
}

interface StorageBaseline {
    cookieKeys: Set<string>;
    originKeys: Set<string>;
    initialUrl: string;
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

const POLL_INTERVAL_MS = 1500;
// Number of consecutive identical polls (after a change is detected) we wait
// for before saving — this avoids snapshotting in the middle of a redirect.
const STABILITY_POLLS = 2;

export async function authCommand(options: AuthOptions): Promise<void> {
    const projectPath = process.cwd();
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
        return;
    }

    if (options.cookie || (options.storage && options.storage.length > 0)) {
        await importFromFlags(options, authStatePath, projectPath);
        return;
    }

    console.log(chalk.cyan("\nStarting authentication flow...\n"));

    const url = options.url ?? "about:blank";

    const spinner = ora({ text: "Launching browser...", spinner: "dots" }).start();

    let chromium: typeof import("playwright").chromium;
    try {
        const pw = require("playwright");
        chromium = pw.chromium;
    } catch {
        try {
            const pw = require("playwright-core");
            chromium = pw.chromium;
        } catch {
            spinner.fail(chalk.red("Playwright is not installed. Run: npx playwright install"));
            cliExit(1);
        }
    }

    const browser = await chromium.launch({
        headless: false,
        args: ["--start-maximized"],
    });

    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    spinner.succeed(chalk.green("Browser launched"));

    if (url !== "about:blank") {
        console.log(chalk.dim(`Navigating to ${url}…\n`));
        try {
            await page.goto(url, { waitUntil: "domcontentloaded" });
        } catch (err) {
            console.log(
                chalk.yellow(
                    `⚠ Navigation reported an error (${(err as Error).message}). Continuing anyway.`,
                ),
            );
        }
    }

    const baseline = await captureBaseline(context, page);

    console.log(chalk.yellow("Log in to your application in the browser window."));
    console.log(chalk.dim("   Raiken will detect the successful login and save automatically."));
    console.log(chalk.dim("   Press Enter to save manually, or close the browser to abort.\n"));

    const watchSpinner = ora({
        text: "Waiting for login…",
        spinner: "dots",
    }).start();

    let aborted = false;
    type SavedReason = "auto" | "manual" | "browser-closed";
    let savedReason: SavedReason = "auto" as SavedReason;

    // Manual override: pressing Enter resolves the watcher immediately.
    // We hold onto `enterWatcher.cancel` so we can release the readline
    // (and unref stdin) when the auto-detector or browser-closed handler
    // wins the race — otherwise the CLI hangs after success because
    // readline keeps stdin referenced.
    const enterWatcher = waitForEnterKey();
    const enterPromise = enterWatcher.promise.then(() => {
        savedReason = "manual";
    });

    // Browser close: if the user dismisses the window, we save what we have.
    const browserClosedPromise = new Promise<void>((resolve) => {
        browser.once("disconnected", () => {
            savedReason = "browser-closed";
            resolve();
        });
    });

    const autoDetectPromise = (async () => {
        let stableHits = 0;
        let lastSnapshot: string | null = null;

        while (!aborted) {
            await delay(POLL_INTERVAL_MS);
            if (aborted) return;

            let storageState: Awaited<ReturnType<typeof context.storageState>>;
            try {
                storageState = await context.storageState();
            } catch {
                // Browser likely closing — stop polling. Browser-close handler will save.
                return;
            }

            const currentUrl = safePageUrl(page);
            const detected = detectLogin(baseline, storageState, currentUrl);
            const snapshot = snapshotKey(storageState, currentUrl);

            if (detected) {
                if (lastSnapshot === snapshot) {
                    stableHits += 1;
                    watchSpinner.text = `Login detected — confirming (${stableHits}/${STABILITY_POLLS})…`;
                } else {
                    stableHits = 1;
                    watchSpinner.text = "Login detected — confirming…";
                }
                lastSnapshot = snapshot;
                if (stableHits >= STABILITY_POLLS) {
                    savedReason = "auto";
                    return;
                }
            } else {
                stableHits = 0;
                lastSnapshot = snapshot;
                watchSpinner.text = `Waiting for login… (${storageState.cookies.length} cookies, ${storageState.origins.length} origins)`;
            }
        }
    })();

    await Promise.race([autoDetectPromise, enterPromise, browserClosedPromise]);
    aborted = true;
    watchSpinner.stop();
    // Release the readline / stdin reference. Idempotent — safe even if
    // the user pressed Enter (manual save), in which case the readline is
    // already closed and this is a no-op.
    enterWatcher.cancel();

    // Snapshot whatever state is currently in the context (works even if the
    // browser is closing — we just may get an empty state in that case).
    let storageState: Awaited<ReturnType<typeof context.storageState>> | null = null;
    try {
        storageState = await context.storageState();
    } catch {
        storageState = null;
    }

    if (!storageState) {
        console.log(chalk.red("\n✗ Could not read browser session state. Auth aborted."));
        try {
            await browser.close();
        } catch {
            // already closed
        }
        cliExit(1);
    }

    fs.writeFileSync(authStatePath, JSON.stringify(storageState, null, 2));

    // Mark outstanding *auth* blockers resolved so the dashboard's auto-
    // resume logic kicks in on the next poll. Captcha / 5xx / manual-pause
    // blockers are deliberately left alone — saved auth state doesn't
    // unblock them, and pre-fix this loop falsely cleared them with
    // `resolvedVia: "auth_command"`, causing the dashboard to auto-resume
    // straight back into the same captcha and confusing the timeline.
    const resolvedBlockers = await markAuthBlockersResolved(projectPath, authStatePath);

    const cookieCount = storageState.cookies.length;
    const originCount = storageState.origins.length;

    console.log();
    if (savedReason === "manual") {
        console.log(chalk.green("✓ Saved (manual)"));
    } else if (savedReason === "browser-closed") {
        console.log(chalk.green("✓ Saved (browser closed)"));
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
    console.log();

    // Warn if we saved an empty state — almost always a sign that login wasn't
    // actually completed before the browser closed.
    if (cookieCount === 0 && originCount === 0) {
        console.log(
            chalk.yellow("⚠ Saved state is empty — no cookies or storage entries were captured."),
        );
        console.log(chalk.dim("   Re-run `raiken auth` and complete the login before exiting.\n"));
    }

    try {
        await browser.close();
    } catch {
        // already closed
    }

    if (cookieCount === 0 && originCount === 0) {
        cliExit(1);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function captureBaseline(
    context: import("playwright").BrowserContext,
    page: import("playwright").Page,
): Promise<StorageBaseline> {
    let state: Awaited<ReturnType<typeof context.storageState>>;
    try {
        state = await context.storageState();
    } catch {
        return {
            cookieKeys: new Set(),
            originKeys: new Set(),
            initialUrl: safePageUrl(page),
        };
    }

    return {
        cookieKeys: new Set(state.cookies.map(cookieKey)),
        originKeys: new Set(state.origins.flatMap(originEntries)),
        initialUrl: safePageUrl(page),
    };
}

function detectLogin(
    baseline: StorageBaseline,
    state: Awaited<ReturnType<import("playwright").BrowserContext["storageState"]>>,
    currentUrl: string,
): boolean {
    const newCookie = state.cookies.some((c) => !baseline.cookieKeys.has(cookieKey(c)));
    const newOrigin = state.origins
        .flatMap(originEntries)
        .some((entry) => !baseline.originKeys.has(entry));

    const initialIsLogin = isLoginOrPreNavigation(baseline.initialUrl);

    // Best signal: a new cookie or storage entry shows up. URL change alone is
    // a weaker signal (could be intra-login redirects), so we require a
    // cred-bearing artifact OR an unambiguous redirect off the login URL.
    if (newCookie || newOrigin) {
        return true;
    }

    if (initialIsLogin && currentUrl && !isLoginOrPreNavigation(currentUrl)) {
        // Redirected away from the login page entirely — treat as logged in.
        return true;
    }

    return false;
}

function snapshotKey(
    state: Awaited<ReturnType<import("playwright").BrowserContext["storageState"]>>,
    currentUrl: string,
): string {
    const cookies = state.cookies.map(cookieKey).sort().join("|");
    const origins = state.origins.flatMap(originEntries).sort().join("|");
    return `${currentUrl}::${cookies}::${origins}`;
}

function cookieKey(c: { name: string; domain: string; path: string }): string {
    return `${c.domain}\u0000${c.path}\u0000${c.name}`;
}

function originEntries(o: { origin: string; localStorage?: Array<{ name: string }> }): string[] {
    return (o.localStorage ?? []).map((item) => `${o.origin}\u0000${item.name}`);
}

/**
 * Treat the empty/about:blank pre-navigation state as "looks like login"
 * so the watcher waits for *any* meaningful navigation before considering
 * the session changed. The shared {@link looksLikeLoginUrl} predicate
 * (`@raiken/core`) handles every real URL.
 */
function isLoginOrPreNavigation(url: string): boolean {
    if (!url || url === "about:blank") return true;
    return looksLikeLoginUrl(url);
}

function safePageUrl(page: import("playwright").Page): string {
    try {
        return page.url();
    } catch {
        return "";
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Watcher that resolves when the user presses Enter, with an explicit
 * `cancel()` to release the underlying readline interface when another
 * race winner (auto-detect or browser-closed) fires first.
 *
 * The pre-fix version created a readline interface in a fire-and-forget
 * Promise. If the auto-detector or browser-closed handler resolved
 * `Promise.race` first, the readline kept stdin in line-input mode
 * forever — the CLI process would print "✅ Login detected" and hang
 * because Node never exits while stdin is referenced. Users hit this
 * every successful run and either Ctrl-C'd or assumed the command was
 * still working.
 *
 * Returning an object with a `cancel` makes the cleanup explicit at the
 * call site (next to the spinner stop) instead of relying on listener
 * tear-down side effects.
 */
function waitForEnterKey(): { promise: Promise<void>; cancel: () => void } {
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
            // Unref stdin so an open readline-less stream doesn't pin the
            // event loop on macOS/Linux when the CLI exits.
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
        cliExit(1);
    }
    let parsed: PlaywrightStorageStateShape;
    try {
        const raw = fs.readFileSync(resolved, "utf-8");
        parsed = JSON.parse(raw) as PlaywrightStorageStateShape;
    } catch (err) {
        console.error(chalk.red(`\n✗ Could not parse ${resolved}: ${(err as Error).message}`));
        cliExit(1);
    }
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
        console.error(
            chalk.red(
                "\n✗ File doesn't look like a Playwright storage state (missing cookies/origins arrays).",
            ),
        );
        cliExit(1);
    }

    fs.writeFileSync(dest, JSON.stringify(parsed, null, 2));
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
                "\n✗ --domain is required when using --cookie or --storage (e.g. --domain app.example.com).",
            ),
        );
        cliExit(1);
    }
    const domain = options.domain
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
        .trim();
    if (!domain) {
        console.error(chalk.red("\n✗ --domain is empty."));
        cliExit(1);
    }
    // Default the cookie domain to ".host" so subdomain variations match.
    const cookieDomain = domain.startsWith(".") ? domain : `.${domain}`;
    const origin = `https://${domain}`;

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
                secure: true,
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
        cliExit(1);
    }

    const state: PlaywrightStorageStateShape = {
        cookies,
        origins: localStorage.length > 0 ? [{ origin, localStorage }] : [],
    };

    fs.writeFileSync(dest, JSON.stringify(state, null, 2));
    await markAuthBlockersResolved(projectPath, dest);

    console.log(chalk.green("\n✓ Imported auth state"));
    console.log(chalk.dim(`   File:           ${dest}`));
    console.log(chalk.dim(`   Domain:         ${domain}`));
    console.log(chalk.dim(`   Cookies:        ${cookies.length}`));
    console.log(chalk.dim(`   Storage origins: ${state.origins.length}\n`));
}

/**
 * Mark every unresolved `auth_required` blocker as `provide_state` against
 * the freshly-written storage state. Returns the number of blockers
 * touched so the caller can show a "N blockers cleared" hint.
 *
 * Crucially scoped to `auth_required` only:
 *  - A captcha pause isn't unblocked by saved cookies; the user has to
 *    solve the challenge in a browser.
 *  - A 5xx error_page pause isn't unblocked by auth state; the server
 *    is broken.
 *  - A manual user pause is — by definition — the user driving the
 *    crawl. Auto-resolving it would steal control from them.
 *
 * Pre-fix this function (and its inline twin in `authCommand`) looped
 * over EVERY unresolved blocker, leaving the timeline showing
 * "Resolved: provide_state via auth_command" on rows it had no business
 * touching, and triggering false-positive auto-resume cycles.
 */
async function markAuthBlockersResolved(projectPath: string, statePath: string): Promise<number> {
    try {
        const { CodeGraphDB, SiteKnowledgeDB } = await import("@raiken/core");
        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
            const blockers = siteDb.getUnresolvedBlockers();
            let touched = 0;
            for (const blocker of blockers) {
                if (blocker.id && blocker.category === "auth_required") {
                    siteDb.markBlockerResolved(blocker.id, statePath);
                    touched += 1;
                }
            }
            return touched;
        } finally {
            db.close();
        }
    } catch {
        // Non-fatal — the saved storage state is the important artifact.
        return 0;
    }
}
