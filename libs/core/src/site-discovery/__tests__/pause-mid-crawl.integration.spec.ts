/**
 * Pause-mid-crawl regression spec (disc-1).
 *
 * `SiteDiscovery.pause()` calls `crawler.teardown()` (via
 * `AutoscaledPool.abort()`) to stop the crawl immediately, without waiting
 * for in-flight page handlers to finish. If a worker is mid-navigation when
 * that happens, Playwright's browser/context/page can be torn down out from
 * under it, throwing "Target page, context or browser has been closed" (or
 * similar) from whatever call the handler was awaiting.
 *
 * A *clean* pause (user clicked Pause, or the wall-clock cap fired) must
 * never be reported as a crawl failure: `start()` should resolve (not
 * reject), `stats.status` must be `"paused"`, and the session row must be
 * `"paused"` — not `"failed"`. This spec drives a real Chromium crawl
 * against a slow local server and pauses while a worker is actively
 * navigating, to catch a regression where the teardown race bubbles up as
 * an unhandled rejection from `crawler.run()` or gets misreported as a
 * failed session.
 *
 * Skipped when Chromium isn't installed locally (matches the other
 * discovery integration specs).
 */

import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CodeGraphDB } from "../../database/db";
import { SiteDiscovery } from "../crawler";
import { SiteKnowledgeDB } from "../db";

const PAGE_COUNT = 12;
// Deliberately slow so a request is virtually guaranteed to still be
// in-flight when we call `pause()` shortly after `start()` begins.
const RESPONSE_DELAY_MS = 400;

function pageHtml(n: number): string {
    const links = Array.from({ length: PAGE_COUNT }, (_, i) => i)
        .filter((i) => i !== n)
        .map((i) => `<a href="/page-${i}">Page ${i}</a>`)
        .join("\n");
    return `<!doctype html><html><head><title>Page ${n}</title></head><body><h1>Page ${n}</h1>${links}</body></html>`;
}

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

// Module-level so both the server handler and the test can see live
// request counts without threading state through helpers.
let requestsReceived = 0;

/** Poll until at least `n` requests have hit the server (i.e. are in flight,
 * since the server itself delays every response by `RESPONSE_DELAY_MS`). */
async function waitForRequestsReceived(n: number, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (requestsReceived < n) {
        if (Date.now() > deadline) {
            throw new Error(
                `Timed out waiting for ${n} request(s) to reach the server (got ${requestsReceived})`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describeIfBrowser("pause-mid-crawl regression (disc-1)", () => {
    let server: http.Server;
    let baseUrl: string;
    let testDir: string;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            requestsReceived++;
            const match = /^\/page-(\d+)/.exec(req.url ?? "");
            const n = match?.[1] ? Number.parseInt(match[1], 10) : 0;
            setTimeout(() => {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                res.end(pageHtml(n));
            }, RESPONSE_DELAY_MS);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}/page-0`;

        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-pause-mid-crawl-"));
    });

    afterAll(async () => {
        if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("resolves cleanly (not as a failure) when paused while a request is in flight", async () => {
        try {
            const probe = await chromium?.launch({ headless: true });
            if (!probe) return;
            await probe.close();
        } catch (err) {
            console.warn(
                `Skipping pause-mid-crawl test: Chromium not available (${(err as Error).message})`,
            );
            return;
        }

        requestsReceived = 0;
        const discovery = new SiteDiscovery({
            projectPath: testDir,
            startUrl: baseUrl,
            maxPages: PAGE_COUNT,
            maxDepth: 3,
            maxConcurrency: 3,
            timeout: 15_000,
            pauseOnAuth: false,
        });

        let startError: unknown = null;
        const startPromise = discovery.start().catch((err) => {
            startError = err;
        });

        // Wait until the server has actually *received* the request — since
        // it holds every response for RESPONSE_DELAY_MS, this guarantees a
        // worker is genuinely in-flight (browser launched, page navigating,
        // handler awaiting the response) when we call pause() below.
        await waitForRequestsReceived(1);

        await discovery.pause();
        await startPromise;

        expect(
            startError,
            `start() must resolve cleanly on a user-initiated pause, not reject (got: ${String(startError)})`,
        ).toBeNull();

        const stats = discovery.getStats();
        expect(stats.status).toBe("paused");

        await discovery.close();
    }, 30_000);

    it("marks the session row paused (not failed) in the database", async () => {
        try {
            const probe = await chromium?.launch({ headless: true });
            if (!probe) return;
            await probe.close();
        } catch (err) {
            console.warn(
                `Skipping pause-mid-crawl DB check: Chromium not available (${(err as Error).message})`,
            );
            return;
        }

        const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-pause-mid-crawl-db-"));
        try {
            requestsReceived = 0;
            const discovery = new SiteDiscovery({
                projectPath: runDir,
                startUrl: baseUrl,
                maxPages: PAGE_COUNT,
                maxDepth: 3,
                maxConcurrency: 3,
                timeout: 15_000,
                pauseOnAuth: false,
            });

            const startPromise = discovery.start();
            await waitForRequestsReceived(1);
            await discovery.pause();
            await startPromise;
            await discovery.close();

            const db = new CodeGraphDB(runDir);
            try {
                const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), runDir);
                const session = siteDb.getActiveSession();
                expect(session?.status).toBe("paused");
            } finally {
                db.close();
            }
        } finally {
            fs.rmSync(runDir, { recursive: true, force: true });
        }
    }, 30_000);

    it("does not deadlock when the blocker-triggered in-handler pause drains its own request", async () => {
        // Regression guard for the `calledFromHandler` branch: `pause()`
        // called from *inside* `handleRequest` (auth blocker fires) must
        // wait for concurrency to drop to 1 (every OTHER worker), not 0 —
        // waiting for 0 would deadlock forever since this very call is
        // one of the currently-running tasks and can't finish until
        // `pause()` returns.
        try {
            const probe = await chromium?.launch({ headless: true });
            if (!probe) return;
            await probe.close();
        } catch (err) {
            console.warn(
                `Skipping in-handler pause test: Chromium not available (${(err as Error).message})`,
            );
            return;
        }

        const authServer = http.createServer((_req, res) => {
            res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
            res.end("<!doctype html><html><body>Unauthorized</body></html>");
        });
        await new Promise<void>((resolve) => authServer.listen(0, "127.0.0.1", resolve));
        const authAddr = authServer.address() as AddressInfo;
        const authUrl = `http://127.0.0.1:${authAddr.port}/login`;

        const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-pause-in-handler-"));
        try {
            const discovery = new SiteDiscovery({
                projectPath: runDir,
                startUrl: authUrl,
                maxPages: 5,
                maxDepth: 1,
                maxConcurrency: 1,
                timeout: 15_000,
                pauseOnAuth: true,
            });

            const startedAt = Date.now();
            await discovery.start();
            const elapsedMs = Date.now() - startedAt;

            const stats = discovery.getStats();
            expect(stats.status).toBe("paused");
            // With a single in-flight request (this very one), the
            // concurrency-drain should resolve near-instantly rather than
            // waiting out the full grace window — confirms no deadlock.
            expect(
                elapsedMs,
                `in-handler pause took ${elapsedMs}ms — looks like it waited out the full drain window instead of detecting concurrency already at threshold`,
            ).toBeLessThan(4_000);

            await discovery.close();
        } finally {
            fs.rmSync(runDir, { recursive: true, force: true });
            await new Promise<void>((resolve) => authServer.close(() => resolve()));
        }
    }, 30_000);
});
