/**
 * Manual browser handoff
 *
 * Generalised "open a real Chromium window at this URL, let the user do
 * whatever they need to do (log in, solve a captcha, click through a
 * cookie banner, etc.), then snapshot the resulting cookies + localStorage
 * and resume the headless crawl with that state".
 *
 * This is the dashboard-side equivalent of `raiken auth`. The CLI's
 * `authCommand` keeps its bespoke spinner / readline UX so the terminal
 * flow stays identical, but both code paths converge on this helper for
 * the actual launch + watch + snapshot logic so the two stay in sync.
 *
 * Why "manual" rather than "auth": auth is just one of many things a human
 * might need to do in a browser (consent banners, captchas, "I'm 18+"
 * gates, ...). The helper has no opinion about *what* the user does; it
 * just watches for the storage state to materially change and snapshots
 * it. That makes the same code reusable for any blocker category that
 * the user can clear by interacting with the page.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";

import { CodeGraphDB } from "../database/db";
import { SiteKnowledgeDB } from "./db";
import { looksLikeLoginUrl } from "./detectors/auth";
import type { BlockerResolution, DiscoveryBlocker } from "./types";

// Tunables. Mirror `apps/cli/src/commands/auth.ts` so the two surfaces
// behave identically — they only diverge in user-feedback (terminal
// spinner vs. dashboard event stream).
const POLL_INTERVAL_MS = 1500;
const STABILITY_POLLS = 2;
const DEFAULT_HANDOFF_TIMEOUT_MS = 5 * 60 * 1000;

export interface ManualHandoffOptions {
    /** Project root — controls where `auth-state.json` is written. */
    projectPath: string;
    /** Where to navigate the new window. Required: handoff at an unknown URL is meaningless. */
    url: string;
    /** Override the destination path; defaults to `<projectPath>/.raiken/auth-state.json`. */
    storageStatePath?: string;
    /** Override the auto-save timeout (ms). Defaults to 5 minutes. */
    timeoutMs?: number;
    /**
     * If provided, this blocker (and any other unresolved auth-category
     * blocker for the project) gets marked resolved with
     * `{ resolution: "handoff" }` once the snapshot is saved.
     */
    blockerId?: number | null;
    /**
     * Optional category to record on the resolution. Defaults to whatever
     * the targeted blocker carries, or `"auth_required"` if no id given —
     * keeps `auth_state.json` semantically a *credentials* artifact even
     * when triggered by a captcha pause.
     */
    category?: DiscoveryBlocker["category"];
    /** Chromium launch flag. Almost always `false` for a real handoff. */
    headless?: boolean;
    /**
     * Per-poll callback so the caller can stream "still waiting…" updates
     * into the discovery timeline. Receives the current cookie/origin
     * counts and the page URL so the dashboard can show progress.
     */
    onProgress?: (snapshot: ManualHandoffProgress) => void;
}

export interface ManualHandoffProgress {
    cookies: number;
    origins: number;
    url: string;
    /** "auto" the loop converged, "browser-closed" the user closed the window. */
    reason?: "auto" | "browser-closed" | "timeout";
}

export interface ManualHandoffResult {
    /** Where the snapshot was written. */
    storageStatePath: string;
    cookies: number;
    origins: number;
    /** How the loop terminated. */
    reason: "auto" | "browser-closed" | "timeout";
    /** Number of blockers we marked resolved with `resolution: "handoff"`. */
    blockersResolved: number;
}

interface StorageBaseline {
    cookieKeys: Set<string>;
    originKeys: Set<string>;
    initialUrl: string;
}

/**
 * Open a headful browser at `options.url`, watch for the user to clear
 * whatever blocker is in the way, snapshot the cookies + localStorage to
 * `auth-state.json`, mark blockers resolved, return.
 */
