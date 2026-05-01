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
import chalk from "chalk";
import ora from "ora";

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
const LOGIN_PATH_RE = /(login|signin|sign-in|sign_in|log-in|log_in|auth|sso|account|oauth)/i;

export async function authCommand(options: AuthOptions): Promise<void> {
    const projectPath = process.cwd();
    const raikenDir = path.join(projectPath, ".raiken");
    const authStatePath = path.join(raikenDir, "auth-state.json");

    if (!fs.existsSync(raikenDir)) {
        fs.mkdirSync(raikenDir, { recursive: true });
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

    console.log(chalk.cyan("\n🔐 Starting authentication flow...\n"));

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
            process.exit(1);
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

    console.log(chalk.yellow("📝 Log in to your application in the browser window."));
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
    const enterPromise = waitForEnterKey().then(() => {
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

    // Snapshot whatever state is currently in the context (works even if the
    // browser is closing — we just may get an empty state in that case).
    let storageState: Awaited<ReturnType<typeof context.storageState>> | null = null;
    try {
        storageState = await context.storageState();
    } catch {
        storageState = null;
    }

    if (!storageState) {
        console.log(chalk.red("\n❌ Could not read browser session state. Auth aborted."));
        try {
            await browser.close();
        } catch {
            // already closed
        }
        process.exit(1);
    }

    fs.writeFileSync(authStatePath, JSON.stringify(storageState, null, 2));

    // Mark any outstanding blockers resolved so the dashboard's auto-resume
    // logic kicks in on the next poll.
    let resolvedBlockers = 0;
    try {
        const { CodeGraphDB, SiteKnowledgeDB } = await import("@raiken/core");
        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
            const blockers = siteDb.getUnresolvedBlockers();
            for (const blocker of blockers) {
                if (blocker.id) {
                    siteDb.markBlockerResolved(blocker.id, authStatePath);
                    resolvedBlockers += 1;
                }
            }
        } finally {
            db.close();
        }
    } catch {
        // Non-fatal — the saved storage state is the important artifact.
    }

    const cookieCount = storageState.cookies.length;
    const originCount = storageState.origins.length;

    console.log();
    if (savedReason === "manual") {
        console.log(chalk.green("✅ Saved (manual)"));
    } else if (savedReason === "browser-closed") {
        console.log(chalk.green("✅ Saved (browser closed)"));
    } else {
        console.log(chalk.green("✅ Login detected — saved automatically"));
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
            chalk.yellow(
                "⚠ Saved state is empty — no cookies or storage entries were captured.",
            ),
        );
        console.log(chalk.dim("   Re-run `raiken auth` and complete the login before exiting.\n"));
    }

    try {
        await browser.close();
    } catch {
        // already closed
    }

    if (cookieCount === 0 && originCount === 0) {
        process.exit(1);
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

    const initialIsLogin =
        baseline.initialUrl === "about:blank" ||
        looksLikeLoginUrl(baseline.initialUrl);

    // Best signal: a new cookie or storage entry shows up. URL change alone is
    // a weaker signal (could be intra-login redirects), so we require a
    // cred-bearing artifact OR an unambiguous redirect off the login URL.
    if (newCookie || newOrigin) {
        return true;
    }

    if (initialIsLogin && currentUrl && !looksLikeLoginUrl(currentUrl)) {
        // Redirected away from the login page entirely — treat as logged in.
        return true;
    }

    return false;
}

function snapshotKey(
    state: Awaited<ReturnType<import("playwright").BrowserContext["storageState"]>>,
    currentUrl: string,
): string {
    const cookies = state.cookies
        .map(cookieKey)
        .sort()
        .join("|");
    const origins = state.origins
        .flatMap(originEntries)
        .sort()
        .join("|");
    return `${currentUrl}::${cookies}::${origins}`;
}

function cookieKey(c: { name: string; domain: string; path: string }): string {
    return `${c.domain}\u0000${c.path}\u0000${c.name}`;
}

function originEntries(o: {
    origin: string;
    localStorage?: Array<{ name: string }>;
}): string[] {
    return (o.localStorage ?? []).map((item) => `${o.origin}\u0000${item.name}`);
}

function looksLikeLoginUrl(url: string): boolean {
    if (!url || url === "about:blank") return true;
    try {
        const parsed = new URL(url);
        return LOGIN_PATH_RE.test(parsed.pathname) || LOGIN_PATH_RE.test(parsed.search);
    } catch {
        return false;
    }
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

function waitForEnterKey(): Promise<void> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.once("line", () => {
            rl.close();
            resolve();
        });
        // Make sure the readline doesn't keep the process alive on its own.
        rl.on("close", () => resolve());
    });
}

// ---------------------------------------------------------------------------
// Headless import paths (no browser)
// ---------------------------------------------------------------------------

async function importFromStateFile(
    src: string,
    dest: string,
    projectPath: string,
): Promise<void> {
    const resolved = path.isAbsolute(src) ? src : path.resolve(projectPath, src);
    if (!fs.existsSync(resolved)) {
        console.error(chalk.red(`\n❌ State file not found: ${resolved}`));
        process.exit(1);
    }
    let parsed: PlaywrightStorageStateShape;
    try {
        const raw = fs.readFileSync(resolved, "utf-8");
        parsed = JSON.parse(raw) as PlaywrightStorageStateShape;
    } catch (err) {
        console.error(
            chalk.red(`\n❌ Could not parse ${resolved}: ${(err as Error).message}`),
        );
        process.exit(1);
    }
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
        console.error(
            chalk.red(
                "\n❌ File doesn't look like a Playwright storage state (missing cookies/origins arrays).",
            ),
        );
        process.exit(1);
    }

    fs.writeFileSync(dest, JSON.stringify(parsed, null, 2));
    await markBlockersResolved(projectPath, dest);

    console.log(chalk.green("\n✅ Imported storage state"));
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
                "\n❌ --domain is required when using --cookie or --storage (e.g. --domain app.example.com).",
            ),
        );
        process.exit(1);
    }
    const domain = options.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
    if (!domain) {
        console.error(chalk.red("\n❌ --domain is empty."));
        process.exit(1);
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
        console.error(chalk.red("\n❌ No cookies or storage entries to import."));
        process.exit(1);
    }

    const state: PlaywrightStorageStateShape = {
        cookies,
        origins: localStorage.length > 0 ? [{ origin, localStorage }] : [],
    };

    fs.writeFileSync(dest, JSON.stringify(state, null, 2));
    await markBlockersResolved(projectPath, dest);

    console.log(chalk.green("\n✅ Imported auth state"));
    console.log(chalk.dim(`   File:           ${dest}`));
    console.log(chalk.dim(`   Domain:         ${domain}`));
    console.log(chalk.dim(`   Cookies:        ${cookies.length}`));
    console.log(chalk.dim(`   Storage origins: ${state.origins.length}\n`));
}

async function markBlockersResolved(projectPath: string, statePath: string): Promise<void> {
    try {
        const { CodeGraphDB, SiteKnowledgeDB } = await import("@raiken/core");
        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
            const blockers = siteDb.getUnresolvedBlockers();
            for (const blocker of blockers) {
                if (blocker.id) {
                    siteDb.markBlockerResolved(blocker.id, statePath);
                }
            }
        } finally {
            db.close();
        }
    } catch {
        // Non-fatal — the saved storage state is the important artifact.
    }
}
