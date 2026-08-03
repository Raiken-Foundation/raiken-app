/**
 * Cold-start gate for cover / oneshot: refuse to invent locators when the
 * project has no usable discovery pages. When a seed URL is known (Playwright
 * baseURL or webServer.url), auto-run a bounded `--skip-auth` discover first.
 */

import { getProjectApplication } from "../application/registry";
import { inspectAuthState, resolveAuthStorageStatePath } from "../config/auth-state";
import { validationError } from "../errors";
import { DiscoveryQueryService } from "../site-discovery/query-service";
import { readPlaywrightBaseURL, readPlaywrightWebServerUrl } from "../testing/playwright-config";

/** Pages / depth for the auto-discover that unblocks cold cover. */
export const BOUNDED_DISCOVER_MAX_PAGES = 20;
export const BOUNDED_DISCOVER_MAX_DEPTH = 2;

export interface EnsureSiteKnowledgeOptions {
    projectPath: string;
    /** Escape hatch: intentional scaffolds / offline dry-runs. */
    allowUngrounded?: boolean;
    /**
     * Set for scenarios that go behind a login. Signed-out pages satisfy the
     * cold-start gate but tell a post-login draft nothing, so when a usable
     * session exists we re-crawl with it rather than drafting from the
     * signed-out application.
     */
    needsAuthenticatedKnowledge?: boolean;
    onProgress?: (message: string) => void;
    /**
     * Injectable discover runner (tests). Default: blocking foreground crawl
     * with bounded limits, carrying a session when one is on disk.
     */
    runDiscover?: (seedUrl: string) => Promise<void>;
}

export type EnsureSiteKnowledgeResult =
    | {
          status: "ready";
          seedUrl?: string;
          discovered: boolean;
          /** A signed-in refresh ran because knowledge was signed-out only. */
          refreshedWithSession?: boolean;
      }
    | { status: "skipped"; reason: "allow_ungrounded" | "already_present" };

/** True when discovery has at least one crawled page on disk. */
export function hasUsableSiteKnowledge(projectPath: string): boolean {
    return readPageCounts(projectPath).pages > 0;
}

/**
 * True when at least one stored page was captured with a session loaded.
 *
 * The distinction matters because "an auth-state.json exists" says only that
 * someone logged in once, not that anything behind the login was ever looked
 * at — and drafting a post-login test from signed-out pages is exactly how a
 * draft ends up asserting UI that does not exist.
 */
export function hasAuthenticatedSiteKnowledge(projectPath: string): boolean {
    return readPageCounts(projectPath).authenticated > 0;
}

function readPageCounts(projectPath: string): { pages: number; authenticated: number } {
    try {
        const discovery = new DiscoveryQueryService(projectPath);
        try {
            const stats = discovery.getStats();
            return { pages: stats.pagesCount, authenticated: stats.authenticatedPagesCount };
        } finally {
            discovery.close();
        }
    } catch {
        return { pages: 0, authenticated: 0 };
    }
}

/** Path to a saved session that is present and unexpired, else null. */
export function resolveUsableSessionPath(projectPath: string): string | null {
    const resolved = resolveAuthStorageStatePath(projectPath);
    if (!resolved) return null;
    return inspectAuthState(resolved).status === "valid" ? resolved : null;
}

/**
 * Prefer Playwright `use.baseURL`, then `webServer.url` — both static-string
 * extractions so we never execute the config.
 */
export async function resolveDiscoverSeedUrl(projectPath: string): Promise<string | null> {
    const baseURL = await readPlaywrightBaseURL(projectPath).catch(() => null);
    if (baseURL?.trim()) return baseURL.trim();
    const webServerUrl = await readPlaywrightWebServerUrl(projectPath).catch(() => null);
    if (webServerUrl?.trim()) return webServerUrl.trim();
    return null;
}

export function siteKnowledgeRefuseMessage(seedHint?: string | null): string {
    const example = seedHint?.trim() || "http://localhost:3000";
    return (
        `No site knowledge. Run: raiken discover ${example} --skip-auth` +
        (seedHint?.trim()
            ? ""
            : " (set Playwright baseURL or webServer.url so cover can auto-discover)")
    );
}

