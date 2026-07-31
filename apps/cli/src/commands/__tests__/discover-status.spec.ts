/**
 * `raiken discover --status` stale "Blocked:" regression.
 *
 * A session that paused at an auth wall and later resumed to completion kept
 * its `blocked_at_url`, and the status view printed the "Blocked:" line
 * unconditionally — so a successfully completed run still claimed to be
 * blocked. The display now only shows the line while the session is actually
 * paused (which also covers knowledge bases written before the crawler
 * started clearing the column on completion).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CodeGraphDB, canonicalProjectPath, SiteKnowledgeDB } from "@raiken/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showDiscoveryStatus } from "../discover";

describe("discover --status blocked-at display", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-discover-status-"));
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    function seedSession(status: "paused" | "completed", blockedAtUrl: string | null): void {
        const canonicalPath = canonicalProjectPath(projectPath);
        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), canonicalPath);
            siteDb.saveSession({
                projectPath: canonicalPath,
                startUrl: "https://example.test/",
                status,
                pagesDiscovered: 3,
                linksFound: 7,
                startedAt: Date.now() - 60_000,
                completedAt: status === "completed" ? Date.now() : null,
                blockedAtUrl,
                queueJson: null,
                maxPages: 50,
                maxDepth: 3,
            });
        } finally {
            db.close();
        }
    }

    function captureStatusOutput(lines: string[]): () => void {
        const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
            lines.push(args.map(String).join(" "));
        });
        return () => spy.mockRestore();
    }

    it("does not print a Blocked line for a completed session with a stale blocked_at_url", async () => {
        seedSession("completed", "https://example.test/dashboard");
        const lines: string[] = [];
        const restore = captureStatusOutput(lines);
        try {
            await showDiscoveryStatus(projectPath);
        } finally {
            restore();
        }

        expect(lines.some((line) => line.includes("Blocked:"))).toBe(false);
        expect(lines.some((line) => line.includes("completed"))).toBe(true);
    });

    it("still prints the Blocked line while the session is paused", async () => {
        seedSession("paused", "https://example.test/dashboard");
        const lines: string[] = [];
        const restore = captureStatusOutput(lines);
        try {
            await showDiscoveryStatus(projectPath);
        } finally {
            restore();
        }

        expect(
            lines.some(
                (line) => line.includes("Blocked:") && line.includes("example.test/dashboard"),
            ),
        ).toBe(true);
    });
});
