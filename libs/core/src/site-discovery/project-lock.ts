/**
 * Cross-process "one discovery crawl per project" lock.
 *
 * `SiteDiscovery`'s own process-wide guard (see `crawler.ts`) only protects
 * against two crawls racing *within the same Node process*. In real usage
 * a single project directory can be targeted by several independent OS
 * processes at once — the dashboard server (`raiken start`), a direct
 * `raiken discover <url>` invocation, and the interactive REPL's background
 * discovery all construct their own `SiteDiscovery` with no awareness of
 * each other. Without cross-process coordination, two crawlers could:
 *
 *   - Both insert a "running" row into `discovery_sessions` for the same
 *     project, so `getActiveSession()` (ORDER BY started_at DESC LIMIT 1)
 *     becomes ambiguous and a resume can pick up the wrong one.
 *   - Race each other's checkpoint writes (`queueJson`, page/link counts),
 *     silently losing whichever one wrote last.
 *   - Launch two real browsers hitting the same target site concurrently,
 *     doubling load and confusing rate-limit/bot-detection heuristics.
 *
 * We use `proper-lockfile` (atomic `fs.mkdir`-based locking, already a
 * transitive dependency) rather than hand-rolling PID/staleness detection:
 * it periodically renews the lock's mtime while held and treats a lock
 * whose mtime has gone stale (crash, `kill -9`, power loss) as free, so a
 * dead holder can never wedge a project's discovery forever.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { lock as lockfileLock } from "proper-lockfile";
import { conflictError } from "../errors";

const STALE_MS = 45_000;
const UPDATE_MS = 15_000;

/**
 * Stale threshold for the lock's mtime. Generous relative to the
 * `update` renewal interval below so a single slow event-loop tick can't
 * false-positive a live crawl as stale, but still short enough that a
 * crashed process's lock frees up well within a user's patience.
 */
export interface DiscoveryLockHandle {
    release(): Promise<void>;
}

/**
 * Acquire the cross-process discovery lock for `projectPath`. Rejects
 * immediately (no retries) if another process already holds a live lock —
 * callers should surface this as a clear "already running elsewhere" error
 * rather than silently proceeding.
 */
export async function acquireDiscoveryLock(projectPath: string): Promise<DiscoveryLockHandle> {
    const directory = path.join(projectPath, ".raiken");
    fs.mkdirSync(directory, { recursive: true });

    try {
        const releaseLock = await lockfileLock(path.join(directory, "discovery.lock"), {
            realpath: false,
            stale: STALE_MS,
            update: UPDATE_MS,
            retries: 0,
        });
        let released = false;
        return {
            async release() {
                if (released) return;
                released = true;
                await releaseLock();
            },
        };
    } catch (error) {
        if ((error as { code?: string })?.code === "ELOCKED") {
            throw conflictError("Discovery is already running for this project.", {
                code: "DISCOVERY_ALREADY_RUNNING",
            });
        }
        throw error;
    }
}
