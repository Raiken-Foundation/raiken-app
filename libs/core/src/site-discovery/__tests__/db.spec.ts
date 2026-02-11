/**
 * Site Discovery Database Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CodeGraphDB } from "../../database/db";
import { SiteKnowledgeDB } from "../db";

describe("SiteKnowledgeDB", () => {
    let testDir: string;
    let db: CodeGraphDB;
    let siteDb: SiteKnowledgeDB;

    beforeEach(() => {
        // Create a temporary directory for test database
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-test-"));
        db = new CodeGraphDB(testDir);
        siteDb = new SiteKnowledgeDB((db as any).db, testDir);
    });

    afterEach(() => {
        // Clean up
        db.close();
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe("Database Schema", () => {
        it("should create discovery tables during migration", () => {
            const tables = db.getTables();
            const tableNames = tables.map((t) => t.name);

            expect(tableNames).toContain("discovered_pages");
            expect(tableNames).toContain("discovered_links");
            expect(tableNames).toContain("auth_blockers");
            expect(tableNames).toContain("discovery_sessions");
        });
    });

    describe("Page Operations", () => {
        it("should save and retrieve a page", () => {
            const page = {
                projectPath: testDir,
                url: "http://localhost:3000",
                normalizedUrl: "http://localhost:3000",
                title: "Test Page",
                snapshotJson: null,
                parentUrl: null,
                navigationAction: null,
                depth: 0,
                discoveredAt: Date.now(),
                lastVisitedAt: Date.now(),
                visitCount: 1,
            };

            const pageId = siteDb.savePage(page);
            expect(pageId).toBeGreaterThan(0);

            const retrieved = siteDb.getPage("http://localhost:3000");
            expect(retrieved).toBeTruthy();
            expect(retrieved?.title).toBe("Test Page");
            expect(retrieved?.depth).toBe(0);
        });

        it("should get pages count", () => {
            const page = {
                projectPath: testDir,
                url: "http://localhost:3000",
                normalizedUrl: "http://localhost:3000",
                title: "Test Page",
                snapshotJson: null,
                parentUrl: null,
                navigationAction: null,
                depth: 0,
                discoveredAt: Date.now(),
                lastVisitedAt: Date.now(),
                visitCount: 1,
            };

            siteDb.savePage(page);
            const count = siteDb.getPagesCount();
            expect(count).toBe(1);
        });
    });

    describe("Link Operations", () => {
        it("should save and retrieve links", () => {
            const link = {
                projectPath: testDir,
                fromUrl: "http://localhost:3000",
                toUrl: "http://localhost:3000/about",
                selector: "a[href='/about']",
                linkText: "About",
                elementRole: "link",
                status: "verified" as const,
                errorMessage: null,
                discoveredAt: Date.now(),
                verifiedAt: Date.now(),
            };

            siteDb.saveLink(link);

            const links = siteDb.getLinksFrom("http://localhost:3000");
            expect(links).toHaveLength(1);
            expect(links[0].toUrl).toBe("http://localhost:3000/about");
            expect(links[0].linkText).toBe("About");
        });

        it("should get verified links", () => {
            const link = {
                projectPath: testDir,
                fromUrl: "http://localhost:3000",
                toUrl: "http://localhost:3000/about",
                selector: "a[href='/about']",
                linkText: "About",
                elementRole: "link",
                status: "verified" as const,
                errorMessage: null,
                discoveredAt: Date.now(),
                verifiedAt: Date.now(),
            };

            siteDb.saveLink(link);

            const verifiedLinks = siteDb.getVerifiedLinks();
            expect(verifiedLinks).toHaveLength(1);
            expect(verifiedLinks[0].status).toBe("verified");
        });
    });

    describe("Auth Blocker Operations", () => {
        it("should save and retrieve auth blockers", () => {
            const blocker = {
                projectPath: testDir,
                url: "http://localhost:3000/login",
                blockerType: "login_form" as const,
                detectedElements: JSON.stringify({ passwordField: 'input[type="password"]' }),
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: Date.now(),
            };

            const blockerId = siteDb.saveAuthBlocker(blocker);
            expect(blockerId).toBeGreaterThan(0);

            const blockers = siteDb.getUnresolvedBlockers();
            expect(blockers).toHaveLength(1);
            expect(blockers[0].url).toBe("http://localhost:3000/login");
            expect(blockers[0].blockerType).toBe("login_form");
        });

        it("should mark blocker as resolved", () => {
            const blocker = {
                projectPath: testDir,
                url: "http://localhost:3000/login",
                blockerType: "login_form" as const,
                detectedElements: JSON.stringify({ passwordField: 'input[type="password"]' }),
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: Date.now(),
            };

            const blockerId = siteDb.saveAuthBlocker(blocker);
            siteDb.markBlockerResolved(blockerId, "/path/to/storage.json");

            const unresolvedBlockers = siteDb.getUnresolvedBlockers();
            expect(unresolvedBlockers).toHaveLength(0);

            const allBlockers = siteDb.getAllBlockers();
            expect(allBlockers).toHaveLength(1);
            expect(allBlockers[0].resolvedAt).not.toBeNull();
        });
    });

    describe("Session Operations", () => {
        it("should save and retrieve session", () => {
            const session = {
                projectPath: testDir,
                startUrl: "http://localhost:3000",
                status: "running" as const,
                pagesDiscovered: 0,
                linksFound: 0,
                startedAt: Date.now(),
                completedAt: null,
                blockedAtUrl: null,
                queueJson: null,
            };

            const sessionId = siteDb.saveSession(session);
            expect(sessionId).toBeGreaterThan(0);

            const retrieved = siteDb.getSession(sessionId);
            expect(retrieved).toBeTruthy();
            expect(retrieved?.startUrl).toBe("http://localhost:3000");
            expect(retrieved?.status).toBe("running");
        });

        it("should update session", () => {
            const session = {
                projectPath: testDir,
                startUrl: "http://localhost:3000",
                status: "running" as const,
                pagesDiscovered: 0,
                linksFound: 0,
                startedAt: Date.now(),
                completedAt: null,
                blockedAtUrl: null,
                queueJson: null,
            };

            const sessionId = siteDb.saveSession(session);

            siteDb.updateSession(sessionId, {
                pagesDiscovered: 10,
                linksFound: 25,
                status: "completed",
                completedAt: Date.now(),
            });

            const updated = siteDb.getSession(sessionId);
            expect(updated?.pagesDiscovered).toBe(10);
            expect(updated?.linksFound).toBe(25);
            expect(updated?.status).toBe("completed");
        });
    });

    describe("Statistics", () => {
        it("should return correct stats", () => {
            // Add some test data
            siteDb.savePage({
                projectPath: testDir,
                url: "http://localhost:3000",
                normalizedUrl: "http://localhost:3000",
                title: "Test Page",
                snapshotJson: null,
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

            const stats = siteDb.getStats();
            expect(stats.pagesCount).toBe(1);
            expect(stats.linksCount).toBe(1);
            expect(stats.verifiedLinksCount).toBe(1);
            expect(stats.brokenLinksCount).toBe(0);
        });
    });
});