export async function runManualHandoff(
    options: ManualHandoffOptions,
): Promise<ManualHandoffResult> {
    const projectPath = options.projectPath;
    // Resolution order:
    //   1. Explicit `options.storageStatePath` (router.ts resolves this from
    //      `auth.storageStatePath` in raiken.config.json before calling us).
    //   2. Local config-aware default — re-implemented inline because
    //      `libs/core` can't depend on `libs/shared` (shared depends on core,
    //      so the import would be cyclic). The duplication is small (10 lines)
    //      and worth it to keep direct callers (e.g. tests) honouring config.
    //   3. `.raiken/auth-state.json` legacy fallback.
    const storageStatePath =
        options.storageStatePath ?? resolveDefaultStorageStatePath(projectPath);
    const storageStateDir = path.dirname(storageStatePath);
    const timeoutMs = options.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS;
    const headless = options.headless ?? false;

    if (!fs.existsSync(storageStateDir)) {
        fs.mkdirSync(storageStateDir, { recursive: true });
    }

    const chromium = loadChromium();
    const browser: Browser = await chromium.launch({
        headless,
        args: headless ? [] : ["--start-maximized"],
    });
    const context: BrowserContext = await browser.newContext({ viewport: null });
    const page: Page = await context.newPage();

    if (options.url && options.url !== "about:blank") {
        try {
            await page.goto(options.url, { waitUntil: "domcontentloaded" });
        } catch {
            // Continue anyway — the handoff might still succeed if the
            // page partially loads or the user navigates manually.
        }
    }

    const baseline = await captureBaseline(context, page);

    let reason: ManualHandoffResult["reason"] = "auto";
    let aborted = false;

    const browserClosed = new Promise<void>((resolve) => {
        browser.once("disconnected", () => {
            reason = "browser-closed";
            resolve();
        });
    });

    const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
            reason = "timeout";
            resolve();
        }, timeoutMs).unref?.();
    });

    const detectPromise = (async () => {
        let stableHits = 0;
        let lastSnapshot: string | null = null;

        while (!aborted) {
            await delay(POLL_INTERVAL_MS);
            if (aborted) return;

            let storageState: Awaited<ReturnType<typeof context.storageState>>;
            try {
                storageState = await context.storageState();
            } catch {
                return;
            }

            const currentUrl = safePageUrl(page);
            options.onProgress?.({
                cookies: storageState.cookies.length,
                origins: storageState.origins.length,
                url: currentUrl,
            });

            const detected = detectChange(baseline, storageState, currentUrl);
            const snapshot = snapshotKey(storageState, currentUrl);
            if (detected) {
                if (lastSnapshot === snapshot) {
                    stableHits += 1;
                } else {
                    stableHits = 1;
                }
                lastSnapshot = snapshot;
                if (stableHits >= STABILITY_POLLS) {
                    reason = "auto";
                    return;
                }
            } else {
                stableHits = 0;
                lastSnapshot = snapshot;
            }
        }
    })();

    await Promise.race([detectPromise, browserClosed, timeoutPromise]);
    aborted = true;

    let storageState: Awaited<ReturnType<typeof context.storageState>> | null = null;
    try {
        storageState = await context.storageState();
    } catch {
        storageState = null;
    }

    try {
        await browser.close();
    } catch {
        // already closed
    }

    if (!storageState) {
        return {
            storageStatePath,
            cookies: 0,
            origins: 0,
            reason,
            blockersResolved: 0,
        };
    }

    fs.writeFileSync(storageStatePath, JSON.stringify(storageState, null, 2));

    const blockersResolved = markBlockersResolved(projectPath, {
        storageStatePath,
        blockerId: options.blockerId ?? null,
        category: options.category ?? "auth_required",
        resolvedVia: "dashboard_handoff",
    });

    options.onProgress?.({
        cookies: storageState.cookies.length,
        origins: storageState.origins.length,
        url: safePageUrl(page),
        reason,
    });

    return {
        storageStatePath,
        cookies: storageState.cookies.length,
        origins: storageState.origins.length,
        reason,
        blockersResolved,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadChromium(): typeof import("playwright").chromium {
    try {
        return require("playwright").chromium;
    } catch {
        try {
            return require("playwright-core").chromium;
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Playwright is not installed. Install it with \`npx playwright install\`. (${detail})`,
            );
        }
    }
}

