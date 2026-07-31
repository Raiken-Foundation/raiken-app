import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killProcessTree } from "../process-tree";

const isWin = process.platform === "win32";

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < ms) {
        if (cond()) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return false;
}

// POSIX-only: process-group semantics don't exist on Windows (taskkill path).
describe.skipIf(isWin)("killProcessTree", () => {
    const cleanup: Array<() => void> = [];

    afterEach(() => {
        for (const fn of cleanup.splice(0)) fn();
    });

    it("kills a detached grandchild that leads its own process group", async () => {
        const pidFile = join(tmpdir(), `raiken-ptree-${process.pid}-${Date.now()}.pid`);
        cleanup.push(() => rmSync(pidFile, { force: true }));

        // Root (detached, own group — like our playwright subprocess) spawns a
        // DETACHED grandchild (own group — like playwright's config.webServer),
        // records its PID, then idles.
        const root = spawn(
            process.execPath,
            [
                "-e",
                `const { spawn } = require("node:child_process");
                 const fs = require("node:fs");
                 const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
                 fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
                 g.unref();
                 setInterval(()=>{},1000);`,
            ],
            { detached: true, stdio: "ignore" },
        );
        const rootPid = root.pid;
        if (rootPid === undefined) throw new Error("spawn did not return a pid");
        root.unref();
        cleanup.push(() => {
            try {
                process.kill(-rootPid, "SIGKILL");
            } catch {
                // already gone
            }
        });

        const grandchildKnown = await waitFor(() => {
            try {
                return readFileSync(pidFile, "utf8").trim().length > 0;
            } catch {
                return false;
            }
        });
        expect(grandchildKnown).toBe(true);
        const grandchildPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
        cleanup.push(() => {
            try {
                process.kill(-grandchildPid, "SIGKILL");
            } catch {
                // already gone
            }
        });

        expect(alive(grandchildPid)).toBe(true);

        const descendants = killProcessTree(rootPid, "SIGKILL");

        expect(descendants).toContain(grandchildPid);
        expect(await waitFor(() => !alive(grandchildPid))).toBe(true);
    });

    it("re-signals extraPids even after the root process is gone", async () => {
        // Regression guard for the SIGKILL-escalation path: descendants saved
        // from the SIGTERM round must still be signaled when the root PID no
        // longer exists (pgrep would find nothing under it).
        const orphan = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
            detached: true,
            stdio: "ignore",
        });
        const orphanPid = orphan.pid;
        if (orphanPid === undefined) throw new Error("spawn did not return a pid");
        orphan.unref();
        cleanup.push(() => {
            try {
                process.kill(-orphanPid, "SIGKILL");
            } catch {
                // already gone
            }
        });

        // A definitely-dead root PID (pgrep on it yields nothing).
        killProcessTree(2 ** 22 - 1, "SIGKILL", [orphanPid]);

        expect(await waitFor(() => !alive(orphanPid))).toBe(true);
    });
});
