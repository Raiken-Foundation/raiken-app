/**
 * Knowledge-base consistency invariants.
 *
 * The discovery crawler maintains several derived views of the same crawl
 * (page rows, link rows with verification status, session counters, session
 * blocked-at state). Each is written at a different point in the run, so a
 * write path that forgets one side of the pair leaves the knowledge base
 * permanently inconsistent — and every inconsistency so far has shown up as
 * confusing UX (links stuck "pending", completed sessions claiming to be
 * blocked, summaries disagreeing with detail views).
 *
 * These checks encode the invariants those bugs violated, so tests and
 * diagnostics can assert them directly after a crawl instead of rediscovering
 * each failure mode by hand.
 */

import type { SiteKnowledgeDB } from "./db";
import { normalizeUrl } from "./url-utils";

export interface KnowledgeConsistencyReport {
    ok: boolean;
    violations: string[];
}

export function validateKnowledgeConsistency(siteDb: SiteKnowledgeDB): KnowledgeConsistencyReport {
    const violations: string[] = [];

    // A "pending" link means "we have not confirmed where this leads". Once
    // the target page is stored, the link is verified by definition — the two
    // facts must never coexist.
    const pageKeys = new Set<string>();
    for (const url of siteDb.getAllNormalizedUrls()) {
        pageKeys.add(url);
        pageKeys.add(url.replace(/\/$/, ""));
    }
    const stalePending = siteDb
        .getLinksByStatus("pending")
        .filter(
            (link) =>
                pageKeys.has(link.toUrl) ||
                pageKeys.has(link.toUrl.replace(/\/$/, "")) ||
                pageKeys.has(normalizeUrl(link.toUrl)),
        );
    if (stalePending.length > 0) {
        const sample = stalePending
            .slice(0, 3)
            .map((link) => link.toUrl)
            .join(", ");
        violations.push(
            `${stalePending.length} link(s) are "pending" although their target page is stored ` +
                `(e.g. ${sample}). The run should verify these at save time or in the ` +
                `end-of-run sweep.`,
        );
    }

    // blocked_at_url describes where a PAUSED session stopped. On a terminal
    // session it is residue that makes completed runs look blocked.
    const staleBlocked = siteDb.getTerminalSessionsWithBlockedUrl();
    if (staleBlocked.length > 0) {
        violations.push(
            `${staleBlocked.length} completed/failed session(s) still have blocked_at_url set ` +
                `(e.g. ${staleBlocked[0]?.blockedAtUrl}). Terminal session writes must clear it.`,
        );
    }

    // Session counters summarize rows the same session committed; claiming
    // more than the table holds means the counters drifted from persistence.
    const latest = siteDb.getLatestSession();
    if (latest) {
        const pagesStored = siteDb.getPagesCount();
        const linksStored = siteDb.getLinksCount();
        if (latest.pagesDiscovered > pagesStored) {
            violations.push(
                `Latest session claims ${latest.pagesDiscovered} pages discovered but only ` +
                    `${pagesStored} page row(s) are stored.`,
            );
        }
        if (latest.linksFound > linksStored) {
            violations.push(
                `Latest session claims ${latest.linksFound} links found but only ` +
                    `${linksStored} link row(s) are stored.`,
            );
        }
    }

    return { ok: violations.length === 0, violations };
}
