/**
 * `printIfActionable` regression spec (disc-6, CLI side), and
 * wall-clock-cap `session_paused` regression spec (disc-7).
 *
 * Most crawler `"warning"` events (per-request failures, off-origin
 * redirects) are dashboard-timeline-only by design; printing every one to
 * the REPL would flood the terminal for a crawl with a handful of broken
 * links. Only `checkpoint_failed` — which means a resume may silently lose
 * unvisited pages — is worth surfacing inline. These tests lock in that
 * filtering so a future change can't accidentally either (a) silence the
 * checkpoint warning again, or (b) reintroduce blanket warning spam.
 *
 * Separately, `startBackgroundDiscover`/`continueBackgroundDiscover` used to
 * have no `session_paused` handler at all. The wall-clock cap is the one
 * pause path with no dedicated `blocker_detected`/`auth_blocked` event, so
 * once `discovery.start()` resolved after that pause, the generic
 * `if (state.status === "running") state.status = "completed"` fallback
 * would silently mark a *capped, incomplete* crawl as successfully
 * complete. The disc-7 tests below drive a fake `SiteDiscovery` that pauses
 * for the wall-clock reason and assert the reported status is "paused",
 * never "completed".
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DiscoveryEvent } from "@raiken/core";
import { afterEach, describe, expect, it, vi } from "vitest";

class FakeSiteDiscovery extends EventEmitter {
    private startResolvers: Array<() => void> = [];

    constructor() {
        super();
        latestFake = this;
    }

    getStats() {
        return {
            pagesDiscovered: 3,
            linksFound: 7,
            currentUrl: "https://example.test/page",
            currentDepth: 1,
            status: "running",
            startedAt: Date.now(),
            elapsedMs: 0,
        };
    }

    start(): Promise<void> {
        return new Promise((resolve) => {
            this.startResolvers.push(resolve);
        });
    }

    /** Test hook: simulate the wall-clock timer firing mid-crawl. */
    triggerWallClockPause(): void {
        this.emit("session_paused", {
            type: "session_paused",
            data: { stats: this.getStats(), reason: "wall_clock_cap" },
            timestamp: Date.now(),
        });
        // Mirrors the real crawler: start() resolves cleanly once the
        // crawler winds down after pause() — it does NOT reject (disc-1).
        for (const resolve of this.startResolvers.splice(0)) resolve();
    }

    close(): Promise<void> {
        return Promise.resolve();
    }
}

let latestFake: FakeSiteDiscovery | null = null;

vi.mock(import("@raiken/core"), async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        SiteDiscovery: FakeSiteDiscovery,
    };
});

// Imported after the mock so the module under test picks up the fake.
const {
    printIfActionable,
    startBackgroundDiscover,
    getBackgroundDiscoverStatus,
    __resetBackgroundDiscoverForTests,
} = await import("../background-discover");

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("waitUntil: condition never became true");
}

function makeWarningEvent(data: Record<string, unknown>): DiscoveryEvent {
    return {
        type: "warning" as DiscoveryEvent["type"],
        data: data as unknown as DiscoveryEvent["data"],
        timestamp: Date.now(),
    };
}

describe("background-discover printIfActionable (disc-6)", () => {
    it("prints checkpoint_failed warnings to stderr", () => {
        const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            printIfActionable(
                makeWarningEvent({ code: "checkpoint_failed", message: "disk full" }),
            );
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy.mock.calls[0]?.[0]).toContain("disk full");
        } finally {
            spy.mockRestore();
        }
    });

    it("stays silent for routine per-request warnings (no code)", () => {
        const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            printIfActionable(
                makeWarningEvent({
                    url: "https://example.test",
                    message: "Request failed: timeout",
                }),
            );
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    it("stays silent for other known warning codes", () => {
        const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            printIfActionable(
                makeWarningEvent({
                    code: "off_origin_redirect",
                    message: "Followed off-origin redirect",
                }),
            );
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});

describe("background-discover wall-clock-cap pause (disc-7)", () => {
    let projectPath: string;

    afterEach(() => {
        __resetBackgroundDiscoverForTests();
        if (projectPath) fs.rmSync(projectPath, { recursive: true, force: true });
        latestFake = null;
    });

    it("reports 'paused', not 'completed', once start() resolves after a wall-clock-cap pause", async () => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-bg-discover-"));

        await startBackgroundDiscover({ url: "https://example.test", projectPath });
        expect(getBackgroundDiscoverStatus().status).toBe("running");

        latestFake?.triggerWallClockPause();
        await waitUntil(() => getBackgroundDiscoverStatus().status !== "running");

        const status = getBackgroundDiscoverStatus();
        expect(status.status).toBe("paused");
        // The bug this regresses against: the generic
        // `if (status === "running") status = "completed"` fallback would
        // otherwise stomp this to "completed" once start() resolves.
        expect(status.status).not.toBe("completed");
    });

    it("does not double-report a pause already handled by blocker_detected", async () => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-bg-discover-"));

        await startBackgroundDiscover({ url: "https://example.test", projectPath });
        const fake = latestFake;
        if (!fake) throw new Error("expected a fake SiteDiscovery instance");

        const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            // Real crawler order: blocker_detected fires first and sets
            // status to "paused" itself; pause() then emits session_paused
            // unconditionally afterwards. The session_paused handler must
            // not print a second, redundant "paused" line.
            fake.emit("blocker_detected", {
                type: "blocker_detected",
                data: { blocker: { category: "captcha", severity: "pause", url: "https://x" } },
                timestamp: Date.now(),
            });
            spy.mockClear();
            fake.emit("session_paused", {
                type: "session_paused",
                data: { stats: fake.getStats() },
                timestamp: Date.now(),
            });
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});
