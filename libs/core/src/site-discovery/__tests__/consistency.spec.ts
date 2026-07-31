/**
 * Knowledge-consistency invariant checks.
 *
 * Each test reconstructs one historical failure mode (links stuck pending
 * with stored targets, terminal sessions with stale blocked_at_url, session
 * counters inflated past persisted rows) and asserts the validator flags it —
 * plus a healthy fixture that must come back clean.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodeGraphDB } from "../../database/db";
import { validateKnowledgeConsistency } from "../consistency";
import { SiteKnowledgeDB } from "../db";

describe("validateKnowledgeConsistency", () => {
    const dirs: string[] = [];

    function makeSiteDb(): { siteDb: SiteKnowledgeDB; projectPath: string } {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-consistency-"));
        dirs.push(dir);
        const db = new CodeGraphDB(dir);
        return {
            projectPath: dir,
            siteDb: new SiteKnowledgeDB(db.getRawDatabase(), dir, false),
        };
    }

    afterEach(() => {
        for (const dir of dirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        dirs.length = 0;
    });

    function seedPage(siteDb: SiteKnowledgeDB, projectPath: string, url: string): void {
        siteDb.savePage({
            projectPath,
            url,
            normalizedUrl: url,
            title: url,
            snapshotJson: null,
            formsJson: null,
            parentUrl: null,
            navigationAction: null,
            depth: 0,
            discoveredAt: Date.now(),
            lastVisitedAt: Date.now(),
            visitCount: 1,
        });
    }

    function seedLink(
        siteDb: SiteKnowledgeDB,
        projectPath: string,
        fromUrl: string,
        toUrl: string,
        status: "pending" | "verified",
    ): void {
        siteDb.saveLink({
            projectPath,
            fromUrl,
            toUrl,
            selector: "a",
            linkText: null,
            elementRole: null,
            status,
            errorMessage: null,
            discoveredAt: Date.now(),
            verifiedAt: status === "verified" ? Date.now() : null,
        });
    }

    function seedSession(
        siteDb: SiteKnowledgeDB,
        projectPath: string,
        overrides: Partial<{
            status: "paused" | "completed";
            blockedAtUrl: string | null;
            pagesDiscovered: number;
            linksFound: number;
        }> = {},
    ): void {
        siteDb.saveSession({
            projectPath,
            startUrl: "http://app.local/",
            status: overrides.status ?? "completed",
            pagesDiscovered: overrides.pagesDiscovered ?? 1,
            linksFound: overrides.linksFound ?? 1,
            startedAt: Date.now(),
            completedAt: (overrides.status ?? "completed") === "completed" ? Date.now() : null,
            blockedAtUrl: overrides.blockedAtUrl ?? null,
            queueJson: null,
        });
    }

    it("reports a healthy knowledge base as ok", () => {
        const { siteDb, projectPath } = makeSiteDb();
        seedPage(siteDb, projectPath, "http://app.local/");
        seedPage(siteDb, projectPath, "http://app.local/about");
        seedLink(siteDb, projectPath, "http://app.local/", "http://app.local/about", "verified");
        seedLink(siteDb, projectPath, "http://app.local/", "http://app.local/missing", "pending");
        seedSession(siteDb, projectPath, { pagesDiscovered: 2, linksFound: 2 });

        const report = validateKnowledgeConsistency(siteDb);
        expect(report.violations).toEqual([]);
        expect(report.ok).toBe(true);
    });

    it("flags pending links whose target page is stored", () => {
        const { siteDb, projectPath } = makeSiteDb();
        seedPage(siteDb, projectPath, "http://app.local/");
        seedPage(siteDb, projectPath, "http://app.local/about");
        seedLink(siteDb, projectPath, "http://app.local/about", "http://app.local/", "pending");
        seedSession(siteDb, projectPath, { pagesDiscovered: 2, linksFound: 1 });

        const report = validateKnowledgeConsistency(siteDb);
        expect(report.ok).toBe(false);
        expect(report.violations.some((v) => v.includes('"pending"'))).toBe(true);
    });

    it("flags terminal sessions still carrying a blocked_at_url", () => {
        const { siteDb, projectPath } = makeSiteDb();
        seedPage(siteDb, projectPath, "http://app.local/");
        seedSession(siteDb, projectPath, {
            status: "completed",
            blockedAtUrl: "http://app.local/admin",
        });

        const report = validateKnowledgeConsistency(siteDb);
        expect(report.ok).toBe(false);
        expect(report.violations.some((v) => v.includes("blocked_at_url"))).toBe(true);
    });

    it("flags session counters inflated past the stored rows", () => {
        const { siteDb, projectPath } = makeSiteDb();
        seedPage(siteDb, projectPath, "http://app.local/");
        seedSession(siteDb, projectPath, { pagesDiscovered: 10, linksFound: 42 });

        const report = validateKnowledgeConsistency(siteDb);
        expect(report.ok).toBe(false);
        expect(report.violations.some((v) => v.includes("10 pages"))).toBe(true);
        expect(report.violations.some((v) => v.includes("42 links"))).toBe(true);
    });
});
