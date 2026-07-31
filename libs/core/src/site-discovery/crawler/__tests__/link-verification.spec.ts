import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodeGraphDB } from "../../../database/db";
import { SiteKnowledgeDB } from "../../db";
import { markBrokenLinks, verifyPendingLinks } from "../link-verification";

describe("link verification contract", () => {
    const dirs: string[] = [];

    function makeSiteDb(): { siteDb: SiteKnowledgeDB; projectPath: string } {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-link-verify-"));
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

    it("marks pending inbound links as verified for url variants", () => {
        const { siteDb, projectPath } = makeSiteDb();
        siteDb.saveLink({
            projectPath,
            fromUrl: "http://example.com/a",
            toUrl: "http://example.com/target",
            selector: "a",
            linkText: null,
            elementRole: null,
            status: "pending",
            errorMessage: null,
            discoveredAt: Date.now(),
            verifiedAt: null,
        });

        verifyPendingLinks(siteDb, "http://example.com/target/", "http://example.com/target");

        const links = siteDb.getLinksFrom("http://example.com/a");
        expect(links[0]?.status).toBe("verified");
    });

    it("marks pending links broken or auth_required with a message", () => {
        const { siteDb, projectPath } = makeSiteDb();
        siteDb.saveLink({
            projectPath,
            fromUrl: "http://example.com/a",
            toUrl: "http://example.com/gated",
            selector: "a",
            linkText: null,
            elementRole: null,
            status: "pending",
            errorMessage: null,
            discoveredAt: Date.now(),
            verifiedAt: null,
        });

        markBrokenLinks(
            siteDb,
            "http://example.com/gated",
            "http://example.com/gated",
            "Auth required",
            "auth_required",
        );

        const links = siteDb.getLinksFrom("http://example.com/a");
        expect(links[0]?.status).toBe("auth_required");
        expect(links[0]?.errorMessage).toBe("Auth required");
    });

    it("verifies an index.html link when the crawl records the directory URL", () => {
        const { siteDb, projectPath } = makeSiteDb();
        siteDb.saveLink({
            projectPath,
            fromUrl: "http://example.com/a",
            toUrl: "http://example.com/index.html",
            selector: "a",
            linkText: null,
            elementRole: null,
            status: "pending",
            errorMessage: null,
            discoveredAt: Date.now(),
            verifiedAt: null,
        });

        // The crawler visited "http://example.com/" (normalizeUrl collapses
        // the index file); the link to the index spelling must still verify.
        verifyPendingLinks(siteDb, "http://example.com/", "http://example.com/");

        const links = siteDb.getLinksFrom("http://example.com/a");
        expect(links[0]?.status).toBe("verified");
    });

    it("verifies a directory link when the crawl records the index.html URL", () => {
        const { siteDb, projectPath } = makeSiteDb();
        siteDb.saveLink({
            projectPath,
            fromUrl: "http://example.com/a",
            toUrl: "http://example.com/",
            selector: "a",
            linkText: null,
            elementRole: null,
            status: "pending",
            errorMessage: null,
            discoveredAt: Date.now(),
            verifiedAt: null,
        });

        verifyPendingLinks(siteDb, "http://example.com/index.html", "http://example.com/");

        const links = siteDb.getLinksFrom("http://example.com/a");
        expect(links[0]?.status).toBe("verified");
    });
});
