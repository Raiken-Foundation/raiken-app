import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeGraphDB } from "../../database/db";
import { acquireProjectOperation } from "../../operations/project-operation";
import { SiteKnowledgeDB } from "../../site-discovery/db";
import { acquireDiscoveryLock } from "../../site-discovery/project-lock";
import {
    __resetBackgroundDiscoverForTests,
    DiscoveryApplication,
    isDiscoveryActive,
} from "../discovery";
import { canonicalProjectPath } from "../discovery-query-cache";
import {
    __projectApplicationCacheSizeForTests,
    __resetProjectApplicationRegistryForTests,
    disposeProjectApplication,
    getProjectApplication,
} from "../registry";

class FakeSiteDiscovery extends EventEmitter {
    private startResolvers: Array<() => void> = [];
    private readonly abortDelayMs: number;

    constructor(abortDelayMs = 0) {
        super();
        this.abortDelayMs = abortDelayMs;
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
            authBlockersFound: 0,
        };
    }

    start(): Promise<void> {
        return new Promise((resolve) => {
            this.startResolvers.push(resolve);
        });
    }

    abort(): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(() => {
                this.emit("session_completed", {
                    type: "session_completed",
                    data: { reason: "aborted", stats: this.getStats() },
                    timestamp: Date.now(),
                });
                for (const done of this.startResolvers.splice(0)) done();
                resolve();
            }, this.abortDelayMs);
        });
    }

    triggerWallClockPause(): void {
        this.emit("session_paused", {
            type: "session_paused",
            data: { stats: this.getStats(), reason: "wall_clock_cap" },
            timestamp: Date.now(),
        });
        for (const done of this.startResolvers.splice(0)) done();
    }

    close(): Promise<void> {
        return Promise.resolve();
    }

    pause(): Promise<void> {
        return Promise.resolve();
    }
}

let latestFake: FakeSiteDiscovery | null = null;
let fakeAbortDelayMs = 0;
let lastCreateSiteDiscoveryInput:
    | import("../../site-discovery/discovery-config").ResolveSiteDiscoveryOptionsInput
    | null = null;

vi.mock("../../site-discovery/discovery-config", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../site-discovery/discovery-config")>();
    return {
        ...actual,
        createSiteDiscovery: (
            input: import("../../site-discovery/discovery-config").ResolveSiteDiscoveryOptionsInput,
        ) => {
            lastCreateSiteDiscoveryInput = input;
            return new FakeSiteDiscovery(fakeAbortDelayMs);
        },
    };
});

const projects: string[] = [];

async function makeProject(): Promise<string> {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-discovery-app-"));
    projects.push(project);
    await fs.mkdir(path.join(project, ".raiken"), { recursive: true });
    return project;
}

afterEach(async () => {
    fakeAbortDelayMs = 0;
    const toClean = projects.splice(0);
    for (const project of toClean) {
        const app = getProjectApplication(project);
        if (isDiscoveryActive(project)) {
            await app.discovery.abort().catch(() => undefined);
        }
    }
    __resetBackgroundDiscoverForTests();
    __resetProjectApplicationRegistryForTests();
    latestFake = null;
    lastCreateSiteDiscoveryInput = null;
    await Promise.all(toClean.map((project) => fs.rm(project, { recursive: true, force: true })));
});

async function waitUntil(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 2000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("waitUntil: condition never became true");
}

describe("DiscoveryApplication background lifecycle", () => {
    it("reports paused, not completed, after a wall-clock-cap pause", async () => {
        const projectPath = await makeProject();
        const app = getProjectApplication(projectPath);

        await app.discovery.startBackground({ url: "https://example.test/" });
        expect(app.discovery.getBackgroundStatus().status).toBe("running");

        latestFake?.triggerWallClockPause();
        await waitUntil(() => app.discovery.getBackgroundStatus().status !== "running");

        const status = app.discovery.getBackgroundStatus();
        expect(status.status).toBe("paused");
        expect(status.status).not.toBe("completed");
    });
});