async function captureBaseline(context: BrowserContext, page: Page): Promise<StorageBaseline> {
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

function detectChange(
    baseline: StorageBaseline,
    state: Awaited<ReturnType<BrowserContext["storageState"]>>,
    currentUrl: string,
): boolean {
    const newCookie = state.cookies.some((c) => !baseline.cookieKeys.has(cookieKey(c)));
    const newOrigin = state.origins
        .flatMap(originEntries)
        .some((entry) => !baseline.originKeys.has(entry));
    if (newCookie || newOrigin) return true;
    const initialIsLogin = isLoginOrPreNavigation(baseline.initialUrl);
    if (initialIsLogin && currentUrl && !isLoginOrPreNavigation(currentUrl)) return true;
    return false;
}

function snapshotKey(
    state: Awaited<ReturnType<BrowserContext["storageState"]>>,
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
 * the session changed. The detector's predicate handles every real URL
 * we'll encounter; this thin wrapper just adds the bootstrap-state case.
 */
function isLoginOrPreNavigation(url: string): boolean {
    if (!url || url === "about:blank") return true;
    return looksLikeLoginUrl(url);
}

function safePageUrl(page: Page): string {
    try {
        return page.url();
    } catch {
        return "";
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function markBlockersResolved(
    projectPath: string,
    args: {
        storageStatePath: string;
        blockerId: number | null;
        category: DiscoveryBlocker["category"];
        resolvedVia: string;
    },
): number {
    try {
        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
            const resolution: BlockerResolution = "handoff";

            // Resolve the targeted blocker first if specified.
            if (args.blockerId) {
                siteDb.markBlockerResolved(args.blockerId, {
                    resolution,
                    resolvedVia: args.resolvedVia,
                    storageStatePath: args.storageStatePath,
                });
            }

            // Sweep all unresolved auth blockers — the storage state is the
            // shared resolution artifact. We DON'T sweep manual blockers
            // (the user explicitly paused) or non-auth detector blockers
            // (a captcha resolution doesn't necessarily fix every other
            // captcha route).
            const all = siteDb.getUnresolvedBlockers();
            let resolved = args.blockerId ? 1 : 0;
            for (const b of all) {
                if (b.id === args.blockerId) continue;
                if (b.category === "auth_required" || b.category === args.category) {
                    if (b.id) {
                        siteDb.markBlockerResolved(b.id, {
                            resolution,
                            resolvedVia: args.resolvedVia,
                            storageStatePath: args.storageStatePath,
                        });
                        resolved += 1;
                    }
                }
            }
            return resolved;
        } finally {
            db.close();
        }
    } catch {
        // Best-effort — the saved storage state is the important artifact.
        return 0;
    }
}

/**
 * Read `auth.storageStatePath` directly from `raiken.config.json` and
 * resolve it (relative paths are resolved against `projectPath`). Falls
 * back to `.raiken/auth-state.json` when the config is missing, the
 * file is unparseable, or the field is empty.
 *
 * Mirror of `resolveAuthStorageStateDestination` in `libs/shared` —
 * duplicated intentionally because `libs/core` cannot depend on
 * `libs/shared` (the dependency graph runs the other way). Production
 * callers (router.ts, raiken auth) resolve via the shared helper and
 * pass an explicit `storageStatePath`, so this fallback is only hit by
 * direct callers (tests, third-party scripts).
 */
function resolveDefaultStorageStatePath(projectPath: string): string {
    try {
        const configPath = path.join(projectPath, "raiken.config.json");
        const raw = fs.readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw) as { auth?: { storageStatePath?: string } };
        const configured = parsed.auth?.storageStatePath;
        if (typeof configured === "string" && configured.length > 0) {
            return path.isAbsolute(configured) ? configured : path.join(projectPath, configured);
        }
    } catch {
        // config missing or invalid — fall through to legacy default
    }
    return path.join(projectPath, ".raiken", "auth-state.json");
}
