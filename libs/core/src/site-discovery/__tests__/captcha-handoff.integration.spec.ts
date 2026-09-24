/**
 * Captcha + handoff integration spec.
 *
 * Drives a real Chromium instance (via Playwright) against a tiny in-process
 * HTTP server that serves a page containing a Cloudflare-shaped captcha
 * iframe. Verifies that:
 *
 *   1. The default detector pipeline (`auth + manual-fallback`) classifies
 *      the response as `category: "captcha"`.
 *   2. The blocker is persisted via `SiteKnowledgeDB.saveBlocker` with the
 *      generic columns the dashboard renders (category, detectorId,
 *      evidenceJson).
 *   3. After a "user" snapshot we can mark the blocker resolved with
 *      `resolution: "handoff"` and the auto-resume gate (every blocker has
 *      a recorded resolution) flips to true.
 *
 * Skipped when Playwright's browsers aren't installed locally (e.g. on the
 * `nx test core` matrix without `npx playwright install`). This mirrors how
 * the embeddings spec handles missing native deps so CI never goes red on
 * an environment-only issue.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CodeGraphDB } from "../../database/db";
import { SiteKnowledgeDB } from "../db";
import { createAuthDetector, createManualFallbackDetector, runBlockerPipeline } from "../detectors";

const CAPTCHA_HTML = /* html */ `
<!doctype html>
<html>
    <head><title>Captcha test</title></head>
    <body>
        <h1>Verify you're human</h1>
        <iframe
            src="https://challenges.cloudflare.com/turnstile/v0/api.html?dummy=1"
            data-testid="captcha-frame"
            style="width: 300px; height: 65px; border: 0"
        ></iframe>
    </body>
</html>
`.trim();

function loadChromium() {
    try {
        return require("playwright").chromium as typeof import("playwright").chromium | null;
    } catch {
        try {
            return require("playwright-core").chromium as
                | typeof import("playwright").chromium
                | null;
        } catch {
            return null;
        }
    }
}

const chromium = loadChromium();
const describeIfBrowser = chromium ? describe : describe.skip;

describeIfBrowser("captcha + handoff integration", () => {
    let server: http.Server;
    let baseUrl: string;
    let testDir: string;
    let db: CodeGraphDB;
    let siteDb: SiteKnowledgeDB;

    beforeAll(async () => {
        server = http.createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(CAPTCHA_HTML);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}/`;

        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-captcha-int-"));
        db = new CodeGraphDB(testDir);
        siteDb = new SiteKnowledgeDB(db.getRawDatabase(), testDir);
    });

    afterAll(async () => {
        db?.close();
        if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("detects a Cloudflare-shaped iframe, persists it, and resolves via handoff", async () => {
        if (!chromium) return; // type-narrow

        let browser: import("playwright").Browser | null = null;
        try {
            browser = await chromium.launch({ headless: true });
        } catch (err) {
            // No browsers installed — treat exactly like the missing-module path.
            console.warn(
                `Skipping captcha integration test: Chromium not available (${(err as Error).message})`,
            );
            return;
        }

        const context = await browser.newContext();
        const page = await context.newPage();
        const response = await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

        // Phase 1: detector pipeline classifies the page as a captcha blocker.
        const detectors = [createAuthDetector(), createManualFallbackDetector()];
        const blocker = await runBlockerPipeline(detectors, {
            projectPath: testDir,
            page,
            url: baseUrl,
            response: response ?? undefined,
        });

        expect(blocker).not.toBeNull();
        expect(blocker?.category).toBe("captcha");
        expect(blocker?.detectorId).toBe("manual:captcha_iframe");
        expect(blocker?.evidenceJson).toBeTruthy();

        // Phase 2: persist via the same code path the crawler uses.
        if (!blocker) throw new Error("blocker should not be null at this point");
        const { id: _ignored, ...persistable } = blocker;
        void _ignored;
        const id = siteDb.saveBlocker(persistable);
        expect(siteDb.getUnresolvedBlockers()).toHaveLength(1);

        // Phase 3: simulate a successful "drive it myself" handoff — the user
        // closed the browser and we snapshotted a storageState.
        const statePath = path.join(testDir, "captcha-state.json");
        await context.storageState({ path: statePath });
        expect(fs.existsSync(statePath)).toBe(true);

        siteDb.markBlockerResolved(id, {
            resolution: "handoff",
            resolvedVia: "dashboard:requestBrowserHandoff",
            storageStatePath: statePath,
        });

        // Phase 4: auto-resume gate — every unresolved blocker is now
        // cleared, so the dashboard would flip wasWaitingForBlocker → false.
        expect(siteDb.getUnresolvedBlockers()).toHaveLength(0);
        const stored = siteDb.getBlocker(id);
        expect(stored?.resolution).toBe("handoff");
        expect(stored?.storageStatePath).toBe(statePath);

        await context.close();
        await browser.close();
    }, 30_000);
});
