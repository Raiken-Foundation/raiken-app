/**
 * Site Knowledge Database Layer
 *
 * Provides persistence for site discovery data including pages, links, auth blockers, and sessions.
 */

import Database from "better-sqlite3";
import type {
    DiscoveredPage,
    DiscoveredLink,
    LinkStatus,
    AuthBlocker,
    DiscoverySession,
    SessionStatus,
} from "./types";

export class SiteKnowledgeDB {
    private db: Database.Database;
    private projectPath: string;

    constructor(db: Database.Database, projectPath: string) {
        this.db = db;
        this.projectPath = projectPath;
    }

    // ==========================================================================
    // Discovered Pages Operations
    // ==========================================================================

    /**
     * Save a discovered page to the database.
     */
    savePage(page: Omit<DiscoveredPage, "id">): number {
        const result = this.db
            .prepare(
                `
            INSERT OR REPLACE INTO discovered_pages (
                project_path, url, normalized_url, title, snapshot_json,
                parent_url, navigation_action, depth, discovered_at,
                last_visited_at, visit_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
            )
            .run(
                page.projectPath,
                page.url,
                page.normalizedUrl,
                page.title,
                page.snapshotJson,
                page.parentUrl,
                page.navigationAction,
                page.depth,
                page.discoveredAt,
                page.lastVisitedAt,
                page.visitCount
            );

        return Number(result.lastInsertRowid);
    }

    /**
     * Get a page by its URL.
     */
    getPage(url: string): DiscoveredPage | null {
        const normalizedUrl = this.normalizeUrl(url);
        const result = this.db
            .prepare(
                `
            SELECT * FROM discovered_pages
            WHERE project_path = ? AND normalized_url = ?
        `
            )
            .get(this.projectPath, normalizedUrl) as DiscoveredPage | undefined;

        return result || null;
    }

    /**
     * Get all pages for this project.
     */
    getAllPages(): DiscoveredPage[] {
        return this.db
            .prepare(
                `
            SELECT * FROM discovered_pages
            WHERE project_path = ?
            ORDER BY depth ASC, discovered_at ASC
        `
            )
            .all(this.projectPath) as DiscoveredPage[];
    }

    /**
     * Update page visit information.
     */
    updatePageVisit(url: string): void {
        const normalizedUrl = this.normalizeUrl(url);
        this.db
            .prepare(
                `
            UPDATE discovered_pages
            SET last_visited_at = ?, visit_count = visit_count + 1
            WHERE project_path = ? AND normalized_url = ?
        `
            )
            .run(Date.now(), this.projectPath, normalizedUrl);
    }

    /**
     * Get pages at a specific depth.
     */
    getPagesByDepth(depth: number): DiscoveredPage[] {
        return this.db
            .prepare(
                `
            SELECT * FROM discovered_pages
            WHERE project_path = ? AND depth = ?
            ORDER BY discovered_at ASC
        `
            )
            .all(this.projectPath, depth) as DiscoveredPage[];
    }

    /**
     * Get the count of discovered pages.
     */
    getPagesCount(): number {
        const result = this.db
            .prepare(
                `
            SELECT COUNT(*) as count FROM discovered_pages
            WHERE project_path = ?
        `
            )
            .get(this.projectPath) as { count: number };

        return result.count;
    }

    // ==========================================================================
    // Discovered Links Operations
    // ==========================================================================

    /**
     * Save a discovered link to the database.
     */
    saveLink(link: Omit<DiscoveredLink, "id">): void {
        this.db
            .prepare(
                `
            INSERT OR IGNORE INTO discovered_links (
                project_path, from_url, to_url, selector, link_text,
                element_role, status, error_message, discovered_at, verified_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
            )
            .run(
                link.projectPath,
                link.fromUrl,
                link.toUrl,
                link.selector,
                link.linkText,
                link.elementRole,
                link.status,
                link.errorMessage,
                link.discoveredAt,
                link.verifiedAt
            );
    }

    /**
     * Get all links from a specific page.
     */
    getLinksFrom(url: string): DiscoveredLink[] {
        return this.db
            .prepare(
                `
            SELECT * FROM discovered_links
            WHERE project_path = ? AND from_url = ?
            ORDER BY discovered_at ASC
        `
            )
            .all(this.projectPath, url) as DiscoveredLink[];
    }

    /**
     * Get all links with a specific status.
     */
    getLinksByStatus(status: LinkStatus): DiscoveredLink[] {
        return this.db
            .prepare(
                `
            SELECT * FROM discovered_links
            WHERE project_path = ? AND status = ?
            ORDER BY discovered_at ASC
        `
            )
            .all(this.projectPath, status) as DiscoveredLink[];
    }

    /**
     * Update link status.
     */
    updateLinkStatus(
        fromUrl: string,
        toUrl: string,
        status: LinkStatus,
        errorMessage?: string
    ): void {
        const verifiedAt = status === "verified" ? Date.now() : null;

        this.db
            .prepare(
                `
            UPDATE discovered_links
            SET status = ?, error_message = ?, verified_at = ?
            WHERE project_path = ? AND from_url = ? AND to_url = ?
        `
            )
            .run(
                status,
                errorMessage || null,
                verifiedAt,
                this.projectPath,
                fromUrl,
                toUrl
            );
    }

    /**
     * Get verified links (working navigation paths).
     */
    getVerifiedLinks(): DiscoveredLink[] {
        return this.getLinksByStatus("verified");
    }

    /**
     * Get broken links.
     */
    getBrokenLinks(): DiscoveredLink[] {
        return this.getLinksByStatus("broken");
    }

    /**
     * Get the count of discovered links.
     */
    getLinksCount(): number {
        const result = this.db
            .prepare(
                `
            SELECT COUNT(*) as count FROM discovered_links
            WHERE project_path = ?
        `
            )
            .get(this.projectPath) as { count: number };

        return result.count;
    }

    // ==========================================================================
    // Auth Blockers Operations
    // ==========================================================================

    /**
     * Save an auth blocker to the database.
     */
    saveAuthBlocker(blocker: Omit<AuthBlocker, "id">): number {
        const result = this.db
            .prepare(
                `
            INSERT INTO auth_blockers (
                project_path, url, blocker_type, detected_elements,
                resolved_at, storage_state_path, discovered_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
            )
            .run(
                blocker.projectPath,
                blocker.url,
                blocker.blockerType,
                blocker.detectedElements,
                blocker.resolvedAt,
                blocker.storageStatePath,
                blocker.discoveredAt
            );

        return Number(result.lastInsertRowid);
    }

    /**
     * Get all unresolved auth blockers for this project.
     */
    getUnresolvedBlockers(): AuthBlocker[] {
        return this.db
            .prepare(
                `
            SELECT * FROM auth_blockers
            WHERE project_path = ? AND resolved_at IS NULL
            ORDER BY discovered_at DESC
        `
            )
            .all(this.projectPath) as AuthBlocker[];
    }

    /**
     * Get all auth blockers (resolved and unresolved).
     */
    getAllBlockers(): AuthBlocker[] {
        return this.db
            .prepare(
                `
            SELECT * FROM auth_blockers
            WHERE project_path = ?
            ORDER BY discovered_at DESC
        `
            )
            .all(this.projectPath) as AuthBlocker[];
    }

    /**
     * Mark an auth blocker as resolved.
     */
    markBlockerResolved(id: number, storageStatePath: string): void {
        this.db
            .prepare(
                `
            UPDATE auth_blockers
            SET resolved_at = ?, storage_state_path = ?
            WHERE id = ?
        `
            )
            .run(Date.now(), storageStatePath, id);
    }

    /**
     * Check if a URL has an unresolved auth blocker.
     */
    hasAuthBlocker(url: string): boolean {
        const result = this.db
            .prepare(
                `
            SELECT 1 FROM auth_blockers
            WHERE project_path = ? AND url = ? AND resolved_at IS NULL
            LIMIT 1
        `
            )
            .get(this.projectPath, url);

        return result !== undefined;
    }

    // ==========================================================================
    // Discovery Sessions Operations
    // ==========================================================================

    /**
     * Save a new discovery session.
     */
    saveSession(session: Omit<DiscoverySession, "id">): number {
        const result = this.db
            .prepare(
                `
            INSERT INTO discovery_sessions (
                project_path, start_url, status, pages_discovered,
                links_found, started_at, completed_at, blocked_at_url, queue_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
            )
            .run(
                session.projectPath,
                session.startUrl,
                session.status,
                session.pagesDiscovered,
                session.linksFound,
                session.startedAt,
                session.completedAt,
                session.blockedAtUrl,
                session.queueJson
            );

        return Number(result.lastInsertRowid);
    }

    /**
     * Update an existing discovery session.
     */
    updateSession(id: number, updates: Partial<DiscoverySession>): void {
        const fields: string[] = [];
        const values: unknown[] = [];

        if (updates.status !== undefined) {
            fields.push("status = ?");
            values.push(updates.status);
        }
        if (updates.pagesDiscovered !== undefined) {
            fields.push("pages_discovered = ?");
            values.push(updates.pagesDiscovered);
        }
        if (updates.linksFound !== undefined) {
            fields.push("links_found = ?");
            values.push(updates.linksFound);
        }
        if (updates.completedAt !== undefined) {
            fields.push("completed_at = ?");
            values.push(updates.completedAt);
        }
        if (updates.blockedAtUrl !== undefined) {
            fields.push("blocked_at_url = ?");
            values.push(updates.blockedAtUrl);
        }
        if (updates.queueJson !== undefined) {
            fields.push("queue_json = ?");
            values.push(updates.queueJson);
        }

        if (fields.length === 0) return;

        values.push(id);
        const sql = `UPDATE discovery_sessions SET ${fields.join(", ")} WHERE id = ?`;

        this.db.prepare(sql).run(...values);
    }

    /**
     * Get the active (running or paused) session for this project.
     */
    getActiveSession(): DiscoverySession | null {
        const result = this.db
            .prepare(
                `
            SELECT * FROM discovery_sessions
            WHERE project_path = ? AND status IN ('running', 'paused')
            ORDER BY started_at DESC
            LIMIT 1
        `
            )
            .get(this.projectPath) as DiscoverySession | undefined;

        return result || null;
    }

    /**
     * Get a session by ID.
     */
    getSession(id: number): DiscoverySession | null {
        const result = this.db
            .prepare(
                `
            SELECT * FROM discovery_sessions
            WHERE id = ?
        `
            )
            .get(id) as DiscoverySession | undefined;

        return result || null;
    }

    /**
     * Get all sessions for this project.
     */
    getAllSessions(): DiscoverySession[] {
        return this.db
            .prepare(
                `
            SELECT * FROM discovery_sessions
            WHERE project_path = ?
            ORDER BY started_at DESC
        `
            )
            .all(this.projectPath) as DiscoverySession[];
    }

    /**
     * Get the most recent session (any status).
     */
    getLatestSession(): DiscoverySession | null {
        const result = this.db
            .prepare(
                `
            SELECT * FROM discovery_sessions
            WHERE project_path = ?
            ORDER BY started_at DESC
            LIMIT 1
        `
            )
            .get(this.projectPath) as DiscoverySession | undefined;

        return result || null;
    }

    // ==========================================================================
    // Utility Methods
    // ==========================================================================

    /**
     * Normalize URL for consistent comparison.
     * Removes trailing slashes, query parameters, and fragments.
     */
    private normalizeUrl(url: string): string {
        try {
            const parsed = new URL(url);
            // Remove trailing slash, query, and fragment
            let normalized = `${parsed.origin}${parsed.pathname}`;
            if (normalized.endsWith("/") && normalized !== `${parsed.origin}/`) {
                normalized = normalized.slice(0, -1);
            }
            return normalized;
        } catch {
            // If URL parsing fails, return as-is
            return url;
        }
    }

    /**
     * Clear all discovery data for this project.
     */
    clearDiscoveryData(): void {
        this.db.transaction(() => {
            this.db
                .prepare("DELETE FROM discovered_pages WHERE project_path = ?")
                .run(this.projectPath);
            this.db
                .prepare("DELETE FROM discovered_links WHERE project_path = ?")
                .run(this.projectPath);
            this.db
                .prepare("DELETE FROM auth_blockers WHERE project_path = ?")
                .run(this.projectPath);
            this.db
                .prepare("DELETE FROM discovery_sessions WHERE project_path = ?")
                .run(this.projectPath);
        })();
    }

    /**
     * Get discovery statistics.
     */
    getStats(): {
        pagesCount: number;
        linksCount: number;
        verifiedLinksCount: number;
        brokenLinksCount: number;
        authBlockersCount: number;
        unresolvedBlockersCount: number;
    } {
        const pagesCount = this.getPagesCount();
        const linksCount = this.getLinksCount();

        const verifiedCount = this.db
            .prepare(
                `
            SELECT COUNT(*) as count FROM discovered_links
            WHERE project_path = ? AND status = 'verified'
        `
            )
            .get(this.projectPath) as { count: number };

        const brokenCount = this.db
            .prepare(
                `
            SELECT COUNT(*) as count FROM discovered_links
            WHERE project_path = ? AND status = 'broken'
        `
            )
            .get(this.projectPath) as { count: number };

        const blockersCount = this.db
            .prepare(
                `
            SELECT COUNT(*) as count FROM auth_blockers
            WHERE project_path = ?
        `
            )
            .get(this.projectPath) as { count: number };

        const unresolvedBlockersCount = this.db
            .prepare(
                `
            SELECT COUNT(*) as count FROM auth_blockers
            WHERE project_path = ? AND resolved_at IS NULL
        `
            )
            .get(this.projectPath) as { count: number };

        return {
            pagesCount,
            linksCount,
            verifiedLinksCount: verifiedCount.count,
            brokenLinksCount: brokenCount.count,
            authBlockersCount: blockersCount.count,
            unresolvedBlockersCount: unresolvedBlockersCount.count,
        };
    }
}
