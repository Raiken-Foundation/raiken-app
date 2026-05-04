/**
 * Site Knowledge Database Layer
 *
 * Provides persistence for site discovery data including pages, links, auth blockers, and sessions.
 */

import type Database from "better-sqlite3";
import type {
    AuthBlocker,
    AuthBlockerType,
    BlockerCategory,
    BlockerResolution,
    BlockerSeverity,
    DiscoveredLink,
    DiscoveredPage,
    DiscoveryBlocker,
    DiscoverySession,
    LinkStatus,
    SessionStatus,
} from "./types";
import { normalizeUrl } from "./url-utils";

/**
 * Legacy input shape for {@link SiteKnowledgeDB.saveAuthBlocker}, kept so
 * external scripts (and our own pre-blocker-pipeline tests) keep compiling.
 * Only the auth-specific fields are required; everything else on the
 * generalised {@link DiscoveryBlocker} is filled in by `saveAuthBlocker`.
 */
export interface LegacyAuthBlockerInput {
    projectPath: string;
    url: string;
    blockerType: AuthBlockerType;
    detectedElements?: string | null;
    resolvedAt?: number | null;
    storageStatePath?: string | null;
    discoveredAt: number;
}

/**
 * Map a `detectorId` like `"auth:login_form"` back to the legacy
 * `AuthBlockerType` string consumers (the old dashboard, knowledge-loader)
 * still read off `blockerType`. Defaults to `"login_form"` when the
 * detector id doesn't carry an auth-flavored suffix — safe because callers
 * only inspect `blockerType` for display.
 */
// Single source of truth for which detector-id suffixes round-trip cleanly
// to the legacy `AuthBlockerType` shape. Must include EVERY value in
// `AuthBlockerType` — drift here silently downgrades blockers on read
// (e.g. `auth:login_redirect` → "login_form" when this list is stale).
const LEGACY_AUTH_TYPES: readonly AuthBlockerType[] = [
    "url_pattern",
    "login_form",
    "oauth_button",
    "error_message",
    "http_status",
    "login_redirect",
];
const LEGACY_AUTH_TYPE_SET = new Set<string>(LEGACY_AUTH_TYPES);

