/**
 * Cross-process discovery lock regression spec (disc-3).
 *
 * `SiteDiscovery.start()`'s in-memory `activeProcessWideCrawl` guard (see
 * `process-lock.spec.ts`) only protects against two crawls racing within a
 * *single* Node process. It says nothing about two independent OS processes
 * (dashboard server, `raiken discover`, REPL background discovery) crawling
 * the same project directory at the same time. `project-lock.ts` adds a
 * real cross-process lock (via `proper-lockfile`'s atomic `fs.mkdir`) for
 * exactly that case.
 *
 * We can't spawn a literal second OS process in a unit test cheaply, but we
 * can hold the *same* lock file that a second process would contend on —
 * `proper-lockfile`'s locking is filesystem-based and doesn't care which
 * process calls `lock()`, only whether the lock file/mtime says it's held.
 * That's a faithful simulation of "another process already has it".
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { lock as lockfileLock } from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";

import { SiteDiscovery } from "../crawler";
import { acquireDiscoveryLock } from "../project-lock";

describe("cross-process discovery lock (disc-3)", () => {
    const dirs: string[] = [];
    const releasers: Array<() => Promise<void>> = [];

    function makeProjectDir(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-cross-lock-"));
        dirs.push(dir);
        return dir;
    }

    afterEach(async () => {
        for (const release of releasers) {
            await release().catch(() => {});
        }
        releasers.length = 0;
        for (const dir of dirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        dirs.length = 0;
    });

    it("rejects when another (simulated) process already holds the lock for this project", async () => {
        const projectPath = makeProjectDir();
        fs.mkdirSync(path.join(projectPath, ".raiken"), { recursive: true });

        // Simulate "process A" by locking the exact same target directly.
        const release = await lockfileLock(path.join(projectPath, ".raiken", "operation.lock"), {
            realpath: false,
            stale: 45_000,
            update: 15_000,
            retries: 0,
        });
        releasers.push(release);

        await expect(acquireDiscoveryLock(projectPath)).rejects.toThrow(
            /already active for this project/i,
        );
    });

    it("succeeds once the other holder releases the lock", async () => {
        const projectPath = makeProjectDir();
        fs.mkdirSync(path.join(projectPath, ".raiken"), { recursive: true });

        const release = await lockfileLock(path.join(projectPath, ".raiken", "operation.lock"), {
            realpath: false,
            stale: 45_000,
            update: 15_000,
            retries: 0,
        });
        await release();

        const handle = await acquireDiscoveryLock(projectPath);
        await handle.release();
    });

    it("does not cross-contaminate two different projects", async () => {
        const projectA = makeProjectDir();
        const projectB = makeProjectDir();

        const handleA = await acquireDiscoveryLock(projectA);
        // A completely different project directory must never contend with
        // project A's lock.
        const handleB = await acquireDiscoveryLock(projectB);

        await handleA.release();
        await handleB.release();
    });

    it("SiteDiscovery.start() itself fails fast when a sibling process holds the project lock", async () => {
        const projectPath = makeProjectDir();
        fs.mkdirSync(path.join(projectPath, ".raiken"), { recursive: true });

        // Simulate a sibling OS process already crawling this project.
        const release = await lockfileLock(path.join(projectPath, ".raiken", "operation.lock"), {
            realpath: false,
            stale: 45_000,
            update: 15_000,
            retries: 0,
        });
        releasers.push(release);

        const discovery = new SiteDiscovery({
            projectPath,
            startUrl: "http://127.0.0.1:1/unreachable",
            maxPages: 1,
            maxDepth: 1,
            timeout: 15_000,
            pauseOnAuth: false,
        });

        // Must reject with the lock message specifically — not fall through
        // to a browser launch, a network attempt, or any other failure mode.
        await expect(discovery.start()).rejects.toThrow(/already active for this project/i);
        await discovery.close();
    });
});
