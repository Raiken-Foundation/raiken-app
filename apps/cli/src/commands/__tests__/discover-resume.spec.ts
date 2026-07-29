/**
 * `raiken discover --continue` auth-state purge regression (disc-5).
 *
 * The dashboard's `resolveDiscoveryBlocker` procedure already purges
 * Crawlee's persistent queue and restarts from `startUrl` when a paused
 * session's auth blocker gets resolved with fresh storage state — the
 * crawler's queue up to that point only reflects the *unauthenticated*
 * link graph, so resuming it verbatim would replay the login page forever
 * and never discover what's behind auth (see router.ts,
 * `purgeQueueOnResume`).
 *
 * The CLI's `raiken discover --continue` had no equivalent: it always
 * resumed from `blockedAtUrl || startUrl` with the stale pre-auth queue,
 * even when the user had just run `raiken auth` in between. These tests
 * cover the two building blocks that close that gap — `getResumeContext`
 * (detecting a pending auth blocker) and `resolveAuthBlockersWithState`
 * (clearing it once fresh state is applied) — against a real temp project
 * DB rather than mocks, since the actual bug lived in the DB query logic.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CodeGraphDB, SiteKnowledgeDB } from "@raiken/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    getResumeContext,
    resolveAuthBlockersWithState,
    resolveUsableDiscoveryAuthState,
} from "../discover";

describe("discover --continue resume context (disc-5)", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-discover-resume-"));
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    function seedPausedAuthSession(): { sessionId: number; blockerId: number } {
        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
            const sessionId = siteDb.saveSession({
                projectPath,
                startUrl: "https://example.test/",
                status: "paused",
                pagesDiscovered: 2,
                linksFound: 5,
                startedAt: Date.now(),
                completedAt: null,
                blockedAtUrl: "https://example.test/dashboard",
                queueJson: JSON.stringify([{ url: "https://example.test/login", uniqueKey: "1" }]),
                maxPages: 50,
                maxDepth: 3,
            });
            const blockerId = siteDb.saveAuthBlocker({
                projectPath,
                url: "https://example.test/dashboard",
                blockerType: "login_redirect",
                discoveredAt: Date.now(),
            });
            return { sessionId, blockerId };
        } finally {
            db.close();
        }
    }

    it("surfaces the unresolved auth blocker for a paused session", async () => {
        seedPausedAuthSession();

        const { session, pendingAuthBlockers } = await getResumeContext(projectPath);

        expect(session?.status).toBe("paused");
        expect(pendingAuthBlockers).toHaveLength(1);
        expect(pendingAuthBlockers[0]?.category).toBe("auth_required");
    });

    it("returns no pending auth blockers when the session paused for an unrelated reason", async () => {
        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
            siteDb.saveSession({
                projectPath,
                startUrl: "https://example.test/",
                status: "paused",
                pagesDiscovered: 10,
                linksFound: 20,
                startedAt: Date.now(),
                completedAt: null,
                blockedAtUrl: null,
                queueJson: JSON.stringify([{ url: "https://example.test/page-2", uniqueKey: "1" }]),
                maxPages: 50,
                maxDepth: 3,
            });
        } finally {
            db.close();
        }

        const { pendingAuthBlockers } = await getResumeContext(projectPath);
        expect(pendingAuthBlockers).toHaveLength(0);
    });

    it("clears the auth blocker once fresh storage state is applied", async () => {
        seedPausedAuthSession();
        const authStatePath = path.join(projectPath, ".raiken", "auth-state.json");
        fs.mkdirSync(path.dirname(authStatePath), { recursive: true });
        fs.writeFileSync(
            authStatePath,
            JSON.stringify({
                cookies: [{ name: "session", value: "active", expires: -1 }],
                origins: [],
            }),
        );

        const before = await getResumeContext(projectPath);
        expect(before.pendingAuthBlockers).toHaveLength(1);

        await resolveAuthBlockersWithState(projectPath, before.pendingAuthBlockers, authStatePath);

        const after = await getResumeContext(projectPath);
        expect(after.pendingAuthBlockers).toHaveLength(0);

        // The resolution must be recorded as `provide_state` with the new
        // storage state path, not just silently dropped — status views and
        // any future audit both depend on this being traceable.
        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
            const all = siteDb.getAllBlockers();
            expect(all).toHaveLength(1);
            expect(all[0]?.resolution).toBe("provide_state");
            expect(all[0]?.storageStatePath).toBe(authStatePath);
        } finally {
            db.close();
        }
    });

    it("is a no-op when there are no pending auth blockers to resolve", async () => {
        // Must not throw or open a DB connection unnecessarily when the
        // list is empty (e.g. a normal non-auth pause).
        await expect(
            resolveAuthBlockersWithState(projectPath, [], "/tmp/whatever"),
        ).resolves.toBeUndefined();
    });

    it("does not treat expired state as fresh resume authentication", () => {
        const authStatePath = path.join(projectPath, ".raiken", "auth-state.json");
        fs.mkdirSync(path.dirname(authStatePath), { recursive: true });
        fs.writeFileSync(
            authStatePath,
            JSON.stringify({
                cookies: [
                    {
                        name: "session",
                        value: "stale",
                        expires: Math.floor(Date.now() / 1000) - 60,
                    },
                ],
                origins: [],
            }),
        );

        expect(resolveUsableDiscoveryAuthState(projectPath)).toBeNull();

        fs.writeFileSync(
            authStatePath,
            JSON.stringify({
                cookies: [{ name: "session", value: "active", expires: -1 }],
                origins: [],
            }),
        );
        expect(resolveUsableDiscoveryAuthState(projectPath)).toBe(fs.realpathSync(authStatePath));
    });
});
