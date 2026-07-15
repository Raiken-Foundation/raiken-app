/**
 * Process-wide crawl lock regression spec (disc-2).
 *
 * `SiteDiscovery.start()` installs a fresh Crawlee `MemoryStorage` onto the
 * *process-global* `Configuration` singleton on every call. If two
 * `SiteDiscovery` instances in the same Node process ever call `start()`
 * concurrently, the second call's storage-client swap yanks the storage out
 * from under the first crawl's already-open `RequestQueue`/browser pool,
 * corrupting or crashing it. `start()` guards against this with a
 * module-level lock that fails fast instead of racing shared global state.
 *
 * These tests don't need a real browser: the lock check happens before any
 * async work (browser launch, network, DB), so a concurrent `start()` call
 * rejects synchronously-ish, before Crawlee is ever touched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SiteDiscovery } from "../crawler";

describe("SiteDiscovery process-wide crawl lock (disc-2)", () => {
    const dirs: string[] = [];
    const discoveries: SiteDiscovery[] = [];

    function makeProjectDir(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-process-lock-"));
        dirs.push(dir);
        return dir;
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

    it("rejects a second concurrent start() in the same process instead of racing global config", async () => {
        const first = new SiteDiscovery({
            projectPath: makeProjectDir(),
            startUrl: "http://127.0.0.1:1/unreachable",
            maxPages: 1,
            maxDepth: 1,
            timeout: 15_000,
            pauseOnAuth: false,
        });
        discoveries.push(first);

        // Intentionally not awaited: the lock is acquired synchronously
        // (before the first internal `await`), so it's held by the time this
        // call expression returns control to us. Swallow whatever happens to
        // this crawl later — we only care that it's holding the lock.
        const firstPromise = first.start().catch(() => {});

        const second = new SiteDiscovery({
            projectPath: makeProjectDir(),
            startUrl: "http://127.0.0.1:1/unreachable",
            maxPages: 1,
            maxDepth: 1,
            timeout: 15_000,
            pauseOnAuth: false,
        });
        discoveries.push(second);

        await expect(second.start()).rejects.toThrow(/already running in this process/i);

        // Short-circuit the first crawl (an unreachable port would otherwise
        // burn through Crawlee's retry budget) rather than waiting it out.
        await first.abort();
        await firstPromise;
    });

    it("releases the lock on close(), allowing a new crawl to start", async () => {
        const first = new SiteDiscovery({
            projectPath: makeProjectDir(),
            startUrl: "http://127.0.0.1:1/unreachable",
            maxPages: 1,
            maxDepth: 1,
            timeout: 15_000,
            pauseOnAuth: false,
        });

        const firstPromise = first.start().catch(() => {});
        await first.close();
        await firstPromise;

        const second = new SiteDiscovery({
            projectPath: makeProjectDir(),
            startUrl: "http://127.0.0.1:1/unreachable",
            maxPages: 1,
            maxDepth: 1,
            timeout: 15_000,
            pauseOnAuth: false,
        });
        discoveries.push(second);

        // Should not throw the "already running" lock error — it may still
        // fail for unrelated reasons (unreachable URL), which is fine; we
        // only assert it's not the lock contention error.
        await expect(second.start()).rejects.not.toThrow(/already running in this process/i);
    });

    it("releases the lock when start() throws, even if close() is never called", async () => {
        const first = new SiteDiscovery({
            projectPath: makeProjectDir(),
            startUrl: "http://127.0.0.1:1/unreachable",
            maxPages: 1,
            maxDepth: 1,
            timeout: 15_000,
            pauseOnAuth: false,
        });
        discoveries.push(first);

        // A crawl against a closed local port with a fresh crawl (no pages
        // discovered) throws from within `start()`'s own try block (S6:
        // "empty crawl" guard) — this exercises the catch-block lock release
        // without ever calling close().
        await expect(first.start()).rejects.toThrow();

        const second = new SiteDiscovery({
            projectPath: makeProjectDir(),
            startUrl: "http://127.0.0.1:1/unreachable",
            maxPages: 1,
            maxDepth: 1,
            timeout: 15_000,
            pauseOnAuth: false,
        });
        discoveries.push(second);

        await expect(second.start()).rejects.not.toThrow(/already running in this process/i);
    });
});
