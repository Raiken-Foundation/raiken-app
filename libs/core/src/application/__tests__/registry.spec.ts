import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isDiscoveryActive } from "../discovery";
import {
    __projectApplicationCacheSizeForTests,
    __resetProjectApplicationRegistryForTests,
    disposeAllProjectApplications,
    disposeProjectApplication,
    getProjectApplication,
    isProjectApplicationDisposable,
} from "../registry";

class FakeSiteDiscovery extends EventEmitter {
    private startResolvers: Array<() => void> = [];

    start(): Promise<void> {
        return new Promise((resolve) => {
            this.startResolvers.push(resolve);
        });
    }

    abort(): Promise<void> {
        for (const resolve of this.startResolvers.splice(0)) resolve();
        return Promise.resolve();
    }

    close(): Promise<void> {
        return Promise.resolve();
    }

    getStats() {
        return {
            pagesDiscovered: 0,
            linksFound: 0,
            currentUrl: null,
            currentDepth: 0,
            status: "running",
            startedAt: Date.now(),
            elapsedMs: 0,
            authBlockersFound: 0,
        };
    }

    pause(): Promise<void> {
        return Promise.resolve();
    }
}

vi.mock("../../site-discovery/discovery-config", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../site-discovery/discovery-config")>();
    return {
        ...actual,
        createSiteDiscovery: () => new FakeSiteDiscovery(),
    };
});

async function waitUntil(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 5000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("waitUntil: condition never became true");
}

const projects: string[] = [];

async function makeProject(): Promise<string> {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-app-registry-"));
    projects.push(project);
    await fs.mkdir(path.join(project, ".raiken"), { recursive: true });
    return project;
}

afterEach(async () => {
    await disposeAllProjectApplications();
    __resetProjectApplicationRegistryForTests();
    await Promise.all(projects.splice(0).map((project) => fs.rm(project, { recursive: true })));
});

describe("ProjectApplication registry lifecycle", () => {
    it("returns the same bundle for a canonical project path", () => {
        const project = "/tmp/raiken-registry-test";
        const a = getProjectApplication(project);
        const b = getProjectApplication(`${project}/`);
        expect(a).toBe(b);
    });

    it("disposeProjectApplication evicts an idle cached bundle", async () => {
        const project = await makeProject();
        const bundle = getProjectApplication(project);
        expect(isProjectApplicationDisposable(project)).toBe(true);
        expect(disposeProjectApplication(project)).toBe(true);
        const next = getProjectApplication(project);
        expect(next).not.toBe(bundle);
    });

    it("refuses disposeProjectApplication while discovery is active", async () => {
        const project = await makeProject();
        const bundle = getProjectApplication(project);
        await bundle.discovery.startBackground({ url: "https://example.test/" });
        expect(isProjectApplicationDisposable(project)).toBe(false);
        expect(disposeProjectApplication(project)).toBe(false);
        expect(getProjectApplication(project)).toBe(bundle);
    });

    it("disposeAllProjectApplications aborts active discovery then clears bundles", async () => {
        const one = await makeProject();
        const two = await makeProject();
        const a = getProjectApplication(one);
        const b = getProjectApplication(two);
        await a.discovery.startBackground({ url: "https://example.test/" });
        await disposeAllProjectApplications();
        expect(getProjectApplication(one)).not.toBe(a);
        expect(getProjectApplication(two)).not.toBe(b);
    });

    it("evicts idle bundles but grows past 32 when every entry is active", async () => {
        for (let index = 0; index < 33; index += 1) {
            const projectPath = await makeProject();
            await getProjectApplication(projectPath).discovery.startBackground({
                url: `https://example.test/p${index}`,
            });
            await waitUntil(() => isDiscoveryActive(projectPath));
        }
        expect(__projectApplicationCacheSizeForTests()).toBeGreaterThan(32);
    });
});
