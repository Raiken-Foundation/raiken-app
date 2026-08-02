/**
 * Cold-start knowledge gate: refuse inventing without discovery, or
 * auto-discover when a seed URL is known.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRaikenError } from "../errors";
import {
    ensureSiteKnowledge,
    hasUsableSiteKnowledge,
    resolveDiscoverSeedUrl,
    siteKnowledgeRefuseMessage,
} from "../cover/knowledge-gate";
import { runCover } from "../cover/cover";

describe("site knowledge gate", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-knowledge-gate-"));
    });

    afterEach(() => {
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it("hasUsableSiteKnowledge is false in a bare project", () => {
        expect(hasUsableSiteKnowledge(projectDir)).toBe(false);
    });

    it("resolveDiscoverSeedUrl prefers baseURL then webServer.url", async () => {
        expect(await resolveDiscoverSeedUrl(projectDir)).toBeNull();

        fs.writeFileSync(
            path.join(projectDir, "playwright.config.ts"),
            `export default { webServer: { url: 'http://localhost:4000' } };\n`,
        );
        expect(await resolveDiscoverSeedUrl(projectDir)).toBe("http://localhost:4000");

        fs.writeFileSync(
            path.join(projectDir, "playwright.config.ts"),
            `export default {
  use: { baseURL: 'http://localhost:5199' },
  webServer: { url: 'http://localhost:4000' },
};\n`,
        );
        expect(await resolveDiscoverSeedUrl(projectDir)).toBe("http://localhost:5199");
    });

    it("allowUngrounded skips the gate", async () => {
        const result = await ensureSiteKnowledge({
            projectPath: projectDir,
            allowUngrounded: true,
        });
        expect(result).toEqual({ status: "skipped", reason: "allow_ungrounded" });
    });

    it("refuses when there is no knowledge and no seed URL", async () => {
        await expect(ensureSiteKnowledge({ projectPath: projectDir })).rejects.toSatisfy(
            (err: unknown) =>
                isRaikenError(err) &&
                err.message.includes("No site knowledge") &&
                err.message.includes("raiken discover"),
        );
        expect(siteKnowledgeRefuseMessage(null)).toMatch(/raiken discover http:\/\/localhost:3000/);
    });

    it("auto-discovers when a seed URL is known", async () => {
        fs.writeFileSync(
            path.join(projectDir, "playwright.config.ts"),
            `export default { use: { baseURL: 'http://localhost:5199' } };\n`,
        );
        let discoveredUrl: string | null = null;
        const result = await ensureSiteKnowledge({
            projectPath: projectDir,
            runDiscover: async (url) => {
                discoveredUrl = url;
                // Simulate a successful crawl leaving pages on disk: create a
                // minimal site-knowledge DB entry via the query path by writing
                // a fake pagesCount through the real SiteKnowledgeDB.
                const { SiteKnowledgeDB } = await import("../site-discovery/db");
                const { CodeGraphDB } = await import("../database/db");
                const codeDb = new CodeGraphDB(projectDir);
                const siteDb = new SiteKnowledgeDB(codeDb.getRawDatabase(), projectDir);
                const now = Date.now();
                siteDb.savePage({
                    projectPath: projectDir,
                    url: "http://localhost:5199/",
                    normalizedUrl: "http://localhost:5199/",
                    title: "Home",
                    snapshotJson: null,
                    formsJson: null,
                    parentUrl: null,
                    navigationAction: null,
                    depth: 0,
                    discoveredAt: now,
                    lastVisitedAt: now,
                    visitCount: 1,
                });
                codeDb.close();
            },
        });
        expect(discoveredUrl).toBe("http://localhost:5199");
        expect(result).toMatchObject({ status: "ready", discovered: true });
        expect(hasUsableSiteKnowledge(projectDir)).toBe(true);
    });

    it("runCover refuses a cold project without inventing a draft", async () => {
        await expect(
            runCover({
                projectPath: projectDir,
                target: "add a product to the cart",
                dryRun: true,
            }),
        ).rejects.toSatisfy(
            (err: unknown) => isRaikenError(err) && /No site knowledge/i.test(err.message),
        );
        const e2e = path.join(projectDir, "e2e");
        if (fs.existsSync(e2e)) {
            const files = fs.readdirSync(e2e);
            expect(files.filter((f) => f.endsWith(".spec.ts"))).toEqual([]);
        }
    });

    it("runCover with allowUngrounded still drafts on a cold project", async () => {
        const result = await runCover({
            projectPath: projectDir,
            target: "add a product to the cart",
            dryRun: true,
            allowUngrounded: true,
        });
        expect(result.needsReview).toBe(true);
        expect(fs.existsSync(result.outputPath)).toBe(true);
    });
});
