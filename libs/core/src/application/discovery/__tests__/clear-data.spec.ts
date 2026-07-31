import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeGraphDB } from "../../../database/db";
import { SiteKnowledgeDB } from "../../../site-discovery/db";
import { acquireDiscoveryLock } from "../../../site-discovery/project-lock";
import { canonicalProjectPath } from "../../discovery-query-cache";
import { DiscoveryApplication } from "../application";
import {
    isBrowserHandoffInProgress,
    isDiscoveryActive,
    resetDiscoveryProjectRegistryForTests,
} from "../registry";
import { discoveryJobStore, handoffJobStore } from "../state";

const handoffRun = vi.hoisted(() => vi.fn());
const handoffOperationRelease = vi.hoisted(() => vi.fn(async () => undefined));

class FakeSiteDiscovery extends EventEmitter {
    private startDone: (() => void) | null = null;

    abort = vi.fn(async () => {
        this.emit("session_completed", {
            type: "session_completed",
            data: { reason: "aborted", stats: this.getStats() },
            timestamp: Date.now(),
        });
        this.startDone?.();
        this.startDone = null;
    });
    close = vi.fn(async () => undefined);

    getStats() {
        return {
            pagesDiscovered: 1,
            linksFound: 0,
            currentUrl: "https://example.test/page",
            currentDepth: 0,
            status: "running",
            startedAt: Date.now(),
            elapsedMs: 0,
            authBlockersFound: 0,
        };
    }

    start(): Promise<void> {
        return new Promise((resolve) => {
            this.startDone = resolve;
        });
    }

    pause(): Promise<void> {
        return Promise.resolve();
    }
}

class AbortThrowsFakeSiteDiscovery extends FakeSiteDiscovery {
    override abort = vi.fn(async () => {
        this.startDone?.();
        this.startDone = null;
        throw new Error("abort failed");
    });
}

let latestFake: FakeSiteDiscovery | null = null;
let useAbortThrows = false;

vi.mock("../../../site-discovery/discovery-config", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../../site-discovery/discovery-config")>();
    return {
        ...actual,
        createSiteDiscovery: () => {
            latestFake = useAbortThrows
                ? new AbortThrowsFakeSiteDiscovery()
                : new FakeSiteDiscovery();
            return latestFake;
        },
    };
});

vi.mock("../../../site-discovery/manual-handoff", () => ({
    runManualHandoff: (...args: unknown[]) => handoffRun(...args),
}));

vi.mock("../../../operations/project-operation", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../operations/project-operation")>();
    return {
        ...actual,
        acquireProjectOperation: vi.fn(async (projectPath: string, kind: string) => {
            if (kind === "browser") {
                return {
                    manifest: { kind: "browser", pid: process.pid, startedAt: Date.now() },
                    release: handoffOperationRelease,
                };
            }
            return actual.acquireProjectOperation(projectPath, kind as "discovery");
        }),
    };
});

