import { spawn } from "node:child_process";

/**
 * Kill a child process AND everything it spawned (npx -> playwright -> node
 * -> browser).
 *
 * A bare `child.kill(signal)` only signals the immediate child. Because
 * cross-platform `npx` resolution requires `spawn(..., { shell: true })`,
 * that immediate child is a shell wrapper (`/bin/sh -c "..."` or
 * `cmd.exe /c ...`) — and a shell does NOT forward signals to the processes
 * it launches. The result: we think we killed the run, but Playwright and a
 * live browser keep running, accumulating zombie processes across retries.
 *
 * The fix is platform-specific:
 *  - POSIX: spawn with `detached: true` (makes the child its own process
 *    group leader), then signal the whole group via `process.kill(-pid, ...)`.
 *  - Windows: there's no signal-based equivalent; `taskkill /T /F` walks and
 *    force-kills the process tree rooted at `pid` directly.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
    if (process.platform === "win32") {
        // Windows has no SIGTERM equivalent for arbitrary processes, so any
        // requested signal is treated as "stop it" via a forceful tree-kill.
        try {
            spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
        } catch {
            // Best-effort — nothing more we can do if taskkill itself fails to spawn.
        }
        return;
    }

    try {
        // Negative PID signals the whole process GROUP, not just `pid` —
        // this only works because the process was spawned with
        // `detached: true`, which makes it its own group leader.
        process.kill(-pid, signal);
    } catch {
        // Group may already be gone, or (rare) this process was never its
        // own group leader — fall back to signaling just the one PID.
        try {
            process.kill(pid, signal);
        } catch {
            // Already exited — nothing to do.
        }
    }
}
