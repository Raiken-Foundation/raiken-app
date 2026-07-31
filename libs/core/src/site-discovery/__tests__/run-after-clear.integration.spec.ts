/**
 * Run-after-clear regression spec (Issue 6).
 *
 * Reproduces the silent-drain bug where a second `SiteDiscovery.start()`
 * in the same Node process drained immediately with `requestsTotal: 0`
 * because Crawlee's `RequestQueue` cached by name (`"default"`) and the
 * cached instance still held the prior run's "URL already handled" log —
 * even after we installed a fresh `MemoryStorage`.
 *
 * Symptom in the wild:
 *
 *   Run #1 (auth-walled SPA): hits 302→/auth/login, fires AuthBlocker,
 *           pauses. Crawlee log: `crawlerRuntimeMillis: 1979ms`.
 *   User clicks Clear Data.
 *   Run #2: `crawlerRuntimeMillis: 153ms` with
 *           `"All requests from the queue have been processed"` —
 *           handler never invoked, falls through to the generic
 *           "page rendered nothing" error.
 *
 * Fix: per-instance unique queue name (`raiken-discovery-<ts>-<rand>`)
 * + `requestQueue.drop()` on `close()`. With the fix, every new
 * `SiteDiscovery` opens a fresh queue; the cache key never collides
 * with a prior run.
 *
 * Skipped when Chromium isn't installed (matches `captcha-handoff` spec).
 */

import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CodeGraphDB } from "../../database/db";
import { validateKnowledgeConsistency } from "../consistency";
import { SiteDiscovery } from "../crawler";
import { SiteKnowledgeDB } from "../db";

const SIMPLE_HTML = /* html */ `
<!doctype html>
<html>
    <head><title>Run-after-clear test</title></head>
    <body>
        <h1>Hello</h1>
        <a href="/about">About</a>
    </body>
</html>
`.trim();

function loadChromium() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require("playwright").chromium as typeof import("playwright").chromium | null;
    } catch {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
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

describeIfBrowser("run-after-clear regression (Issue 6)", () => {
    let server: http.Server;
    let baseUrl: string;
    let testDir: string;

    beforeAll(async () => {
        // Tiny static server — the request handler MUST run to register
        // a discovered page, so the page actually returning HTML is the
        // critical part of the assertion (handler invoked → page saved).
        server = http.createServer((req, res) => {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(req.url === "/about" ? SIMPLE_HTML.replace("Hello", "About") : SIMPLE_HTML);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}/`;

        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-run-after-clear-"));
    });

    afterAll(async () => {
        if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("repeat crawls count refreshed pages and survive a data clear", async () => {
        // Browser-launch sanity check (mirrors captcha-handoff pattern):
        // skip the assertion if Chromium isn't present locally rather
        // than failing the suite.
        try {
            const probe = await chromium?.launch({ headless: true });
            if (!probe) return;
            await probe.close();
        } catch (err) {
            console.warn(
                `Skipping run-after-clear test: Chromium not available (${(err as Error).message})`,
            );
            return;
        }

        // Use shared options (same projectPath, same startUrl) so the
        // ONLY thing different between runs is the SiteDiscovery instance.
        // Without the fix, run #2 would silently drain because the cached
        // RequestQueue still has baseUrl marked handled from run #1.
        const baseOptions = {
            projectPath: testDir,
            startUrl: baseUrl,
            maxPages: 5,
            maxDepth: 1,
            timeout: 15_000,
            // pauseOnAuth doesn't matter here (no auth wall on this fixture)
            // but explicit-off keeps the test deterministic if a future
            // detector misclassifies a heading.
            pauseOnAuth: false,
        };

        // ── Run #1 ─────────────────────────────────────────────────────
        const first = new SiteDiscovery(baseOptions);
        await first.start();
        const firstStats = first.getStats();
        await first.close();

        expect(
            firstStats.pagesDiscovered,
            "run #1 should discover at least the root page",
        ).toBeGreaterThanOrEqual(1);

        // ── User clicks "Clear Data" ───────────────────────────────────
        // The dashboard's `clearDiscoveryData` mutation wipes the same
        // tables this call does (pages, links, blockers, sessions). We
        // simulate it directly so the next run starts with an empty
        // SiteKnowledgeDB — matching what the user reported.
        const clearDb = new CodeGraphDB(testDir);
        try {
            const clearSiteDb = new SiteKnowledgeDB(clearDb.getRawDatabase(), testDir);
            clearSiteDb.clearDiscoveryData();
        } finally {
            clearDb.close();
        }

        // ── Run #2 (same process, same URL, freshly cleared DB) ────────
        // Pre-fix: this crawl returned in <300ms with `requestsTotal: 0`
        // and `pagesDiscovered: 0`, falling through to the generic
        // "page rendered nothing" error. Crawlee's cached default
        // RequestQueue still had baseUrl marked handled from run #1, so
        // `addRequests` deduped it away and the handler never fired.
        //
        // Post-fix: the unique per-instance queue name forces a fresh
        // RequestQueue, the request handler runs, and the page is
        // discovered again.
        const second = new SiteDiscovery(baseOptions);
        await second.start();
        const secondStats = second.getStats();
        await second.close();

        expect(
            secondStats.pagesDiscovered,
            "run #2 must also discover the root page (regression: queue cache from run #1 was draining run #2 to 0 pages)",
        ).toBeGreaterThanOrEqual(1);

        // Both runs should have completed cleanly (not failed with the
        // empty-crawl error). Status === "completed" is the positive
        // signal that the diagnostic in `buildEmptyCrawlError` did NOT
        // fire on either run.
        expect(firstStats.status, "run #1 status").toBe("completed");
        expect(secondStats.status, "run #2 status").toBe("completed");

        // ── Run #3 (same DB, pages already exist) ─────────────────────
        // A successful refresh must count as session progress even though it
        // updates an existing row rather than inserting a new one. Pre-fix,
        // pagesDiscovered stayed at 0 and the crawl falsely failed with
        // "No pages discovered" despite rendering and refreshing the page.
        const third = new SiteDiscovery(baseOptions);
        await third.start();
        const thirdStats = third.getStats();
        await third.close();

        expect(
            thirdStats.pagesDiscovered,
            "run #3 should count successfully refreshed pages",
        ).toBeGreaterThanOrEqual(1);
        expect(thirdStats.status, "run #3 status").toBe("completed");

        // ── Knowledge-consistency invariants ──────────────────────────
        // After three runs the derived views must agree: no link stays
        // "pending" when its target page is stored, no terminal session
        // carries a blocked_at_url, and session counters never exceed the
        // persisted row counts.
        const checkDb = new CodeGraphDB(testDir);
        try {
            const checkSiteDb = new SiteKnowledgeDB(checkDb.getRawDatabase(), testDir);
            const report = validateKnowledgeConsistency(checkSiteDb);
            expect(
                report.violations,
                "knowledge base must be internally consistent after the runs",
            ).toEqual([]);
        } finally {
            checkDb.close();
        }
    }, 60_000);
});