describe("DiscoveryApplication.clearData", () => {
    let projectPath: string;
    let canonicalPath: string;
    const manifestPath = () => path.join(canonicalPath, ".raiken", "operation.json");

    async function seedDiscoveryData(): Promise<void> {
        const db = new CodeGraphDB(canonicalPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), canonicalPath);
            siteDb.saveSession({
                projectPath: canonicalPath,
                startUrl: "https://example.test/",
                status: "paused",
                pagesDiscovered: 3,
                linksFound: 2,
                startedAt: Date.now(),
                completedAt: null,
                blockedAtUrl: "https://example.test/login",
                queueJson: "[]",
                maxPages: 50,
                maxDepth: 3,
            });
            siteDb.saveBlocker({
                projectPath: canonicalPath,
                url: "https://example.test/login",
                category: "auth_required",
                severity: "pause",
                detectorId: "auth:login_form",
                detectedElements: null,
                evidenceJson: null,
                screenshotPath: null,
                resolution: null,
                resolvedVia: null,
                resolvedAt: null,
                storageStatePath: null,
                discoveredAt: Date.now(),
            });
        } finally {
            db.close();
        }
    }

    async function waitUntil(
        predicate: () => boolean | Promise<boolean>,
        timeoutMs = 3000,
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await predicate()) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("waitUntil: condition never became true");
    }

    beforeEach(async () => {
        useAbortThrows = false;
        handoffRun.mockReset();
        handoffOperationRelease.mockClear();
        latestFake = null;
        projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-clear-data-"));
        canonicalPath = canonicalProjectPath(projectPath);
        await fs.mkdir(path.join(canonicalPath, ".raiken"), { recursive: true });
    });

    afterEach(async () => {
        resetDiscoveryProjectRegistryForTests();
        await fs.rm(projectPath, { recursive: true, force: true });
    });

    it("aborts active browser handoff, releases lock, clears DB, resets runtime, and allows restart", async () => {
        await seedDiscoveryData();
        let capturedSignal: AbortSignal | undefined;
        handoffRun.mockImplementation(async (options: { signal?: AbortSignal }) => {
            capturedSignal = options.signal;
            await new Promise<void>((resolve) => {
                options.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            return {
                storageStatePath: path.join(canonicalPath, ".raiken", "auth-state.json"),
                cookies: 0,
                origins: 0,
                reason: "abort" as const,
                blockersResolved: 0,
            };
        });

        const app = new DiscoveryApplication(canonicalPath);
        const handoffPromise = app.requestBrowserHandoff(
            { url: "https://example.test/login", category: "auth_required" },
            (p) => path.join(p, ".raiken", "auth-state.json"),
        );

        await waitUntil(() => isBrowserHandoffInProgress(canonicalPath));
        expect(capturedSignal?.aborted).toBe(false);
        expect(handoffJobStore.has(canonicalPath)).toBe(true);

        const clearResult = await app.clearData();
        expect(clearResult.success).toBe(true);
        expect(capturedSignal?.aborted).toBe(true);
        await handoffPromise;

        expect(handoffOperationRelease).toHaveBeenCalledTimes(1);
        expect(handoffJobStore.has(canonicalPath)).toBe(false);
        expect(isBrowserHandoffInProgress(canonicalPath)).toBe(false);

        await expect(fs.access(manifestPath())).rejects.toThrow();

        const db = new CodeGraphDB(canonicalPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), canonicalPath);
            expect(siteDb.getLatestSession()).toBeNull();
            expect(siteDb.getUnresolvedBlockers()).toHaveLength(0);
        } finally {
            db.close();
        }

        expect(app.getRuntimeState().phase).toBe("idle");
        expect(app.getStats().pagesCount).toBe(0);

        const restart = await app.start({ url: "https://example.test/fresh" });
        expect(restart.success).toBe(true);
        await app.abort();
    });

    it("aborts running crawl, releases discovery lock, clears DB, resets runtime, and allows restart", async () => {
        await seedDiscoveryData();
        const app = new DiscoveryApplication(canonicalPath);

        const started = await app.start({ url: "https://example.test/" });
        expect(started.success).toBe(true);
        await waitUntil(() => discoveryJobStore.has(canonicalPath));
        expect(isDiscoveryActive(canonicalPath)).toBe(true);

        const clearResult = await app.clearData();
        expect(clearResult.success).toBe(true);
        expect(latestFake?.abort).toHaveBeenCalledTimes(1);
        expect(discoveryJobStore.has(canonicalPath)).toBe(false);
        expect(isDiscoveryActive(canonicalPath)).toBe(false);

        const db = new CodeGraphDB(canonicalPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), canonicalPath);
            expect(siteDb.getLatestSession()).toBeNull();
        } finally {
            db.close();
        }

        expect(app.getRuntimeState().phase).toBe("idle");

        const restart = await app.start({ url: "https://example.test/after-clear" });
        expect(restart.success).toBe(true);
        await app.abort();
    });

    it("falls back to close when abort throws during clear", async () => {
        useAbortThrows = true;
        const app = new DiscoveryApplication(canonicalPath);
        await seedDiscoveryData();

        const started = await app.start({ url: "https://example.test/" });
        expect(started.success).toBe(true);
        await waitUntil(() => discoveryJobStore.has(canonicalPath));

        latestFake?.abort.mockClear();
        latestFake?.close.mockClear();

        const clearResult = await app.clearData();
        expect(clearResult.success).toBe(true);
        expect(latestFake?.abort).toHaveBeenCalledTimes(1);
        expect(latestFake?.close).toHaveBeenCalled();
        expect(discoveryJobStore.has(canonicalPath)).toBe(false);

        const restart = await app.start({ url: "https://example.test/recover" });
        expect(restart.success).toBe(true);
        await app.abort();
    });

    it("does not leave the dedicated discovery lock after clearing a running crawl", async () => {
        const app = new DiscoveryApplication(canonicalPath);
        await app.start({ url: "https://example.test/" });
        await waitUntil(() => discoveryJobStore.has(canonicalPath));

        await app.clearData();

        const lock = await acquireDiscoveryLock(canonicalPath);
        await lock.release();
    });

    it("does not clear data while another process owns the discovery lock", async () => {
        await seedDiscoveryData();
        const externalDiscovery = await acquireDiscoveryLock(canonicalPath);

        try {
            const result = await new DiscoveryApplication(canonicalPath).clearData();

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/already running/i);

            const db = new CodeGraphDB(canonicalPath);
            try {
                const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), canonicalPath);
                expect(siteDb.getLatestSession()).not.toBeNull();
            } finally {
                db.close();
            }
        } finally {
            await externalDiscovery.release();
        }
    });
});
