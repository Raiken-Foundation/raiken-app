import { CodeGraphDB } from "../database/db";
import { SiteKnowledgeDB } from "./db";
import type { AuthBlocker, DiscoveredPage, DiscoverySession } from "./types";

export interface SiteKnowledgeStats {
    pagesCount: number;
    linksCount: number;
    verifiedLinksCount: number;
    brokenLinksCount: number;
    authBlockersCount: number;
    unresolvedBlockersCount: number;
}

export interface DiscoveryOverview {
    stats: SiteKnowledgeStats;
    latestSession: DiscoverySession | null;
    unresolvedBlockers: AuthBlocker[];
}

export interface DiscoveryPageList {
    pages: DiscoveredPage[];
    total: number;
    hasMore: boolean;
    limit: number;
    offset: number;
}

export interface DiscoveryAuthAssist {
    hasUnresolvedBlockers: boolean;
    unresolvedCount: number;
    suggestedUrl: string | null;
    command: string;
    message: string;
}

function toPositiveInt(value: number | undefined, fallback: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    const normalized = Math.trunc(value);
    if (normalized < 0) {
        return fallback;
    }
    return Math.min(normalized, max);
}

function toNonNegativeInt(value: number | undefined, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    const normalized = Math.trunc(value);
    if (normalized < 0) {
        return fallback;
    }
    return normalized;
}

export class DiscoveryQueryService {
    private readonly projectPath: string;
    private db: CodeGraphDB | null = null;
    private siteDb: SiteKnowledgeDB | null = null;

    constructor(projectPath: string) {
        this.projectPath = projectPath;
    }

    getOverview(): DiscoveryOverview {
        const siteDb = this.getSiteDb();
        return {
            stats: siteDb.getStats(),
            latestSession: siteDb.getLatestSession(),
            unresolvedBlockers: siteDb.getUnresolvedBlockers(),
        };
    }

    getStats(): SiteKnowledgeStats {
        return this.getSiteDb().getStats();
    }

    getLatestSession(): DiscoverySession | null {
        return this.getSiteDb().getLatestSession();
    }

    getUnresolvedBlockers(): AuthBlocker[] {
        return this.getSiteDb().getUnresolvedBlockers();
    }

    listPages(options?: { limit?: number; offset?: number }): DiscoveryPageList {
        const limit = toPositiveInt(options?.limit, 50, 500);
        const offset = toNonNegativeInt(options?.offset, 0);
        const siteDb = this.getSiteDb();
        const total = siteDb.getPagesCount();
        const pages = siteDb.getPagesPaginated(limit, offset);
        return {
            pages,
            total,
            hasMore: offset + pages.length < total,
            limit,
            offset,
        };
    }

    getPageSnapshot(url: string): DiscoveredPage | null {
        return this.getSiteDb().getPage(url);
    }

    getAuthAssist(): DiscoveryAuthAssist {
        const siteDb = this.getSiteDb();
        const blockers = siteDb.getUnresolvedBlockers();
        const latestSession = siteDb.getLatestSession();
        const suggestedUrl =
            latestSession?.blockedAtUrl ?? blockers[0]?.url ?? latestSession?.startUrl ?? null;
        const command = suggestedUrl
            ? `raiken auth --url ${suggestedUrl}`
            : "raiken auth --url <login-url>";
        return {
            hasUnresolvedBlockers: blockers.length > 0,
            unresolvedCount: blockers.length,
            suggestedUrl,
            command,
            message:
                blockers.length > 0
                    ? "Authentication is required to continue discovery. Run the command and sign in."
                    : "No unresolved auth blockers detected.",
        };
    }

    /**
     * Mark any sessions stuck as "running" (from a previous crash) as "failed".
     */
    recoverStaleSessions(): number {
        const siteDb = this.getSiteDb();
        return siteDb.failStaleSessions();
    }

    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.siteDb = null;
        }
    }

    private getSiteDb(): SiteKnowledgeDB {
        if (!this.siteDb) {
            this.db = new CodeGraphDB(this.projectPath);
            this.siteDb = new SiteKnowledgeDB(this.db.getRawDatabase(), this.projectPath);
        }
        return this.siteDb;
    }
}
