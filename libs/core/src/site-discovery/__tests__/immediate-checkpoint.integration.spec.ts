/**
 * Immediate-checkpoint regression spec (disc-4).
 *
 * `armCheckpointTimer()` used to only schedule a `setInterval`, whose first
 * tick doesn't fire until `CHECKPOINT_INTERVAL_MS` (15s) has elapsed. If the
 * process is killed hard (crash, `kill -9`, OOM, laptop sleep) any time
 * before that first tick — plausible even a few seconds in, since several
 * pages can be discovered and queued that fast — `queueJson` in the DB
 * still reflects whatever it was *before this run started* (`null` for a
 * fresh session). A resume then has no idea those links were ever found:
 * progress silently vanishes without any error being raised.
 *
 * The fix persists the queue once immediately when the checkpoint timer is
 * armed (right as `crawler.run()` begins), in addition to the periodic
 * timer. This spec drives a real crawl against a multi-page local server,
 * waits only long enough for pages to be discovered — deliberately well
 * under the 15s interval — and asserts the session row's `queueJson`
 * already reflects real queued work before the periodic timer could ever
 * have fired.
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

const PAGE_COUNT = 10;

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

/** Read the most recent session row for a project, regardless of status. */
function readLatestQueueJson(projectPath: string): string | null {
    const db = new CodeGraphDB(projectPath);
    try {
        const row = db
            .getRawDatabase()
            .prepare(
                `SELECT queue_json FROM discovery_sessions
                 WHERE project_path = ?
                 ORDER BY started_at DESC
                 LIMIT 1`,
            )
            .get(projectPath) as { queue_json: string | null } | undefined;
        return row?.queue_json ?? null;
    } finally {
        db.close();
    }
}

describeIfBrowser("immediate-checkpoint regression (disc-4)", () => {
    let server: http.Server;
    let baseUrl: string;
    let testDir: string;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const match = /^\/page-(\d+)/.exec(req.url ?? "");
            const n = match?.[1] ? Number.parseInt(match[1], 10) : 0;
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(pageHtml(n));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}/page-0`;

        testDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-immediate-checkpoint-"));
    });

    afterAll(async () => {
        if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("persists a real queue checkpoint well before the 15s periodic interval could fire", async () => {
        try {
            const probe = await chromium?.launch({ headless: true });
            if (!probe) return;
            await probe.close();
        } catch (err) {
            console.warn(
                `Skipping immediate-checkpoint test: Chromium not available (${(err as Error).message})`,
            );
            return;
        }

        const discovery = new SiteDiscovery({
            projectPath: testDir,
            startUrl: baseUrl,
            maxPages: PAGE_COUNT,
            maxDepth: 3,
            maxConcurrency: 2,
            timeout: 15_000,
            pauseOnAuth: false,
        });

        let startError: unknown = null;
        const startPromise = discovery.start().catch((err) => {
            startError = err;
        });

        // Give the crawler a few seconds to discover the seed page and
        // queue its links — comfortably inside the 15s checkpoint interval,
        // so any persisted queue we see here can only be from the
        // *immediate* checkpoint, never the periodic one.
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline && discovery.getStats().pagesDiscovered === 0) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        expect(
            discovery.getStats().pagesDiscovered,
            "expected at least one page to be discovered within the wait window",
        ).toBeGreaterThan(0);

        const elapsedSinceStart = Date.now() - discovery.getStats().startedAt;
        expect(
            elapsedSinceStart,
            "test setup assumption violated — check ran too close to the 15s checkpoint interval to prove 'immediate'",
        ).toBeLessThan(15_000);

        // Hard-kill equivalent: abort immediately, well under 15s from
        // start, without ever letting the periodic interval tick.
        await discovery.abort();
        await startPromise;
        expect(startError).toBeNull();
        await discovery.close();

        const queueJson = readLatestQueueJson(testDir);
        expect(
            queueJson,
            "queueJson must not be null this early — the immediate checkpoint should have persisted it",
        ).not.toBeNull();
        const parsed = JSON.parse(queueJson ?? "[]") as unknown[];
        expect(
            Array.isArray(parsed) && parsed.length > 0,
            `expected at least one queued URL in the early checkpoint, got: ${queueJson}`,
        ).toBe(true);
    }, 30_000);
});
