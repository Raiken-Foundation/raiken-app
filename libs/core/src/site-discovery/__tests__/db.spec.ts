/**
 * Site Discovery Database Tests
 *
 * Coverage focuses on the v6 generic-blocker schema (`discovery_blockers`)
 * and the resolution metadata that backs the dashboard's BlockerPanel.
 * Includes a migration test that seeds a v5-shape `auth_blockers` table
 * and verifies the v6 migration copies every row over with the right
 * defaults.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodeGraphDB } from "../../database/db";
import { SiteKnowledgeDB } from "../db";
import type { AuthBlocker } from "../types";

describe("SiteKnowledgeDB", () => {
    let testDir: string;
    let db: CodeGraphDB;
    let siteDb: SiteKnowledgeDB;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-test-"));
        db = new CodeGraphDB(testDir);
        siteDb = new SiteKnowledgeDB(db.getRawDatabase(), testDir);
    });

    afterEach(() => {
        db.close();
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe("Database Schema", () => {
        it("creates the v6 discovery tables (discovery_blockers replaces auth_blockers)", () => {
            const tables = db.getTables();
            const tableNames = tables.map((t) => t.name);

            expect(tableNames).toContain("discovered_pages");
            expect(tableNames).toContain("discovered_links");
            expect(tableNames).toContain("discovery_blockers");
            expect(tableNames).toContain("discovery_sessions");
            // The legacy auth_blockers table is dropped by migrateToV6.
            expect(tableNames).not.toContain("auth_blockers");
        });

        it("exposes the new generic columns on discovery_blockers", () => {
            const cols = db
                .getRawDatabase()
                .prepare("PRAGMA table_info(discovery_blockers)")
                .all() as Array<{ name: string }>;
            const names = new Set(cols.map((c) => c.name));
            for (const col of [
                "category",
                "severity",
                "detector_id",
                "evidence_json",
                "screenshot_path",
                "resolution",
                "resolved_via",
                "storage_state_path",
            ]) {
                expect(names.has(col)).toBe(true);
            }
        });

        it("adds skipped_urls_json and ignored_categories_json to discovery_sessions", () => {
            const cols = db
                .getRawDatabase()
                .prepare("PRAGMA table_info(discovery_sessions)")
                .all() as Array<{ name: string }>;
            const names = new Set(cols.map((c) => c.name));
            expect(names.has("skipped_urls_json")).toBe(true);
            expect(names.has("ignored_categories_json")).toBe(true);
        });
    });

    describe("Page Operations", () => {
        it("saves and retrieves a page", () => {
            const pageId = siteDb.savePage({
                projectPath: testDir,
                url: "http://localhost:3000",
                normalizedUrl: "http://localhost:3000",
                title: "Test Page",
                snapshotJson: null,
                formsJson: null,
                parentUrl: null,
                navigationAction: null,
                depth: 0,
                discoveredAt: Date.now(),
                lastVisitedAt: Date.now(),
                visitCount: 1,
            });
            expect(pageId).toBeGreaterThan(0);

            const retrieved = siteDb.getPage("http://localhost:3000");
            expect(retrieved?.title).toBe("Test Page");
            expect(retrieved?.depth).toBe(0);
        });

        it("updatePageContent refreshes title/snapshot/forms and bumps visit metadata", () => {
            siteDb.savePage({
                projectPath: testDir,
                url: "http://localhost:3000",
                normalizedUrl: "http://localhost:3000",
                title: "Pre-login",
                snapshotJson: '{"pre":"login"}',
                formsJson: null,
                parentUrl: null,
                navigationAction: null,
                depth: 0,
                discoveredAt: Date.now(),
                lastVisitedAt: Date.now(),
                visitCount: 1,
            });

            siteDb.updatePageContent("http://localhost:3000", {
                title: "Post-login dashboard",
                snapshotJson: '{"post":"login"}',
                formsJson: '{"fields":[]}',
            });

            const retrieved = siteDb.getPage("http://localhost:3000");
            expect(retrieved?.title).toBe("Post-login dashboard");
            expect(retrieved?.snapshotJson).toBe('{"post":"login"}');
            expect(retrieved?.formsJson).toBe('{"fields":[]}');
            expect(retrieved?.visitCount).toBe(2);
        });

        /**
         * Cover needs to tell "we have pages" from "we have pages from behind
         * the login" — a distinction the count alone cannot make, which is how
         * a post-login draft ends up written from the signed-out home page.
         */
        it("records whether a page was captured with a session", () => {
            const base = {
                projectPath: testDir,
                normalizedUrl: "",
                title: "Page",
                snapshotJson: null,
                formsJson: null,
                parentUrl: null,
                navigationAction: null,
                depth: 0,
                discoveredAt: Date.now(),
                lastVisitedAt: Date.now(),
                visitCount: 1,
            };
            siteDb.savePage({
                ...base,
                url: "http://localhost:3000/",
                normalizedUrl: "http://localhost:3000/",
            });
            siteDb.savePage({
                ...base,
                url: "http://localhost:3000/dashboard",
                normalizedUrl: "http://localhost:3000/dashboard",
                capturedAuthenticated: true,
            });

            expect(siteDb.getPage("http://localhost:3000/")?.capturedAuthenticated).toBe(false);
            expect(siteDb.getPage("http://localhost:3000/dashboard")?.capturedAuthenticated).toBe(
                true,
            );
            expect(siteDb.getPagesCount()).toBe(2);
            expect(siteDb.getAuthenticatedPagesCount()).toBe(1);
            expect(siteDb.getStats().authenticatedPagesCount).toBe(1);
        });

        // The flag describes the snapshot currently stored, so re-crawling the
        // same URL with a session has to upgrade it — otherwise the signed-in
        // content sits behind a signed-out label and cover keeps re-crawling.
        it("upgrades provenance when a page is re-crawled with a session", () => {
            siteDb.savePage({
                projectPath: testDir,
                url: "http://localhost:3000/dashboard",
                normalizedUrl: "http://localhost:3000/dashboard",
                title: "Sign in",
                snapshotJson: '{"pre":"login"}',
                formsJson: null,
                parentUrl: null,
                navigationAction: null,
                depth: 0,
                discoveredAt: Date.now(),
                lastVisitedAt: Date.now(),
                visitCount: 1,
            });
            expect(siteDb.getAuthenticatedPagesCount()).toBe(0);

            siteDb.updatePageContent("http://localhost:3000/dashboard", {
                title: "Dashboard",
                snapshotJson: '{"post":"login"}',
                formsJson: null,
                capturedAuthenticated: true,
            });

            expect(siteDb.getAuthenticatedPagesCount()).toBe(1);
        });

        it("updatePageVisit only bumps metadata, leaving content untouched", () => {
            siteDb.savePage({
                projectPath: testDir,
                url: "http://localhost:3000",
                normalizedUrl: "http://localhost:3000",
                title: "Original",
                snapshotJson: '{"original":true}',
                formsJson: null,
                parentUrl: null,
                navigationAction: null,
                depth: 0,
                discoveredAt: Date.now(),
                lastVisitedAt: Date.now(),
                visitCount: 1,
            });

            siteDb.updatePageVisit("http://localhost:3000");

            const retrieved = siteDb.getPage("http://localhost:3000");
            expect(retrieved?.title).toBe("Original");
            expect(retrieved?.snapshotJson).toBe('{"original":true}');
            expect(retrieved?.visitCount).toBe(2);
        });
    });

    describe("Link Operations", () => {
        it("saves and retrieves verified links", () => {
            siteDb.saveLink({
                projectPath: testDir,
                fromUrl: "http://localhost:3000",
                toUrl: "http://localhost:3000/about",
                selector: "a[href='/about']",
                linkText: "About",
                elementRole: "link",
                status: "verified",
                errorMessage: null,
                discoveredAt: Date.now(),
                verifiedAt: Date.now(),
            });

            expect(siteDb.getVerifiedLinks()).toHaveLength(1);
            expect(siteDb.getLinksFrom("http://localhost:3000")).toHaveLength(1);
        });

        it("saveLink reports whether a new edge was actually inserted", () => {
            const link = {
                projectPath: testDir,
                fromUrl: "http://localhost:3000",
                toUrl: "http://localhost:3000/about",
                selector: "a[href='/about']",
                linkText: "About",
                elementRole: "link",
                status: "pending" as const,
                errorMessage: null,
                discoveredAt: Date.now(),
                verifiedAt: null,
            };

            expect(siteDb.saveLink(link)).toBe(1);
            // Same (from, to, selector) — INSERT OR IGNORE swallows it, and
            // the crawler's links-found counter must not count it again.
            expect(siteDb.saveLink(link)).toBe(0);
            expect(siteDb.getLinksFrom("http://localhost:3000")).toHaveLength(1);
        });
    });

    describe("Discovery Blocker Operations", () => {
        it("saves a generic blocker (captcha) and retrieves it", () => {
            const id = siteDb.saveBlocker({
                projectPath: testDir,
                url: "http://localhost:3000/checkout",
                category: "captcha",
                severity: "pause",
                detectorId: "manual:captcha_iframe",
                detectedElements: null,
                evidenceJson: JSON.stringify({ provider: "Cloudflare Turnstile" }),
                screenshotPath: null,
                resolution: null,
                resolvedVia: null,
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: Date.now(),
            });
            expect(id).toBeGreaterThan(0);

            const blockers = siteDb.getUnresolvedBlockers();
            expect(blockers).toHaveLength(1);
            expect(blockers[0].category).toBe("captcha");
            expect(blockers[0].detectorId).toBe("manual:captcha_iframe");
        });

        it("keeps log-only blockers as history without reporting them unresolved", () => {
            siteDb.saveBlocker({
                projectPath: testDir,
                url: "http://localhost:3000/",
                category: "consent_wall",
                severity: "log",
                detectorId: "manual:consent_wall_generic",
                detectedElements: null,
                evidenceJson: JSON.stringify({ selector: '[role="dialog"]' }),
                screenshotPath: null,
                resolution: null,
                resolvedVia: null,
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: Date.now(),
            });

            expect(siteDb.getUnresolvedBlockers()).toHaveLength(0);
            expect(siteDb.getAllBlockers()).toHaveLength(1);
            expect(siteDb.getStats().unresolvedBlockersCount).toBe(0);
        });

        it("legacy saveAuthBlocker still works and produces an auth_required row", () => {
            const id = siteDb.saveAuthBlocker({
                projectPath: testDir,
                url: "http://localhost:3000/login",
                blockerType: "login_form",
                detectedElements: JSON.stringify({ passwordField: 'input[type="password"]' }),
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: Date.now(),
            });
            expect(id).toBeGreaterThan(0);

            const all = siteDb.getUnresolvedBlockers();
            expect(all[0].category).toBe("auth_required");
            expect((all[0] as AuthBlocker).blockerType).toBe("login_form");
            expect(all[0].detectorId).toBe("auth:login_form");
        });

        // Regression for H1: every value in `AuthBlockerType` must round-trip
        // back through `mapBlockerRow`. Pre-fix, `login_redirect` was missing
        // from the legacy-suffix allow-list, so it silently downgraded to
        // `"login_form"` on read — breaking the CLI's `Type: login redirect`
        // diagnostic and any external consumer that switches on `blockerType`.
        it.each([
            ["url_pattern", "auth:url_pattern"],
            ["login_form", "auth:login_form"],
            ["oauth_button", "auth:oauth_button"],
            ["error_message", "auth:error_message"],
            ["http_status", "auth:http_status"],
            ["login_redirect", "auth:login_redirect"],
        ] as const)("round-trips legacy blockerType for detectorId=%s → %s", (expectedType, detectorId) => {
            const id = siteDb.saveBlocker({
                projectPath: testDir,
                url: "http://localhost:3000/dashboard",
                category: "auth_required",
                severity: "pause",
                detectorId,
                detectedElements: null,
                evidenceJson: JSON.stringify({ originUrl: "http://x", finalUrl: "http://x/login" }),
                screenshotPath: null,
                resolution: null,
                resolvedVia: null,
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: Date.now(),
            });
            const row = siteDb.getBlocker(id) as AuthBlocker;
            expect(row.detectorId).toBe(detectorId);
            expect(row.blockerType).toBe(expectedType);
        });

        it("markBlockerResolved records the structured resolution", () => {
            const id = siteDb.saveBlocker({
                projectPath: testDir,
                url: "http://localhost:3000/captcha",
                category: "captcha",
                severity: "pause",
                detectorId: "manual:captcha_iframe",
                detectedElements: null,
                evidenceJson: null,
                screenshotPath: null,
                resolution: null,
                resolvedVia: null,
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: Date.now(),
            });

            siteDb.markBlockerResolved(id, {
                resolution: "skip",
                resolvedVia: "dashboard",
            });

            expect(siteDb.getUnresolvedBlockers()).toHaveLength(0);
            const all = siteDb.getAllBlockers();
            expect(all[0].resolution).toBe("skip");
            expect(all[0].resolvedVia).toBe("dashboard");
            expect(all[0].resolvedAt).not.toBeNull();
        });

        it("markBlockerResolved still accepts the legacy 2-arg form (provide_state)", () => {
            const id = siteDb.saveAuthBlocker({
                projectPath: testDir,
                url: "http://localhost:3000/login",
                blockerType: "login_form",
                detectedElements: null,
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: Date.now(),
            });

            siteDb.markBlockerResolved(id, "/tmp/auth-state.json");

            const all = siteDb.getAllBlockers();
            expect(all[0].resolution).toBe("provide_state");
            expect(all[0].storageStatePath).toBe("/tmp/auth-state.json");
        });

        it("resolveAllBlockers sweeps every unresolved row in one call", () => {
            for (const cat of ["auth_required", "captcha", "manual"] as const) {
                siteDb.saveBlocker({
                    projectPath: testDir,
                    url: `http://localhost:3000/${cat}`,
                    category: cat,
                    severity: "pause",
                    detectorId: `${cat}:test`,
                    detectedElements: null,
                    evidenceJson: null,
                    screenshotPath: null,
                    resolution: null,
                    resolvedVia: null,
                    resolvedAt: null,
                    storageStatePath: null,
                    discoveredAt: Date.now(),
                });
            }

            const changed = siteDb.resolveAllBlockers({
                resolution: "clear",
                resolvedVia: "test",
            });
            expect(changed).toBe(3);
            expect(siteDb.getUnresolvedBlockers()).toHaveLength(0);
        });

        // Regression: the same /login + detector was recorded 3x (2x in a
        // single run) — the display deduped "1 unresolved", storage didn't.
        it("re-detecting the same blocker updates the row in place instead of duplicating", () => {
            const base = {
                projectPath: testDir,
                url: "http://localhost:3000/login",
                category: "auth_required" as const,
                severity: "pause" as const,
                detectorId: "auth:url_pattern",
                detectedElements: null,
                evidenceJson: null,
                screenshotPath: null,
                resolution: null,
                resolvedVia: null,
                resolvedAt: null,
                storageStatePath: null,
            };

            const first = siteDb.saveBlocker({ ...base, discoveredAt: 1000 });
            const second = siteDb.saveBlocker({ ...base, discoveredAt: 2000 });

            expect(second).toBe(first);
            const all = siteDb.getAllBlockers();
            expect(all).toHaveLength(1);
            expect(all[0].discoveredAt).toBe(2000);
        });

        it("re-detection after resolution re-opens the same row", () => {
            const base = {
                projectPath: testDir,
                url: "http://localhost:3000/login",
                category: "auth_required" as const,
                severity: "pause" as const,
                detectorId: "auth:login_form",
                detectedElements: null,
                evidenceJson: null,
                screenshotPath: null,
                resolution: null,
                resolvedVia: null,
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: Date.now(),
            };
            const id = siteDb.saveBlocker(base);
            siteDb.markBlockerResolved(id, { resolution: "provide_state", resolvedVia: "test" });
            expect(siteDb.getUnresolvedBlockers()).toHaveLength(0);

            // Pause -> resolve -> resume -> detector fires again: the
            // condition is present again, so the single row re-opens.
            const reopened = siteDb.saveBlocker(base);

            expect(reopened).toBe(id);
            const all = siteDb.getAllBlockers();
            expect(all).toHaveLength(1);
            expect(all[0].resolvedAt).toBeNull();
            expect(all[0].resolution).toBeNull();
            expect(siteDb.getUnresolvedBlockers()).toHaveLength(1);
        });

        it("collapses pre-existing duplicate rows on the next save", () => {
            // Seed two legacy duplicates directly — the pre-upsert writer
            // allowed them to coexist.
            const raw = db.getRawDatabase();
            const insert = raw.prepare(
                `INSERT INTO discovery_blockers (
                    project_path, url, category, severity, detector_id,
                    detected_elements, evidence_json, screenshot_path,
                    resolution, resolved_via, resolved_at, storage_state_path,
                    discovered_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );
            for (const discoveredAt of [1000, 2000]) {
                insert.run(
                    testDir,
                    "http://localhost:3000/login",
                    "auth_required",
                    "pause",
                    "auth:url_pattern",
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    discoveredAt,
                );
            }
            expect(siteDb.getAllBlockers()).toHaveLength(2);

            siteDb.saveBlocker({
                projectPath: testDir,
                url: "http://localhost:3000/login",
                category: "auth_required",
                severity: "pause",
                detectorId: "auth:url_pattern",
                detectedElements: null,
                evidenceJson: null,
                screenshotPath: null,
                resolution: null,
                resolvedVia: null,
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: 3000,
            });

            expect(siteDb.getAllBlockers()).toHaveLength(1);
        });
    });

    describe("Session Operations", () => {
        it("round-trips skipped URLs and ignored categories", () => {
            const sessionId = siteDb.saveSession({
                projectPath: testDir,
                startUrl: "http://localhost:3000",
                status: "running",
                pagesDiscovered: 0,
                linksFound: 0,
                startedAt: Date.now(),
                completedAt: null,
                blockedAtUrl: null,
                queueJson: null,
            });

            siteDb.updateSession(sessionId, {
                skippedUrlsJson: JSON.stringify(["http://localhost:3000/admin"]),
                ignoredCategoriesJson: JSON.stringify(["captcha"]),
            });

            const updated = siteDb.getSession(sessionId);
            expect(updated?.skippedUrlsJson).toBe(JSON.stringify(["http://localhost:3000/admin"]));
            expect(updated?.ignoredCategoriesJson).toBe(JSON.stringify(["captcha"]));
        });

        // ─────────────────────────────────────────────────────────────────
        // failStaleSessions — crash-resume recovery (Phase 6)
        //
        // A `running` session left over from a server crash/restart is
        // resumable when there's something to resume from (a saved queue
        // or at least one already-discovered page); otherwise there's
        // nothing to resume and it should be marked `failed` as before.
        // ─────────────────────────────────────────────────────────────────

        it("pauses (not fails) a stale running session that has a saved queue", () => {
            const sessionId = siteDb.saveSession({
                projectPath: testDir,
                startUrl: "http://localhost:3000",
                status: "running",
                pagesDiscovered: 2,
                linksFound: 5,
                startedAt: Date.now(),
                completedAt: null,
                blockedAtUrl: null,
                queueJson: JSON.stringify([{ url: "http://localhost:3000/about" }]),
            });

            const changed = siteDb.failStaleSessions();
            expect(changed).toBe(1);
            expect(siteDb.getSession(sessionId)?.status).toBe("paused");
        });

        it("pauses a stale running session with discovered pages but no queue snapshot", () => {
            const sessionId = siteDb.saveSession({
                projectPath: testDir,
                startUrl: "http://localhost:3000",
                status: "running",
                pagesDiscovered: 1,
                linksFound: 0,
                // Pages are always discovered after their session starts.
                startedAt: Date.now() - 1000,
                completedAt: null,
                blockedAtUrl: null,
                queueJson: null,
            });

            siteDb.savePage({
                projectPath: testDir,
                url: "http://localhost:3000",
                normalizedUrl: "http://localhost:3000",
                title: "Home",
                snapshotJson: null,
                formsJson: null,
                parentUrl: null,
                navigationAction: null,
                depth: 0,
                discoveredAt: Date.now(),
                lastVisitedAt: Date.now(),
                visitCount: 1,
            });

            siteDb.failStaleSessions();
            expect(siteDb.getSession(sessionId)?.status).toBe("paused");
        });

        it("fails a stale running session whose only pages belong to an earlier session", () => {
            // A page from a previous, completed crawl…
            siteDb.savePage({
                projectPath: testDir,
                url: "http://localhost:3000",
                normalizedUrl: "http://localhost:3000",
                title: "Home",
                snapshotJson: null,
                formsJson: null,
                parentUrl: null,
                navigationAction: null,
                depth: 0,
                discoveredAt: Date.now() - 60_000,
                lastVisitedAt: Date.now() - 60_000,
                visitCount: 1,
            });

            // …must not make a brand-new crashed session (no checkpoint, no
            // pages of its own) look resumable.
            const sessionId = siteDb.saveSession({
                projectPath: testDir,
                startUrl: "http://localhost:3000",
                status: "running",
                pagesDiscovered: 0,
                linksFound: 0,
                startedAt: Date.now(),
                completedAt: null,
                blockedAtUrl: null,
                queueJson: null,
            });

            siteDb.failStaleSessions();
            expect(siteDb.getSession(sessionId)?.status).toBe("failed");
        });

        it("fails a stale running session with nothing to resume from", () => {
            const sessionId = siteDb.saveSession({
                projectPath: testDir,
                startUrl: "http://localhost:3000",
                status: "running",
                pagesDiscovered: 0,
                linksFound: 0,
                startedAt: Date.now(),
                completedAt: null,
                blockedAtUrl: null,
                queueJson: null,
            });

            siteDb.failStaleSessions();
            const updated = siteDb.getSession(sessionId);
            expect(updated?.status).toBe("failed");
            expect(updated?.completedAt).not.toBeNull();
        });

        it("leaves completed/failed/paused sessions untouched", () => {
            const completedId = siteDb.saveSession({
                projectPath: testDir,
                startUrl: "http://localhost:3000",
                status: "completed",
                pagesDiscovered: 3,
                linksFound: 1,
                startedAt: Date.now(),
                completedAt: Date.now(),
                blockedAtUrl: null,
                queueJson: null,
            });

            siteDb.failStaleSessions();
            expect(siteDb.getSession(completedId)?.status).toBe("completed");
        });

        it("getAllNormalizedUrls returns the normalized URL of every discovered page", () => {
            siteDb.savePage({
                projectPath: testDir,
                url: "http://localhost:3000",
                normalizedUrl: "http://localhost:3000",
                title: "Home",
                snapshotJson: null,
                formsJson: null,
                parentUrl: null,
                navigationAction: null,
                depth: 0,
                discoveredAt: Date.now(),
                lastVisitedAt: Date.now(),
                visitCount: 1,
            });
            siteDb.savePage({
                projectPath: testDir,
                url: "http://localhost:3000/about",
                normalizedUrl: "http://localhost:3000/about",
                title: "About",
                snapshotJson: null,
                formsJson: null,
                parentUrl: "http://localhost:3000",
                navigationAction: null,
                depth: 1,
                discoveredAt: Date.now(),
                lastVisitedAt: Date.now(),
                visitCount: 1,
            });

            const urls = siteDb.getAllNormalizedUrls();
            expect(urls).toHaveLength(2);
            expect(
                urls.some((u) => u.startsWith("http://localhost:3000") && !u.includes("/about")),
            ).toBe(true);
            expect(urls).toContain("http://localhost:3000/about");
        });
    });

    describe("Statistics", () => {
        it("counts pages, links, and unresolved blockers", () => {
            siteDb.savePage({
                projectPath: testDir,
                url: "http://localhost:3000",
                normalizedUrl: "http://localhost:3000",
                title: "Test Page",
                snapshotJson: null,
                formsJson: null,
                parentUrl: null,
                navigationAction: null,
                depth: 0,
                discoveredAt: Date.now(),
                lastVisitedAt: Date.now(),
                visitCount: 1,
            });

            siteDb.saveLink({
                projectPath: testDir,
                fromUrl: "http://localhost:3000",
                toUrl: "http://localhost:3000/about",
                selector: "a[href='/about']",
                linkText: "About",
                elementRole: "link",
                status: "verified",
                errorMessage: null,
                discoveredAt: Date.now(),
                verifiedAt: Date.now(),
            });

            siteDb.saveBlocker({
                projectPath: testDir,
                url: "http://localhost:3000/captcha",
                category: "captcha",
                severity: "pause",
                detectorId: "manual:captcha_iframe",
                detectedElements: null,
                evidenceJson: null,
                screenshotPath: null,
                resolution: null,
                resolvedVia: null,
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: Date.now(),
            });

            const stats = siteDb.getStats();
            expect(stats.pagesCount).toBe(1);
            expect(stats.linksCount).toBe(1);
            expect(stats.verifiedLinksCount).toBe(1);
            expect(stats.unresolvedBlockersCount).toBe(1);
        });
    });
});

// ---------------------------------------------------------------------------
// Migration test
// ---------------------------------------------------------------------------

describe("Migration v5 -> v6 (auth_blockers -> discovery_blockers)", () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-migrate-"));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    /**
     * Build a v5-shape database manually, populate it with `auth_blockers`
     * rows, then open it through `CodeGraphDB` to trigger `migrateToV6`
     * and assert every row landed in `discovery_blockers` with the right
     * defaults.
     */
    it("preserves every auth_blockers row with category=auth_required and detector_id=auth:<type>", () => {
        const dbPath = path.join(testDir, ".raiken", "raiken.db");
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });

        // Seed a v5-shape database. We mirror exactly what migrateToV4
        // creates (auth_blockers + discovery_sessions + the rest of the
        // discovery tables) and bump SQLite's `user_version` to 5 so
        // CodeGraphDB skips migrateToV2..V5 and runs only migrateToV6.
        {
            const raw = new Database(dbPath);
            raw.pragma("user_version = 5");
            // Tables created by createV1Schema() — needed because
            // ensureSchema() runs idempotent extensions (e.g.
            // ensureDependencyColumns) which assume v1 tables exist.
            raw.exec(`
                CREATE TABLE files (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    tree_hash TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    lines INTEGER NOT NULL,
                    depth INTEGER NOT NULL,
                    last_indexed INTEGER NOT NULL,
                    UNIQUE(project_path, file_path)
                );
                CREATE TABLE dependencies (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    source_file TEXT NOT NULL,
                    target_file TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(project_path, source_file, target_file)
                );
                CREATE TABLE entry_points (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    role TEXT NOT NULL,
                    type TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(project_path, file_path)
                );
                CREATE TABLE stats (
                    project_path TEXT PRIMARY KEY,
                    total_files INTEGER NOT NULL,
                    total_size INTEGER NOT NULL,
                    total_lines INTEGER NOT NULL,
                    total_functions INTEGER NOT NULL,
                    total_classes INTEGER NOT NULL,
                    total_types INTEGER NOT NULL,
                    last_scan INTEGER NOT NULL,
                    schema_version INTEGER DEFAULT 1
                );
            `);
            raw.exec(`
                CREATE TABLE discovered_pages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    url TEXT NOT NULL,
                    normalized_url TEXT NOT NULL,
                    title TEXT,
                    snapshot_json TEXT,
                    parent_url TEXT,
                    navigation_action TEXT,
                    depth INTEGER DEFAULT 0,
                    discovered_at INTEGER NOT NULL,
                    last_visited_at INTEGER NOT NULL,
                    visit_count INTEGER DEFAULT 1,
                    UNIQUE(project_path, normalized_url)
                );

                CREATE TABLE discovered_links (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    from_url TEXT NOT NULL,
                    to_url TEXT NOT NULL,
                    selector TEXT NOT NULL,
                    link_text TEXT,
                    element_role TEXT,
                    status TEXT DEFAULT 'pending',
                    error_message TEXT,
                    discovered_at INTEGER NOT NULL,
                    verified_at INTEGER,
                    UNIQUE(project_path, from_url, to_url, selector)
                );

                CREATE TABLE discovery_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    start_url TEXT NOT NULL,
                    status TEXT DEFAULT 'running',
                    pages_discovered INTEGER DEFAULT 0,
                    links_found INTEGER DEFAULT 0,
                    started_at INTEGER NOT NULL,
                    completed_at INTEGER,
                    blocked_at_url TEXT,
                    queue_json TEXT,
                    max_pages INTEGER,
                    max_depth INTEGER
                );

                CREATE TABLE auth_blockers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    url TEXT NOT NULL,
                    blocker_type TEXT NOT NULL,
                    detected_elements TEXT,
                    resolved_at INTEGER,
                    storage_state_path TEXT,
                    discovered_at INTEGER NOT NULL
                );
            `);

            const insert = raw.prepare(`
                INSERT INTO auth_blockers (
                    project_path, url, blocker_type, detected_elements,
                    resolved_at, storage_state_path, discovered_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            insert.run(testDir, "http://x/login", "login_form", "{}", null, null, 1);
            insert.run(testDir, "http://x/sso", "oauth_button", "{}", null, null, 2);
            insert.run(
                testDir,
                "http://x/api",
                "http_status",
                null,
                Date.now(),
                "/tmp/auth-state.json",
                3,
            );

            raw.close();
        }

        // Open through CodeGraphDB — this is what triggers migrateToV6.
        // The v5 schema seed above is intentionally minimal, so we
        // expect newer migrations (e.g. CodeGraph tables) to add their
        // own missing tables alongside the v6 work. All we care about
        // is that the auth_blockers rows landed correctly.
        const db = new CodeGraphDB(testDir, dbPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), testDir);

            const allBlockers = siteDb.getAllBlockers();
            expect(allBlockers).toHaveLength(3);

            const byUrl = new Map(allBlockers.map((b) => [b.url, b]));
            const login = byUrl.get("http://x/login");
            expect(login?.category).toBe("auth_required");
            expect(login?.severity).toBe("pause");
            expect(login?.detectorId).toBe("auth:login_form");
            expect(login?.resolution).toBeNull();

            const sso = byUrl.get("http://x/sso");
            expect(sso?.detectorId).toBe("auth:oauth_button");

            // Already-resolved row should have its resolution back-filled
            // as `provide_state` (the only resolution kind a v5 row
            // could've had).
            const api = byUrl.get("http://x/api");
            expect(api?.resolvedAt).not.toBeNull();
            expect(api?.resolution).toBe("provide_state");
            expect(api?.resolvedVia).toBe("auth_command");
            expect(api?.storageStatePath).toBe("/tmp/auth-state.json");

            // The legacy table should be gone.
            const tables = db.getTables().map((t) => t.name);
            expect(tables).not.toContain("auth_blockers");
            expect(tables).toContain("discovery_blockers");
        } finally {
            db.close();
        }
    });
});
