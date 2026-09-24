/**
 * `blocked_at_url` lifecycle regression.
 *
 * A session that paused at an auth wall kept its `blocked_at_url` through
 * resume and completion, so status views showed a successfully completed run
 * as still blocked. Terminal session writes (complete/fail/abort) and the
 * resume write now clear the column; the pause write keeps setting it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SiteDiscovery } from "../../crawler";
import type { SiteKnowledgeDB } from "../../db";
import type { DiscoveryStats } from "../../types";

type Harness = {
    sessionId: number | null;
    siteDb: SiteKnowledgeDB;
    stats: DiscoveryStats;
    resumeSession: () => Promise<void>;
    finalizeSession: (status: "completed") => Promise<void>;
};

describe("blocked_at_url lifecycle", () => {
    const dirs: string[] = [];
    const discoveries: SiteDiscovery[] = [];

    function makeDiscovery(): { discovery: SiteDiscovery; harness: Harness; dir: string } {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-blocked-url-"));
        dirs.push(dir);
        const discovery = new SiteDiscovery({
            projectPath: dir,
            startUrl: "http://127.0.0.1:1/unreachable",
            maxPages: 5,
            maxDepth: 2,
            timeout: 15_000,
            pauseOnAuth: true,
        });
        discoveries.push(discovery);
        return { discovery, harness: discovery as unknown as Harness, dir };
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

    function seedPausedSession(harness: Harness, projectPath: string): number {
        return harness.siteDb.saveSession({
            projectPath,
            startUrl: "http://app.local/",
            status: "paused",
            pagesDiscovered: 2,
            linksFound: 4,
            startedAt: Date.now() - 60_000,
            completedAt: null,
            blockedAtUrl: "http://app.local/admin",
            queueJson: JSON.stringify([{ url: "http://app.local/a", uniqueKey: "k" }]),
        });
    }

    it("clears blocked_at_url when a paused session resumes", async () => {
        const { harness, dir } = makeDiscovery();
        const sessionId = seedPausedSession(harness, dir);

        await harness.resumeSession();

        const session = harness.siteDb.getSession(sessionId);
        expect(session?.status).toBe("running");
        expect(session?.blockedAtUrl).toBeNull();
    });

    it("clears blocked_at_url when the session completes", async () => {
        const { harness, dir } = makeDiscovery();
        const sessionId = seedPausedSession(harness, dir);
        harness.sessionId = sessionId;

        await harness.finalizeSession("completed");

        const session = harness.siteDb.getSession(sessionId);
        expect(session?.status).toBe("completed");
        expect(session?.blockedAtUrl).toBeNull();
    });

    it("clears blocked_at_url when the run is aborted", async () => {
        const { discovery, harness, dir } = makeDiscovery();
        const sessionId = seedPausedSession(harness, dir);
        harness.sessionId = sessionId;

        await discovery.abort();

        expect(harness.siteDb.getSession(sessionId)?.blockedAtUrl).toBeNull();
    });
});