function detectorIdToLegacyAuthType(
    detectorId: string | null,
    category: BlockerCategory,
): AuthBlockerType {
    if (detectorId && detectorId.includes(":")) {
        const suffix = detectorId.split(":", 2)[1];
        if (LEGACY_AUTH_TYPE_SET.has(suffix)) {
            return suffix as AuthBlockerType;
        }
    }
    return category === "auth_required" ? "login_form" : "error_message";
}

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
        const normalizedUrl = this.normalizeUrl(page.url);
        const result = this.db
            .prepare(
                `
            INSERT OR REPLACE INTO discovered_pages (
                project_path, url, normalized_url, title, snapshot_json,
                parent_url, navigation_action, depth, discovered_at,
                last_visited_at, visit_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
            )
            .run(
                page.projectPath,
                page.url,
                normalizedUrl,
                page.title,
                page.snapshotJson,
                page.parentUrl,
                page.navigationAction,
                page.depth,
                page.discoveredAt,
                page.lastVisitedAt,
                page.visitCount,
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
        `,
            )
            .get(this.projectPath, normalizedUrl) as Record<string, unknown> | undefined;

        return result ? this.mapPageRow(result) : null;
    }

    /**
     * Get all pages for this project.
     */
    getAllPages(): DiscoveredPage[] {
        const rows = this.db
            .prepare(
                `
            SELECT * FROM discovered_pages
            WHERE project_path = ?
            ORDER BY depth ASC, discovered_at ASC
        `,
            )
            .all(this.projectPath) as Array<Record<string, unknown>>;

        return rows.map((row) => this.mapPageRow(row));
    }

    /**
     * Get pages with SQL-level LIMIT/OFFSET pagination.
     */
    getPagesPaginated(limit: number, offset: number): DiscoveredPage[] {
        const rows = this.db
            .prepare(
                `
            SELECT * FROM discovered_pages
            WHERE project_path = ?
            ORDER BY depth ASC, discovered_at ASC
            LIMIT ? OFFSET ?
        `,
            )
            .all(this.projectPath, limit, offset) as Array<Record<string, unknown>>;

        return rows.map((row) => this.mapPageRow(row));
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
        `,
            )
            .run(Date.now(), this.projectPath, normalizedUrl);
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
        `,
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
        `,
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
                link.verifiedAt,
            );
    }

    /**
     * Get all links from a specific page.
     */
    getLinksFrom(url: string): DiscoveredLink[] {
        const rows = this.db
            .prepare(
                `
            SELECT * FROM discovered_links
            WHERE project_path = ? AND from_url = ?
            ORDER BY discovered_at ASC
        `,
            )
            .all(this.projectPath, url) as Array<Record<string, unknown>>;

        return rows.map((row) => this.mapLinkRow(row));
    }

    /**
     * Get pending links to a specific URL.
     */
    getPendingLinksTo(url: string): DiscoveredLink[] {
        const rows = this.db
            .prepare(
                `
            SELECT * FROM discovered_links
            WHERE project_path = ? AND to_url = ? AND status = 'pending'
            ORDER BY discovered_at ASC
        `,
            )
            .all(this.projectPath, url) as Array<Record<string, unknown>>;

        return rows.map((row) => this.mapLinkRow(row));
    }

    /**
     * Get all links with a specific status.
     */
    getLinksByStatus(status: LinkStatus): DiscoveredLink[] {
        const rows = this.db
            .prepare(
                `
            SELECT * FROM discovered_links
            WHERE project_path = ? AND status = ?
            ORDER BY discovered_at ASC
        `,
            )
            .all(this.projectPath, status) as Array<Record<string, unknown>>;

        return rows.map((row) => this.mapLinkRow(row));
    }

    /**
     * Update link status.
     */
    updateLinkStatus(
        fromUrl: string,
        toUrl: string,
        status: LinkStatus,
        errorMessage?: string,
    ): void {
        const verifiedAt = status === "verified" ? Date.now() : null;

        this.db
            .prepare(
                `
            UPDATE discovered_links
            SET status = ?, error_message = ?, verified_at = ?
            WHERE project_path = ? AND from_url = ? AND to_url = ?
        `,
            )
            .run(status, errorMessage || null, verifiedAt, this.projectPath, fromUrl, toUrl);
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
        `,
            )
            .get(this.projectPath) as { count: number };

        return result.count;
    }

    // ==========================================================================
    // Discovery Blockers Operations (generic — auth, captcha, manual, ...)
    // ==========================================================================

    /**
     * Save a generic discovery blocker. Used by detectors and by the
     * manual-pause path (`category: "manual"`).
     */
    saveBlocker(blocker: Omit<DiscoveryBlocker, "id">): number {
        const result = this.db
            .prepare(
                `
            INSERT INTO discovery_blockers (
                project_path, url, category, severity,
                detector_id, detected_elements, evidence_json,
                screenshot_path, resolution, resolved_via,
                resolved_at, storage_state_path, discovered_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
            )
            .run(
                blocker.projectPath,
                blocker.url,
                blocker.category,
                blocker.severity,
                blocker.detectorId,
                blocker.detectedElements,
                blocker.evidenceJson,
                blocker.screenshotPath,
                blocker.resolution,
                blocker.resolvedVia,
                blocker.resolvedAt,
                blocker.storageStatePath,
                blocker.discoveredAt,
            );

        return Number(result.lastInsertRowid);
    }

    /**
     * Back-compat wrapper. Old call sites pass an `AuthBlocker` and expect
     * the same return shape. We translate the legacy `blockerType` into the
     * new `category` + `detectorId` model.
     */
    saveAuthBlocker(blocker: LegacyAuthBlockerInput): number {
        return this.saveBlocker({
            projectPath: blocker.projectPath,
            url: blocker.url,
            category: "auth_required",
            severity: "pause",
            detectorId: `auth:${blocker.blockerType}`,
            detectedElements: blocker.detectedElements ?? null,
            evidenceJson: blocker.detectedElements ?? null,
            screenshotPath: null,
            resolution: blocker.resolvedAt ? "provide_state" : null,
            resolvedVia: blocker.resolvedAt ? "auth_command" : null,
            resolvedAt: blocker.resolvedAt ?? null,
            storageStatePath: blocker.storageStatePath ?? null,
            discoveredAt: blocker.discoveredAt,
        });
    }

    /**
     * Get all unresolved blockers for this project.
     */
    getUnresolvedBlockers(): DiscoveryBlocker[] {
        const rows = this.db
            .prepare(
                `
            SELECT * FROM discovery_blockers
            WHERE project_path = ? AND resolved_at IS NULL
            ORDER BY discovered_at DESC
        `,
            )
            .all(this.projectPath) as Array<Record<string, unknown>>;

        return rows.map((row) => this.mapBlockerRow(row));
    }

    /**
     * Get all blockers (resolved and unresolved).
     */
    getAllBlockers(): DiscoveryBlocker[] {
        const rows = this.db
            .prepare(
                `
            SELECT * FROM discovery_blockers
            WHERE project_path = ?
            ORDER BY discovered_at DESC
        `,
            )
            .all(this.projectPath) as Array<Record<string, unknown>>;

        return rows.map((row) => this.mapBlockerRow(row));
    }

    /**
     * Get a single blocker by id (for resolution flows that need to look up
     * a specific row, e.g. "skip the URL of blocker #42").
     */
    getBlocker(id: number): DiscoveryBlocker | null {
        const row = this.db.prepare(`SELECT * FROM discovery_blockers WHERE id = ?`).get(id) as
            | Record<string, unknown>
            | undefined;
        return row ? this.mapBlockerRow(row) : null;
    }

    /**
     * Mark a blocker resolved with a structured resolution.
     *
     * Overloaded for back-compat: the legacy 2-arg form
     *   `markBlockerResolved(id, storageStatePath)`
     * still works and is treated as a `provide_state` resolution.
     */
    markBlockerResolved(
        id: number,
        resolutionOrPath:
            | string
            | {
                  resolution: BlockerResolution;
                  resolvedVia?: string | null;
                  storageStatePath?: string | null;
              },
    ): void {
        const resolved =
            typeof resolutionOrPath === "string"
                ? {
                      resolution: "provide_state" as BlockerResolution,
                      resolvedVia: "legacy_storage_state",
                      storageStatePath: resolutionOrPath,
                  }
                : {
                      resolution: resolutionOrPath.resolution,
                      resolvedVia: resolutionOrPath.resolvedVia ?? null,
                      storageStatePath: resolutionOrPath.storageStatePath ?? null,
                  };

        this.db
            .prepare(
                `
            UPDATE discovery_blockers
            SET resolved_at = ?,
                resolution = ?,
                resolved_via = ?,
                storage_state_path = COALESCE(?, storage_state_path)
            WHERE id = ?
        `,
            )
            .run(
                Date.now(),
                resolved.resolution,
                resolved.resolvedVia,
                resolved.storageStatePath,
                id,
            );
    }

    /**
     * Mark every unresolved blocker for this project as resolved with the
     * same resolution. Used by `raiken auth` and the dashboard's
     * "I've handled it for everyone" affordance.
     */
    resolveAllBlockers(args: {
        resolution: BlockerResolution;
        resolvedVia?: string | null;
        storageStatePath?: string | null;
    }): number {
        const result = this.db
            .prepare(
                `
            UPDATE discovery_blockers
            SET resolved_at = ?,
                resolution = ?,
                resolved_via = ?,
                storage_state_path = COALESCE(?, storage_state_path)
            WHERE project_path = ? AND resolved_at IS NULL
        `,
            )
            .run(
                Date.now(),
                args.resolution,
                args.resolvedVia ?? null,
                args.storageStatePath ?? null,
                this.projectPath,
            );
        return result.changes;
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
                links_found, started_at, completed_at, blocked_at_url, queue_json,
                max_pages, max_depth, skipped_urls_json, ignored_categories_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
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
                session.queueJson,
                session.maxPages ?? null,
                session.maxDepth ?? null,
                session.skippedUrlsJson ?? null,
                session.ignoredCategoriesJson ?? null,
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
        if (updates.maxPages !== undefined) {
            fields.push("max_pages = ?");
            values.push(updates.maxPages);
        }
        if (updates.maxDepth !== undefined) {
            fields.push("max_depth = ?");
            values.push(updates.maxDepth);
        }
        if (updates.skippedUrlsJson !== undefined) {
            fields.push("skipped_urls_json = ?");
            values.push(updates.skippedUrlsJson);
        }
        if (updates.ignoredCategoriesJson !== undefined) {
            fields.push("ignored_categories_json = ?");
            values.push(updates.ignoredCategoriesJson);
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
        `,
            )
            .get(this.projectPath) as Record<string, unknown> | undefined;

        return result ? this.mapSessionRow(result as Record<string, unknown>) : null;
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
        `,
            )
            .get(id) as Record<string, unknown> | undefined;

        return result ? this.mapSessionRow(result as Record<string, unknown>) : null;
    }

    /**
     * Get all sessions for this project.
     */
    getAllSessions(): DiscoverySession[] {
        const rows = this.db
            .prepare(
                `
            SELECT * FROM discovery_sessions
            WHERE project_path = ?
            ORDER BY started_at DESC
        `,
            )
            .all(this.projectPath) as Array<Record<string, unknown>>;

        return rows.map((row) => this.mapSessionRow(row));
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
        `,
            )
            .get(this.projectPath) as Record<string, unknown> | undefined;

        return result ? this.mapSessionRow(result as Record<string, unknown>) : null;
    }

    private mapSessionRow(row: Record<string, unknown>): DiscoverySession {
        return {
            id: row["id"] as number | undefined,
            projectPath: row["project_path"] as string,
            startUrl: row["start_url"] as string,
            status: row["status"] as SessionStatus,
            pagesDiscovered: row["pages_discovered"] as number,
            linksFound: row["links_found"] as number,
            startedAt: row["started_at"] as number,
            completedAt: (row["completed_at"] as number | null) ?? null,
            blockedAtUrl: (row["blocked_at_url"] as string | null) ?? null,
            queueJson: (row["queue_json"] as string | null) ?? null,
            maxPages: (row["max_pages"] as number | null) ?? null,
            maxDepth: (row["max_depth"] as number | null) ?? null,
            skippedUrlsJson: (row["skipped_urls_json"] as string | null) ?? null,
            ignoredCategoriesJson: (row["ignored_categories_json"] as string | null) ?? null,
        };
    }

    private mapPageRow(row: Record<string, unknown>): DiscoveredPage {
        return {
            id: row["id"] as number | undefined,
            projectPath: row["project_path"] as string,
            url: row["url"] as string,
            normalizedUrl: row["normalized_url"] as string,
            title: (row["title"] as string | null) ?? null,
            snapshotJson: (row["snapshot_json"] as string | null) ?? null,
            parentUrl: (row["parent_url"] as string | null) ?? null,
            navigationAction: (row["navigation_action"] as string | null) ?? null,
            depth: row["depth"] as number,
            discoveredAt: row["discovered_at"] as number,
            lastVisitedAt: row["last_visited_at"] as number,
            visitCount: row["visit_count"] as number,
        };
    }

    private mapBlockerRow(row: Record<string, unknown>): AuthBlocker {
        const category = ((row["category"] as string | null) ?? "auth_required") as BlockerCategory;
        const detectorId = (row["detector_id"] as string | null) ?? null;
        return {
            id: row["id"] as number | undefined,
            projectPath: row["project_path"] as string,
            url: row["url"] as string,
            category,
            severity: ((row["severity"] as string | null) ?? "pause") as BlockerSeverity,
            detectorId,
            detectedElements: (row["detected_elements"] as string | null) ?? null,
            evidenceJson:
                (row["evidence_json"] as string | null) ??
                (row["detected_elements"] as string | null) ??
                null,
            screenshotPath: (row["screenshot_path"] as string | null) ?? null,
            resolution: (row["resolution"] as BlockerResolution | null) ?? null,
            resolvedVia: (row["resolved_via"] as string | null) ?? null,
            resolvedAt: (row["resolved_at"] as number | null) ?? null,
            storageStatePath: (row["storage_state_path"] as string | null) ?? null,
            discoveredAt: row["discovered_at"] as number,
            // Legacy alias — keep readable for `getAuthBlockers` consumers.
            blockerType: detectorIdToLegacyAuthType(detectorId, category),
        };
    }

    private mapLinkRow(row: Record<string, unknown>): DiscoveredLink {
        return {
            id: row["id"] as number | undefined,
            projectPath: row["project_path"] as string,
            fromUrl: row["from_url"] as string,
            toUrl: row["to_url"] as string,
            selector: row["selector"] as string,
            linkText: (row["link_text"] as string | null) ?? null,
            elementRole: (row["element_role"] as string | null) ?? null,
            status: row["status"] as LinkStatus,
            errorMessage: (row["error_message"] as string | null) ?? null,
            discoveredAt: row["discovered_at"] as number,
            verifiedAt: (row["verified_at"] as number | null) ?? null,
        };
    }

    /**
     * Mark sessions stuck as "running" (from a previous crash) as "failed".
     * Returns the number of sessions updated.
     */
    failStaleSessions(): number {
        const result = this.db
            .prepare(
                `
            UPDATE discovery_sessions
            SET status = 'failed', completed_at = ?
            WHERE project_path = ? AND status = 'running'
        `,
            )
            .run(Date.now(), this.projectPath);

        return result.changes;
    }

    // ==========================================================================
    // Utility Methods
    // ==========================================================================

    private normalizeUrl(url: string): string {
        return normalizeUrl(url);
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
                .prepare("DELETE FROM discovery_blockers WHERE project_path = ?")
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
        `,
            )
            .get(this.projectPath) as { count: number };

        const brokenCount = this.db
            .prepare(
                `
            SELECT COUNT(*) as count FROM discovered_links
            WHERE project_path = ? AND status = 'broken'
        `,
            )
            .get(this.projectPath) as { count: number };

        const blockersCount = this.db
            .prepare(
                `
            SELECT COUNT(*) as count FROM discovery_blockers
            WHERE project_path = ?
        `,
            )
            .get(this.projectPath) as { count: number };

        const unresolvedBlockersCount = this.db
            .prepare(
                `
            SELECT COUNT(*) as count FROM discovery_blockers
            WHERE project_path = ? AND resolved_at IS NULL
        `,
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
