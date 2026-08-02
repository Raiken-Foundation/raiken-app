/**
 * Cold-start gate for cover / oneshot: refuse to invent locators when the
 * project has no usable discovery pages. When a seed URL is known (Playwright
 * baseURL or webServer.url), auto-run a bounded `--skip-auth` discover first.
 */

import { getProjectApplication } from "../application/registry";
import { validationError } from "../errors";
import { DiscoveryQueryService } from "../site-discovery/query-service";
import {
    readPlaywrightBaseURL,
    readPlaywrightWebServerUrl,
} from "../testing/playwright-config";

/** Pages / depth for the auto-discover that unblocks cold cover. */
export const BOUNDED_DISCOVER_MAX_PAGES = 20;
export const BOUNDED_DISCOVER_MAX_DEPTH = 2;

export interface EnsureSiteKnowledgeOptions {
    projectPath: string;
    /** Escape hatch: intentional scaffolds / offline dry-runs. */
    allowUngrounded?: boolean;
    onProgress?: (message: string) => void;
    /**
     * Injectable discover runner (tests). Default: blocking foreground crawl
     * with skipAuth + bounded limits.
     */
    runDiscover?: (seedUrl: string) => Promise<void>;
}

export type EnsureSiteKnowledgeResult =
    | { status: "ready"; seedUrl?: string; discovered: boolean }
    | { status: "skipped"; reason: "allow_ungrounded" | "already_present" };

/** True when discovery has at least one crawled page on disk. */
export function hasUsableSiteKnowledge(projectPath: string): boolean {
    try {
        const discovery = new DiscoveryQueryService(projectPath);
        try {
            return discovery.getStats().pagesCount > 0;
        } finally {
            discovery.close();
        }
    } catch {
        return false;
    }
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

async function defaultBoundedDiscover(projectPath: string, seedUrl: string): Promise<void> {
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

    if (hasUsableSiteKnowledge(projectPath)) {
        return { status: "skipped", reason: "already_present" };
    }

    const seedUrl = await resolveDiscoverSeedUrl(projectPath);
    if (!seedUrl) {
        throw validationError(siteKnowledgeRefuseMessage(null), { code: "INVALID_INPUT" });
    }

    progress(`No site knowledge — running bounded discover on ${seedUrl} (--skip-auth)…`);
    const runDiscover =
        options.runDiscover ?? ((url: string) => defaultBoundedDiscover(projectPath, url));
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
