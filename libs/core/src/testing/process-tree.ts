import { spawn, spawnSync } from "node:child_process";

/**
 * Kill a child process AND everything it spawned (npx -> playwright -> node
 * -> browser).
 *
 * A bare `child.kill(signal)` only signals the immediate child, which is the
 * `npx` launcher rather than the Playwright workers and browsers it goes on to
 * spawn. Those descendants do not receive the signal. The result: we think we
 * killed the run, but Playwright and a live browser keep running, accumulating
 * zombie processes across retries.
 *
 * The fix is platform-specific:
 *  - POSIX: spawn with `detached: true` (makes the child its own process
 *    group leader), then signal the whole group via `process.kill(-pid, ...)`.
 *  - Windows: there's no signal-based equivalent; `taskkill /T /F` walks and
 *    force-kills the process tree rooted at `pid` directly.
 *
 * One more POSIX wrinkle: a group kill only reaches processes in the child's
 * own group. Detached grandchildren lead their OWN groups — Playwright spawns
 * `config.webServer` detached, so killing the Playwright group leaves the dev
 * server orphaned and still listening. We therefore enumerate the child's
 * descendants and signal each of their process groups as well.
 *
 * Returns the descendant PIDs that were signaled, so callers escalating to a
 * later SIGKILL can re-signal descendants even after the root process has
 * exited (once the root is gone, reparented orphans are no longer
 * discoverable from it).
 */
export function killProcessTree(
    pid: number,
    signal: NodeJS.Signals = "SIGTERM",
    extraPids: readonly number[] = [],
): number[] {
    if (process.platform === "win32") {
        // Windows has no SIGTERM equivalent for arbitrary processes, so any
        // requested signal is treated as "stop it" via a forceful tree-kill.
        try {
            spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
        } catch {
            // Best-effort — nothing more we can do if taskkill itself fails to spawn.
        }
        return [];
    }

    const descendants = [...collectDescendantPids(pid), ...extraPids];
    for (const target of [pid, ...descendants]) {
        signalProcessGroup(target, signal);
    }
    return descendants;
}

/**
 * Negative PID signals the whole process GROUP, not just `pid`. If `pid`
 * leads no group (ESRCH), fall back to signaling just the one process.
 */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // Already exited — nothing to do.
        }
    }
}

/** Best-effort recursive child-PID listing via `pgrep -P` (macOS/Linux). */
function collectDescendantPids(rootPid: number): number[] {
    const descendants: number[] = [];
    const seen = new Set<number>([rootPid]);
    const queue = [rootPid];
    for (let i = 0; i < queue.length; i++) {
        const result = spawnSync("pgrep", ["-P", String(queue[i])], { encoding: "utf8" });
        // status 1 = no children; anything else means pgrep failed — either
        // way this subtree has no discoverable children.
        if (result.error || result.status !== 0 || !result.stdout) continue;
        for (const line of result.stdout.split("\n")) {
            const childPid = Number.parseInt(line.trim(), 10);
            if (!Number.isNaN(childPid) && !seen.has(childPid)) {
                seen.add(childPid);
                descendants.push(childPid);
                queue.push(childPid);
            }
        }
    }
    return descendants;
}
