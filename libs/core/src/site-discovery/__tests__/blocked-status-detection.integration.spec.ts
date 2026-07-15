/**
 * Blocked-status auth detection regression spec.
 *
 * Crawlee's `PlaywrightCrawler` has its own, separate "is this response
 * blocked" check baked into its session pool: by default it treats HTTP
 * 401/403/429 (`BLOCKED_STATUS_CODES` in `@crawlee/core`) as a blocked
 * session, throws internally, and silently retries the request against a
 * fresh session up to `maxRequestRetries` times (default 3) — all of this
 * happens *before* our own `handleRequest` is ever invoked.
 *
 * That collided head-on with `createAuthDetector`'s explicit, "strongest
 * signal" check for the exact same status codes (`checkHttpStatus` in
 * `detectors/auth.ts`): in a real crawl, a page that returns a raw 401/403
 * (Basic Auth, an API-gated route, a reverse-proxy auth wall, ...) never
 * reached our detector pipeline at all. It just silently retried three
 * times against Crawlee's session pool and then landed in
 * `failedRequests` as a generic "HTTP 401" — no `auth_required` blocker,
 * no pause, no `raiken auth` prompt, and the crawl would report a
 * confusing empty-crawl diagnostic instead of a clean, resumable pause.
 *
 * `SiteDiscovery` now disables Crawlee's own blocked-status handling
 * (`sessionPoolOptions: { blockedStatusCodes: [] }`) so these responses
 * flow through to our own detector pipeline, which classifies and pauses
 * on them correctly. This spec drives a real crawl against a server that
 * returns a raw 401 and asserts the crawl pauses with a proper
 * `auth_required` blocker rather than silently failing the request.
 *
 * Skipped when Chromium isn't installed locally (matches the other
 * discovery integration specs).
 */

import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodeGraphDB } from "../../database/db";
import { SiteDiscovery } from "../crawler";
import { SiteKnowledgeDB } from "../db";

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

describeIfBrowser("blocked-status auth detection regression", () => {
    let server: http.Server;
    let testDir: string;
    let statusToReturn = 401;

    beforeEach(async () => {
        server = http.createServer((_req, res) => {
            res.writeHead(statusToReturn, { "content-type": "text/html; charset=utf-8" });
            res.end("<!doctype html><html><body>Unauthorized</body></html>");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-blocked-status-"));
    });

    afterEach(async () => {
        if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function probeChromium(): Promise<boolean> {
        try {
            const probe = await chromium?.launch({ headless: true });
            if (!probe) return false;
            await probe.close();
            return true;
        } catch (err) {
            console.warn(
                `Skipping blocked-status test: Chromium not available (${(err as Error).message})`,
            );
            return false;
        }
    }

    it("pauses with an auth_required blocker on a raw HTTP 401 (not a silent retry-and-fail)", async () => {
        if (!(await probeChromium())) return;
        statusToReturn = 401;
        const addr = server.address() as AddressInfo;
        const url = `http://127.0.0.1:${addr.port}/api/private`;

        const discovery = new SiteDiscovery({
            projectPath: testDir,
            startUrl: url,
            maxPages: 5,
            maxDepth: 1,
            maxConcurrency: 1,
            timeout: 15_000,
            pauseOnAuth: true,
        });

        await discovery.start();
        const stats = discovery.getStats();
        await discovery.close();

        // The core regression assertion: pre-fix, this request was
        // silently retried 3x by Crawlee's session pool and landed as a
        // generic failed request with zero blockers recorded — the crawl
        // never paused at all (it just "completed" with 0 pages and a
        // failed-request diagnostic).
        expect(stats.status).toBe("paused");
        expect(stats.authBlockersFound).toBeGreaterThanOrEqual(1);

        const db = new CodeGraphDB(testDir);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), testDir);
            const blockers = siteDb.getUnresolvedBlockers();
            expect(blockers.length).toBeGreaterThanOrEqual(1);
            const blocker = blockers[0];
            expect(blocker?.category).toBe("auth_required");
            expect(blocker?.detectorId).toBe("auth:http_status");
        } finally {
            db.close();
        }
    }, 30_000);

    it("also catches a raw HTTP 403 the same way", async () => {
        if (!(await probeChromium())) return;
        statusToReturn = 403;
        const addr = server.address() as AddressInfo;
        const url = `http://127.0.0.1:${addr.port}/admin`;

        const discovery = new SiteDiscovery({
            projectPath: testDir,
            startUrl: url,
            maxPages: 5,
            maxDepth: 1,
            maxConcurrency: 1,
            timeout: 15_000,
            pauseOnAuth: true,
        });

        await discovery.start();
        const stats = discovery.getStats();
        await discovery.close();

        expect(stats.status).toBe("paused");
        expect(stats.authBlockersFound).toBeGreaterThanOrEqual(1);
    }, 30_000);
});
