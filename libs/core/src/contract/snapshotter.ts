import { chromium } from "playwright";
import { extractPageForms } from "../site-discovery/crawler/form-extractor";
import type { SourceRoute } from "./routes";

/**
 * The route snapshotter: visit every known route and capture its snapshot +
 * forms into site knowledge — the same contract discovery writes, so cover,
 * minting, and knowledge all consume it identically.
 *
 * Unlike the link-following crawler there is no frontier to manage: the route
 * list IS the checklist, so coverage is honest — "14/16 routes captured"
 * names exactly what wasn't visited.
 */

export interface SnapshotRoute {
    path: string;
    source: string;
    dynamic?: boolean;
}

export interface SnapshotResult {
    captured: string[];
    failed: Array<{ route: string; reason: string }>;
    total: number;
    /** Route-checklist coverage: captured/total. */
    coverage: number;
}

export interface SnapshotterOptions {
    baseURL: string;
    routes: SnapshotRoute[];
    storageStatePath?: string | null;
    headless?: boolean;
    /** Save pages into discovered_pages via this callback (DB contract). */
    savePage: (page: {
        url: string;
        normalizedUrl: string;
        title: string;
        snapshotJson: string | null;
        formsJson: string | null;
        capturedAuthenticated: boolean;
        depth: number;
    }) => void;
    /** Skip dynamic routes ([param]) — no concrete URL to visit. */
    skipDynamic?: boolean;
}

export async function snapshotRoutes(options: SnapshotterOptions): Promise<SnapshotResult> {
    const routes = options.skipDynamic === false ? options.routes : options.routes.filter((r) => !r.dynamic);
    const result: SnapshotResult = { captured: [], failed: [], total: routes.length, coverage: 0 };
    if (routes.length === 0) return result;

    const browser = await chromium.launch({ headless: options.headless ?? true });
    try {
        for (const route of routes) {
            const context = await browser.newContext(
                options.storageStatePath ? { storageState: options.storageStatePath } : {},
            );
            const page = await context.newPage();
            const url = resolveRouteUrl(route.path, options.baseURL);
            try {
                await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
                try {
                    await page.waitForLoadState("networkidle", { timeout: 4000 });
                } catch {
                    // fine — SPA polling etc.
                }
                await page.waitForTimeout(300);

                let snapshotJson: string | null = null;
                try {
                    snapshotJson = await page.locator("body").ariaSnapshot();
                } catch {
                    // empty/odd pages may refuse the snapshot — record without it
                }
                const forms = await extractPageForms(page);
                const title = (await page.title().catch(() => "")) || route.path;

                options.savePage({
                    url,
                    normalizedUrl: url,
                    title,
                    snapshotJson,
                    formsJson: forms ? JSON.stringify(forms) : null,
                    capturedAuthenticated: Boolean(options.storageStatePath),
                    depth: 1,
                });
                result.captured.push(route.path);
            } catch (error) {
                result.failed.push({
                    route: route.path,
                    reason: error instanceof Error ? error.message : String(error),
                });
            } finally {
                await context.close().catch(() => undefined);
            }
        }
    } finally {
        await browser.close().catch(() => undefined);
    }
    result.coverage = result.total > 0 ? result.captured.length / result.total : 0;
    return result;
}

export function resolveRouteUrl(routePath: string, baseURL: string): string {
    const base = baseURL.replace(/\/$/, "");
    return base + (routePath.startsWith("/") ? routePath : `/${routePath}`);
}

/** Merge source-extracted routes with already-discovered URLs (hash routes). */
export function mergeKnownRoutes(
    sourceRoutes: SourceRoute[],
    discoveredUrls: string[],
    baseURL: string,
): SnapshotRoute[] {
    const byPath = new Map<string, SnapshotRoute>();
    for (const route of sourceRoutes) {
        byPath.set(route.path, { path: route.path, source: route.source, dynamic: route.dynamic });
    }
    for (const url of discoveredUrls) {
        try {
            const parsed = new URL(url);
            if (parsed.origin !== new URL(baseURL).origin) continue;
            const pathName = parsed.pathname + parsed.hash;
            if (!byPath.has(pathName)) {
                byPath.set(pathName, { path: pathName, source: "discovery" });
            }
        } catch {
            // unparseable — skip
        }
    }
    return Array.from(byPath.values());
}