/**
 * Bounded unattended crawl. `skipAuth` stays on even when a session is loaded:
 * it only suppresses *pausing* on a wall, and an automatic crawl has no user to
 * unblock it. With a valid session the protected pages simply load, so they are
 * crawled and recorded rather than skipped.
 */
export async function runBoundedDiscover(projectPath: string, seedUrl: string): Promise<void> {
    const app = getProjectApplication(projectPath);
    await app.discovery.runForeground({
        startUrl: seedUrl,
        overrides: {
            maxPages: BOUNDED_DISCOVER_MAX_PAGES,
            maxDepth: BOUNDED_DISCOVER_MAX_DEPTH,
            skipAuth: true,
        },
        resolveStorageState: true,
    });
}

/**
 * Ensure the project has usable discovery pages before drafting a test.
 * Throws {@link validationError} when knowledge is missing and cannot be
 * obtained (no seed URL, or auto-discover still left the DB empty).
 */
export async function ensureSiteKnowledge(
    options: EnsureSiteKnowledgeOptions,
): Promise<EnsureSiteKnowledgeResult> {
    const projectPath = options.projectPath;
    const progress = options.onProgress ?? (() => {});

    if (options.allowUngrounded) {
        return { status: "skipped", reason: "allow_ungrounded" };
    }

    const counts = readPageCounts(projectPath);
    if (counts.pages > 0) {
        const refreshed = await maybeRefreshWithSession(options, counts.authenticated);
        return refreshed ?? { status: "skipped", reason: "already_present" };
    }

    const seedUrl = await resolveDiscoverSeedUrl(projectPath);
    if (!seedUrl) {
        throw validationError(siteKnowledgeRefuseMessage(null), { code: "INVALID_INPUT" });
    }

    progress(`No site knowledge — running bounded discover on ${seedUrl} (--skip-auth)…`);
    const runDiscover =
        options.runDiscover ?? ((url: string) => runBoundedDiscover(projectPath, url));
    try {
        await runDiscover(seedUrl);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw validationError(
            `Auto-discover failed for ${seedUrl}: ${detail}. ` +
                `Fix the app/URL, then run: raiken discover ${seedUrl} --skip-auth`,
            { code: "INVALID_INPUT", cause: error },
        );
    }

    if (!hasUsableSiteKnowledge(projectPath)) {
        throw validationError(
            `Discover finished but recorded no pages at ${seedUrl}. ` +
                `Is the app running? Then: raiken discover ${seedUrl} --skip-auth`,
            { code: "INVALID_INPUT" },
        );
    }

    progress(`Discover recorded site knowledge from ${seedUrl}.`);
    return { status: "ready", seedUrl, discovered: true };
}

/**
 * The post-`raiken auth` hole: a session is saved, so the "no auth grounding"
 * warning goes quiet, but every page on record is still signed-out. Re-crawl
 * once with the session so the draft sees the real post-login pages.
 *
 * Never throws — the project already has usable knowledge, so a failed refresh
 * degrades to drafting from signed-out pages (which the draft assessment then
 * flags) rather than blocking cover outright.
 */
async function maybeRefreshWithSession(
    options: EnsureSiteKnowledgeOptions,
    authenticatedPages: number,
): Promise<EnsureSiteKnowledgeResult | null> {
    if (!options.needsAuthenticatedKnowledge || authenticatedPages > 0) return null;

    const projectPath = options.projectPath;
    if (!resolveUsableSessionPath(projectPath)) return null;

    const seedUrl = await resolveDiscoverSeedUrl(projectPath);
    if (!seedUrl) return null;

    const progress = options.onProgress ?? (() => {});
    progress(`Saved session found but no pages behind the login — re-discovering ${seedUrl}…`);
    try {
        const runDiscover =
            options.runDiscover ?? ((url: string) => runBoundedDiscover(projectPath, url));
        await runDiscover(seedUrl);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        progress(`Signed-in discover failed (${detail}) — drafting from signed-out pages.`);
        return { status: "ready", seedUrl, discovered: false, refreshedWithSession: false };
    }

    const refreshed = hasAuthenticatedSiteKnowledge(projectPath);
    progress(
        refreshed
            ? `Captured pages behind the login from ${seedUrl}.`
            : `Discover reached no pages behind the login at ${seedUrl} — the session may not apply to this app.`,
    );
    return { status: "ready", seedUrl, discovered: true, refreshedWithSession: refreshed };
}
