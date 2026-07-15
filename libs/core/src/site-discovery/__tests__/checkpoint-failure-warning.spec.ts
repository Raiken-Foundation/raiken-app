/**
 * Checkpoint-failure-warning regression spec (disc-6).
 *
 * `persistQueueState()` used to swallow any error from `siteDb.updateSession`
 * with a bare `catch {}` — a locked/corrupt DB, a full disk, or
 * non-serializable `userData` would silently break checkpointing for the
 * rest of the crawl. Since disc-4 made this run immediately AND every 15s,
 * a persistently failing checkpoint gave zero signal that resuming after an
 * interruption would lose the entire unvisited queue. The fix emits a
 * one-time `"warning"` event instead of swallowing the error, without
 * spamming a warning on every subsequent periodic tick.
 *
 * These tests call the private `persistQueueState()` directly (via a type
 * assertion, matching the pattern used for `handleWatcherFileEvent` in
 * `code-graph.spec.ts`) so they don't need to drive a real crawl or browser.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SiteDiscovery } from "../crawler";

type PersistQueueStateHarness = {
    sessionId: number | null;
    siteDb: { updateSession: (id: number, updates: Record<string, unknown>) => void };
    persistQueueState: () => Promise<void>;
};

describe("SiteDiscovery checkpoint failure warning (disc-6)", () => {
    const dirs: string[] = [];
    const discoveries: SiteDiscovery[] = [];

    function makeProjectDir(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-checkpoint-warn-"));
        dirs.push(dir);
        return dir;
    }

    function makeDiscovery(): SiteDiscovery {
        const discovery = new SiteDiscovery({
            projectPath: makeProjectDir(),
            startUrl: "http://127.0.0.1:1/unreachable",
            maxPages: 1,
            maxDepth: 1,
            timeout: 15_000,
            pauseOnAuth: false,
        });
        discoveries.push(discovery);
        return discovery;
    }

    afterEach(async () => {
        for (const discovery of discoveries) {
            await discovery.close().catch(() => {});
        }
        discoveries.length = 0;
        for (const dir of dirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        dirs.length = 0;
    });

    it("emits a warning (instead of failing silently) when the queue checkpoint write throws", async () => {
        const discovery = makeDiscovery();
        const harness = discovery as unknown as PersistQueueStateHarness;
        harness.sessionId = 1;
        vi.spyOn(harness.siteDb, "updateSession").mockImplementation(() => {
            throw new Error("disk full");
        });

        const warnings: Array<{ data: { code: string; message: string } }> = [];
        discovery.on("warning", (event) => warnings.push(event));

        await harness.persistQueueState();

        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.data.code).toBe("checkpoint_failed");
        expect(warnings[0]?.data.message).toMatch(/checkpoint/i);
        expect(warnings[0]?.data.message).toMatch(/disk full/i);
    });

    it("does not spam a warning on every subsequent failed checkpoint", async () => {
        const discovery = makeDiscovery();
        const harness = discovery as unknown as PersistQueueStateHarness;
        harness.sessionId = 1;
        vi.spyOn(harness.siteDb, "updateSession").mockImplementation(() => {
            throw new Error("db is locked");
        });

        const warnings: unknown[] = [];
        discovery.on("warning", (event) => warnings.push(event));

        await harness.persistQueueState();
        await harness.persistQueueState();
        await harness.persistQueueState();

        expect(warnings).toHaveLength(1);
    });

    it("emits no warning at all when checkpointing succeeds", async () => {
        const discovery = makeDiscovery();
        const harness = discovery as unknown as PersistQueueStateHarness;
        harness.sessionId = 1;

        const warnings: unknown[] = [];
        discovery.on("warning", (event) => warnings.push(event));

        await harness.persistQueueState();

        expect(warnings).toHaveLength(0);
    });
});
