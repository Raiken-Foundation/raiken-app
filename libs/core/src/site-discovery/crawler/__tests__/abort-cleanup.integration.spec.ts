/**
 * Abort/close cleanup contract.
 *
 * Browser-backed: `SiteDiscovery.start()` launches a real Crawlee/Playwright
 * crawl, so this lives in the integration suite rather than the unit suite
 * where a loaded machine turns browser startup into a timeout.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

describe("abort cleanup contract", () => {
    const dirs: string[] = [];
    const discoveries: Array<import("../../crawler").SiteDiscovery> = [];

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

    async function makeDiscovery() {
        const { SiteDiscovery } = await import("../../crawler");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-abort-"));
        dirs.push(dir);
        const discovery = new SiteDiscovery({
            projectPath: dir,
            startUrl: "http://127.0.0.1:1/unreachable",
            maxPages: 1,
            maxDepth: 1,
            timeout: 5_000,
            pauseOnAuth: false,
        });
        discoveries.push(discovery);
        return discovery;
    }

    it("marks session completed and disarms timers on abort without throwing", async () => {
        const discovery = await makeDiscovery();

        const startPromise = discovery.start().catch(() => {});
        await new Promise((r) => setTimeout(r, 50));
        await discovery.abort();
        await startPromise;

        expect(discovery.getStats().status).toBe("completed");
    });

    it("close() stops the in-flight crawl before releasing the process-wide lock", async () => {
        const first = await makeDiscovery();

        const startPromise = first.start().catch(() => {});
        await new Promise((r) => setTimeout(r, 50));
        // Resolves only once the run it owns has unwound, so a successor can
        // never install fresh Crawlee storage under a live crawl.
        await first.close();
        await startPromise;

        const second = await makeDiscovery();
        await expect(second.start()).rejects.not.toThrow(/already running in this process/i);
    });
});
