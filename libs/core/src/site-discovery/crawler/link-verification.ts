import type { SiteKnowledgeDB } from "../db";
import type { LinkStatus } from "../types";

/**
 * Every spelling a visited page answers to: the raw and normalized URLs,
 * trailing-slash variants, and index-file variants both ways (`/docs` ↔
 * `/docs/index.html`). normalizeUrl collapses index files, so without this a
 * link pointing at `/index.html` would stay "pending" forever once the crawl
 * records the page under `/`.
 */
function candidateUrls(url: string, normalizedUrl: string): Set<string> {
    const candidates = new Set<string>([url, normalizedUrl]);
    for (const base of [...candidates]) {
        if (base.endsWith("/")) {
            candidates.add(base.slice(0, -1));
        } else {
            candidates.add(`${base}/`);
        }
    }
    for (const base of [...candidates]) {
        if (base.endsWith("/")) {
            candidates.add(`${base}index.html`);
            candidates.add(`${base}index.htm`);
        }
        const indexMatch = /^(.*)\/index\.html?$/i.exec(base);
        if (indexMatch) {
            candidates.add(`${indexMatch[1]}/`);
        }
    }
    return candidates;
}

export function verifyPendingLinks(
    siteDb: SiteKnowledgeDB,
    url: string,
    normalizedUrl: string,
): number {
    let verified = 0;
    for (const candidate of candidateUrls(url, normalizedUrl)) {
        const pendingLinks = siteDb.getPendingLinksTo(candidate);
        for (const link of pendingLinks) {
            siteDb.updateLinkStatus(link.fromUrl, link.toUrl, "verified");
            verified++;
        }
    }
    return verified;
}

/**
 * End-of-run backstop: commit-time verification only reaches links saved
 * before their target page committed, so links discovered later that point
 * back at earlier pages stay "pending" without this sweep. Also heals
 * knowledge bases written before save-time verification existed.
 */
export function verifyLinksToCrawledPages(siteDb: SiteKnowledgeDB): number {
    let total = 0;
    for (const url of siteDb.getAllNormalizedUrls()) {
        total += verifyPendingLinks(siteDb, url, url);
    }
    return total;
}

export function markBrokenLinks(
    siteDb: SiteKnowledgeDB,
    url: string,
    normalizedUrl: string,
    errorMessage: string,
    status: LinkStatus = "broken",
): void {
    for (const candidate of candidateUrls(url, normalizedUrl)) {
        const pendingLinks = siteDb.getPendingLinksTo(candidate);
        for (const link of pendingLinks) {
            siteDb.updateLinkStatus(link.fromUrl, link.toUrl, status, errorMessage);
        }
    }
}
