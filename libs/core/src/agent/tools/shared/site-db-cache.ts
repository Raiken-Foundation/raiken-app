import { CodeGraphDB } from "../../../database/db";
import { SiteKnowledgeDB } from "../../../site-discovery/db";
import type { PageSnapshot } from "../types";

const MAX_SITE_DB_ENTRIES = 5;
const siteDbCache = new Map<
    string,
    { db: CodeGraphDB; siteDb: SiteKnowledgeDB; lastUsed: number }
>();

export function getSiteDb(projectPath: string): { db: CodeGraphDB; siteDb: SiteKnowledgeDB } {
    const cached = siteDbCache.get(projectPath);
    if (cached) {
        cached.lastUsed = Date.now();
        return cached;
    }

    if (siteDbCache.size >= MAX_SITE_DB_ENTRIES) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [key, entry] of siteDbCache) {
            if (entry.lastUsed < oldestTime) {
                oldestTime = entry.lastUsed;
                oldestKey = key;
            }
        }
        if (oldestKey) {
            const evicted = siteDbCache.get(oldestKey);
            siteDbCache.delete(oldestKey);
            try {
                evicted?.db.close();
            } catch {
                /* ignore */
            }
        }
    }

    const db = new CodeGraphDB(projectPath);
    const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
    siteDbCache.set(projectPath, { db, siteDb, lastUsed: Date.now() });
    return { db, siteDb };
}

export function closeSiteDbCache(): void {
    for (const [, entry] of siteDbCache) {
        try {
            entry.db.close();
        } catch {
            /* ignore */
        }
    }
    siteDbCache.clear();
}

process.once("SIGINT", closeSiteDbCache);
process.once("SIGTERM", closeSiteDbCache);
process.once("beforeExit", closeSiteDbCache);

export function persistPageDiscovery(
    projectPath: string,
    snapshot: PageSnapshot,
    parentUrl?: string,
): void {
    try {
        const { siteDb } = getSiteDb(projectPath);
        const now = Date.now();
        const existing = siteDb.getPage(snapshot.url);

        if (existing) {
            siteDb.updatePageContent(snapshot.url, {
                title: snapshot.title,
                snapshotJson: snapshot.summary,
                formsJson: null,
            });
            return;
        }

        let depth = 0;
        if (parentUrl) {
            try {
                const parent = siteDb.getPage(parentUrl);
                if (parent && typeof parent.depth === "number") {
                    depth = parent.depth + 1;
                }
            } catch {
                // Parent not in DB yet; treat as root.
            }
        }

        siteDb.savePage({
            projectPath,
            url: snapshot.url,
            normalizedUrl: snapshot.url,
            title: snapshot.title,
            snapshotJson: snapshot.summary,
            formsJson: null,
            parentUrl: parentUrl ?? null,
            navigationAction: null,
            depth,
            discoveredAt: now,
            lastVisitedAt: now,
            visitCount: 1,
        });
    } catch {
        // Non-critical: don't break the agent if persistence fails
    }
}

export function persistLinksDiscovery(
    projectPath: string,
    fromUrl: string,
    links: Array<{ text: string; href: string; suggestedSelectors?: string[] }>,
): void {
    try {
        const { siteDb } = getSiteDb(projectPath);
        const now = Date.now();

        for (const link of links) {
            const suggested = link.suggestedSelectors ?? [];
            const selector = suggested.find((s) => s && s.length > 0) ?? null;

            if (!selector) {
                continue;
            }

            siteDb.saveLink({
                projectPath,
                fromUrl,
                toUrl: link.href,
                selector,
                linkText: link.text || null,
                elementRole: "link",
                status: "pending",
                errorMessage: null,
                discoveredAt: now,
                verifiedAt: null,
            });
        }
    } catch {
        // Non-critical
    }
}