describe("DiscoveryApplication abort ordering", () => {
    it("blocks a new start until abort settles", async () => {
        fakeAbortDelayMs = 50;
        const projectPath = await makeProject();
        const app = new DiscoveryApplication(projectPath);

        const startResult = await app.start({ url: "https://example.test/" });
        expect(startResult.success).toBe(true);

        const abortPromise = app.abort();
        const blocked = await app.start({ url: "https://example.test/again" });
        expect(blocked.success).toBe(false);
        expect(blocked.message).toMatch(/stopping/i);

        await abortPromise;
        const retry = await app.start({ url: "https://example.test/again" });
        expect(retry.success).toBe(true);
    });
});

describe("DiscoveryApplication detached auth resolution", () => {
    it("auto-resolves valid configured auth storage state on dashboard start", async () => {
        const projectPath = await makeProject();
        const authStatePath = path.join(projectPath, ".raiken", "auth-state.json");
        await fs.writeFile(
            authStatePath,
            JSON.stringify({
                cookies: [{ name: "session", value: "active", expires: -1 }],
                origins: [],
            }),
        );

        const app = getProjectApplication(projectPath);
        const startResult = await app.discovery.start({ url: "https://example.test/" });
        expect(startResult.success).toBe(true);
        expect(lastCreateSiteDiscoveryInput).not.toBeNull();
        expect(lastCreateSiteDiscoveryInput?.resolveStorageState).not.toBe(false);
        expect(lastCreateSiteDiscoveryInput?.overrides?.storageStatePath).toBeUndefined();

        const { resolveSiteDiscoveryOptions } = await import(
            "../../site-discovery/discovery-config"
        );
        const resolved = resolveSiteDiscoveryOptions({
            projectPath: canonicalProjectPath(projectPath),
            startUrl: "https://example.test/",
            overrides: lastCreateSiteDiscoveryInput?.overrides,
            resolveStorageState: lastCreateSiteDiscoveryInput?.resolveStorageState ?? true,
        });
        expect(resolved.storageStatePath).toBe(
            path.join(canonicalProjectPath(projectPath), ".raiken", "auth-state.json"),
        );

        await app.discovery.abort();
    });
});

describe("DiscoveryApplication cross-entry-point exclusion", () => {
    it("keeps discovery exclusive without blocking a follow-up agent turn", async () => {
        const projectPath = await makeProject();
        const app = getProjectApplication(projectPath);

        await app.discovery.start({ url: "https://example.test/" });
        await waitUntil(() => app.discovery.getRuntimeState().phase === "running");

        const agent = await acquireProjectOperation(projectPath, "agent");
        await expect(acquireDiscoveryLock(projectPath)).rejects.toThrow(/already running/i);
        await agent.release();

        await app.discovery.abort();
        const nextDiscovery = await acquireDiscoveryLock(projectPath);
        await nextDiscovery.release();
    });

    it("dashboard start reports running and blocks foreground + background entry points", async () => {
        const projectPath = await makeProject();
        const app = getProjectApplication(projectPath);

        const started = await app.discovery.start({ url: "https://example.test/" });
        expect(started.success).toBe(true);
        await waitUntil(() => app.discovery.getRuntimeState().phase === "running");

        const blockedDashboard = await app.discovery.start({ url: "https://example.test/again" });
        expect(blockedDashboard.success).toBe(false);
        expect(blockedDashboard.message).toMatch(/already running/i);

        await expect(
            app.discovery.runForeground({ startUrl: "https://example.test/fg" }),
        ).rejects.toThrow(/already running/i);

        await expect(
            app.discovery.startBackground({ url: "https://example.test/bg" }),
        ).rejects.toThrow(/already running/i);
    });

    it("background start reports running and blocks dashboard + foreground entry points", async () => {
        const projectPath = await makeProject();
        const app = getProjectApplication(projectPath);

        await app.discovery.startBackground({ url: "https://example.test/" });
        await waitUntil(() => app.discovery.getRuntimeState().phase === "running");

        const blockedDashboard = await app.discovery.start({ url: "https://example.test/again" });
        expect(blockedDashboard.success).toBe(false);
        expect(blockedDashboard.message).toMatch(/already running/i);

        await expect(
            app.discovery.runForeground({ startUrl: "https://example.test/fg" }),
        ).rejects.toThrow(/already running/i);
    });

    it("foreground run reports running and blocks dashboard + background entry points", async () => {
        const projectPath = await makeProject();
        const app = getProjectApplication(projectPath);

        const foreground = app.discovery.runForeground({ startUrl: "https://example.test/" });
        await waitUntil(() => app.discovery.getRuntimeState().phase === "running");

        const blockedDashboard = await app.discovery.start({ url: "https://example.test/again" });
        expect(blockedDashboard.success).toBe(false);
        expect(blockedDashboard.message).toMatch(/already running/i);

        await expect(
            app.discovery.startBackground({ url: "https://example.test/bg" }),
        ).rejects.toThrow(/already running/i);

        latestFake?.triggerWallClockPause();
        await foreground.catch(() => undefined);
    });
});

