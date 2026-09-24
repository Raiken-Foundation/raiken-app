/**
 * Regression tests for the phantom "Running (1)" dashboard badge:
 *
 *  - state-hydrator kept any in-memory "running" phase forever (and skipped
 *    the stale-session sweep) even when no discovery job was in flight;
 *  - the runtime listener let a page_discovered event landing during
 *    pause-drain resurrect the phase from "paused" back to "running";
 *  - the listener also maintained its own pagesDiscovered counter, which
 *    drifted from the crawler's per-run unique count on refreshed pages.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodeGraphDB } from "../../../database/db";
import { SiteKnowledgeDB } from "../../../site-discovery/db";
import { canonicalProjectPath } from "../../discovery-query-cache";
import { attachDiscoveryRuntimeListeners } from "../listeners";
import { discoveryJobStore, getDiscoveryState, patchDiscoveryState } from "../state";
import { hydrateDiscoveryStateCore } from "../state-hydrator";

const projects: string[] = [];

afterEach(async () => {
    await Promise.all(
        projects.splice(0).map((project) => fs.rm(project, { recursive: true, force: true })),
    );
});

async function seedSession(projectPath: string, status: string): Promise<string> {
    const canonical = canonicalProjectPath(projectPath);
    await fs.mkdir(path.join(canonical, ".raiken"), { recursive: true });
    const db = new CodeGraphDB(canonical);
    try {
        const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), canonical);
        siteDb.saveSession({
            projectPath: canonical,
            startUrl: "https://example.test/",
            status,
            pagesDiscovered: 3,
            linksFound: 2,
            startedAt: Date.now(),
            completedAt: status === "completed" ? Date.now() : null,
            blockedAtUrl: null,
            queueJson: "[]",
            maxPages: 50,
            maxDepth: 3,
        });
    } finally {
        db.close();
    }
    return canonical;
}

describe("hydrateDiscoveryStateCore stale running phase", () => {
    it("re-derives the phase from the completed session when no job is in flight", async () => {
        const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-phase-"));
        projects.push(projectPath);
        const canonical = await seedSession(projectPath, "completed");
        // The residue a drained page event left behind.
        patchDiscoveryState(canonical, { phase: "running" });

        const state = await hydrateDiscoveryStateCore(canonical);

        expect(state.phase).toBe("completed");
    });

    it("sweeps a stale running SESSION row even when memory says running", async () => {
        const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-phase-"));
        projects.push(projectPath);
        const canonical = await seedSession(projectPath, "running");
        patchDiscoveryState(canonical, { phase: "running" });

        const state = await hydrateDiscoveryStateCore(canonical);

        // recoverStaleSessions marks the dead row failed → "error", not a
        // phantom "running".
        expect(state.phase).toBe("error");
    });

    it("keeps 'running' only while a job is actually in flight", async () => {
        const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-phase-"));
        projects.push(projectPath);
        const canonical = await seedSession(projectPath, "running");
        patchDiscoveryState(canonical, { phase: "running" });
        discoveryJobStore.set(canonical, {} as never);
        try {
            const state = await hydrateDiscoveryStateCore(canonical);
            expect(state.phase).toBe("running");
        } finally {
            discoveryJobStore.delete(canonical);
        }
    });
});

describe("attachDiscoveryRuntimeListeners page_discovered", () => {
    function fakeDiscovery(pagesDiscovered: number) {
        const emitter = new EventEmitter();
        return Object.assign(emitter, {
            getStats: () => ({
                pagesDiscovered,
                linksFound: 2,
                authBlockersFound: 0,
                currentDepth: 1,
                currentUrl: "https://example.test/",
                status: "running",
                startedAt: Date.now(),
                elapsedMs: 0,
            }),
        }) as never;
    }

    const pageEvent = {
        data: { page: { url: "https://example.test/docs", depth: 1 }, refreshed: false },
    };

    it("does not resurrect 'running' from 'paused' during pause-drain", () => {
        const projectPath = path.join(os.tmpdir(), `raiken-listener-${Date.now()}-a`);
        patchDiscoveryState(projectPath, { phase: "paused", pagesDiscovered: 2 });
        const discovery = fakeDiscovery(3) as unknown as EventEmitter;
        attachDiscoveryRuntimeListeners(projectPath, discovery as never);

        // A drained in-flight page commits after the pause.
        discovery.emit("page_discovered", pageEvent);

        expect(getDiscoveryState(projectPath).phase).toBe("paused");
    });

    it("takes the page count from crawler stats, not a parallel counter", () => {
        const projectPath = path.join(os.tmpdir(), `raiken-listener-${Date.now()}-b`);
        patchDiscoveryState(projectPath, { phase: "running", pagesDiscovered: 0 });
        const discovery = fakeDiscovery(7) as unknown as EventEmitter;
        attachDiscoveryRuntimeListeners(projectPath, discovery as never);

        discovery.emit("page_discovered", pageEvent);
        discovery.emit("page_discovered", {
            data: { page: { url: "https://example.test/about", depth: 1 }, refreshed: true },
        });

        const state = getDiscoveryState(projectPath);
        expect(state.pagesDiscovered).toBe(7);
        expect(state.phase).toBe("running");
    });
});
