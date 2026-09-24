import { loadDiscoveryConfig } from "../../config/load";
import { CodeGraphDB } from "../../database/db";
import { SiteKnowledgeDB } from "../../site-discovery/db";
import { getDiscoveryQueryService } from "../discovery-query-cache";
import { toIsoDate } from "./state";
import { DEFAULT_AUTH_ASSIST, EMPTY_STATS } from "./types";

/** Read-model facade over cached DiscoveryQueryService — no job lifecycle. */
export class DiscoveryReadModel {
    constructor(private readonly projectPath: string) {}

    private query() {
        return getDiscoveryQueryService(this.projectPath);
    }

    getStats() {
        try {
            return this.query().getStats();
        } catch {
            return { ...EMPTY_STATS };
        }
    }

    getSessionView(): {
        id: number | undefined;
        startUrl: string;
        status: string;
        pagesDiscovered: number;
        linksFound: number;
        startedAt: string | null;
        completedAt: string | null;
        blockedAtUrl: string | null;
    } | null {
        try {
            const session = this.query().getLatestSession();
            if (!session) return null;
            return {
                id: session.id,
                startUrl: session.startUrl,
                status: session.status,
                pagesDiscovered: session.pagesDiscovered,
                linksFound: session.linksFound,
                startedAt: toIsoDate(session.startedAt),
                completedAt: toIsoDate(session.completedAt),
                blockedAtUrl: session.blockedAtUrl,
            };
        } catch {
            return null;
        }
    }

    getAuthAssist() {
        try {
            return this.query().getAuthAssist();
        } catch {
            return { ...DEFAULT_AUTH_ASSIST };
        }
    }

    listDiscoveredPages(input: { limit?: number; offset?: number }) {
        try {
            const result = this.query().listPages({
                limit: input.limit,
                offset: input.offset,
            });
            return {
                pages: result.pages.map((page) => ({
                    url: page.url,
                    title: page.title,
                    depth: page.depth,
                    visitCount: page.visitCount,
                    parentUrl: page.parentUrl,
                    discoveredAt: toIsoDate(page.discoveredAt),
                    lastVisitedAt: toIsoDate(page.lastVisitedAt),
                })),
                total: result.total,
                hasMore: result.hasMore,
            };
        } catch {
            return { pages: [], total: 0, hasMore: false };
        }
    }

    getDiscoveredPageSnapshot(url: string) {
        try {
            const page = this.query().getPageSnapshot(url);
            if (!page) return null;
            return {
                url: page.url,
                normalizedUrl: page.normalizedUrl,
                title: page.title,
                snapshotJson: page.snapshotJson,
                depth: page.depth,
                discoveredAt: toIsoDate(page.discoveredAt),
                lastVisitedAt: toIsoDate(page.lastVisitedAt),
            };
        } catch {
            return null;
        }
    }

    getAuthBlockers() {
        try {
            const blockers = this.query().getUnresolvedBlockers();
            return {
                blockers: blockers.map((blocker) => ({
                    id: blocker.id,
                    url: blocker.url,
                    blockerType: blocker.blockerType,
                    category: blocker.category,
                    severity: blocker.severity,
                    detectorId: blocker.detectorId,
                    evidenceJson: blocker.evidenceJson,
                    screenshotPath: blocker.screenshotPath,
                    discoveredAt: toIsoDate(blocker.discoveredAt),
                })),
                total: blockers.length,
            };
        } catch {
            return { blockers: [], total: 0 };
        }
    }

    getVerifiedLinks(limit: number): {
        verifiedLinks: Array<{
            fromUrl: string;
            toUrl: string;
            selector: string | null;
            linkText: string | null;
            elementRole: string | null;
        }>;
        brokenLinks: Array<{
            fromUrl: string;
            toUrl: string;
            selector: string | null;
            errorMessage: string | null;
        }>;
        verifiedCount: number;
        brokenCount: number;
    } {
        const db = new CodeGraphDB(this.projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(
                db.getRawDatabase(),
                this.projectPath,
                loadDiscoveryConfig(this.projectPath).preserveQueryParams,
            );
            const verified = siteDb.getVerifiedLinks();
            const broken = siteDb.getBrokenLinks();
            return {
                verifiedLinks: verified.slice(0, limit).map((link) => ({
                    fromUrl: link.fromUrl,
                    toUrl: link.toUrl,
                    selector: link.selector,
                    linkText: link.linkText,
                    elementRole: link.elementRole,
                })),
                brokenLinks: broken.slice(0, limit).map((link) => ({
                    fromUrl: link.fromUrl,
                    toUrl: link.toUrl,
                    selector: link.selector,
                    errorMessage: link.errorMessage,
                })),
                verifiedCount: verified.length,
                brokenCount: broken.length,
            };
        } catch {
            return {
                verifiedLinks: [],
                brokenLinks: [],
                verifiedCount: 0,
                brokenCount: 0,
            };
        } finally {
            db.close();
        }
    }
}