describe("Registry LRU with active discovery", () => {
    it("retains background status when cache exceeds 32 active projects", async () => {
        const firstPath = await makeProject();
        const appPaths: string[] = [firstPath];

        await getProjectApplication(firstPath).discovery.startBackground({
            url: "https://example.test/first",
        });
        await waitUntil(() => isDiscoveryActive(firstPath));

        for (let index = 0; index < 32; index += 1) {
            const projectPath = await makeProject();
            appPaths.push(projectPath);
            await getProjectApplication(projectPath).discovery.startBackground({
                url: `https://example.test/p${index}`,
            });
            await waitUntil(() => isDiscoveryActive(projectPath));
        }

        expect(__projectApplicationCacheSizeForTests()).toBeGreaterThan(32);
        expect(getProjectApplication(firstPath).discovery.getBackgroundStatus().status).toBe(
            "running",
        );
        expect(isDiscoveryActive(firstPath)).toBe(true);
        expect(disposeProjectApplication(firstPath)).toBe(false);
    });
});

describe("DiscoveryApplication query surface", () => {
    it("returns empty stats when discovery DB is unavailable", async () => {
        const projectPath = await makeProject();
        const app = getProjectApplication(projectPath);
        expect(app.discovery.getStats().pagesCount).toBe(0);
        expect(app.discovery.getSessionView()).toBeNull();
        expect(app.discovery.getAuthBlockers().total).toBe(0);
    });
});

describe("DiscoveryApplication continue auth semantics", () => {
    it("throws when provide_state resolution lacks usable auth", async () => {
        const projectPath = await makeProject();
        const authStatePath = path.join(projectPath, ".raiken", "auth-state.json");
        await fs.mkdir(path.dirname(authStatePath), { recursive: true });
        await fs.writeFile(authStatePath, JSON.stringify({ cookies: [], origins: [] }));

        const canonicalPath = canonicalProjectPath(projectPath);
        const db = new CodeGraphDB(projectPath);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), canonicalPath);
            siteDb.saveSession({
                projectPath: canonicalPath,
                startUrl: "https://example.test/",
                status: "paused",
                pagesDiscovered: 1,
                linksFound: 0,
                startedAt: Date.now(),
                completedAt: null,
                blockedAtUrl: "https://example.test/login",
                queueJson: "[]",
                maxPages: 50,
                maxDepth: 3,
            });
            siteDb.saveAuthBlocker({
                projectPath: canonicalPath,
                url: "https://example.test/login",
                blockerType: "login_redirect",
                discoveredAt: Date.now(),
            });
        } finally {
            db.close();
        }

        const app = getProjectApplication(projectPath);
        await expect(
            app.discovery.continue({
                resolution: "provide_state",
                storageStatePath: ".raiken/auth-state.json",
            }),
        ).rejects.toThrow(/auth state/i);
    });
});
