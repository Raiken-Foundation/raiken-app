import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeGraphDB } from "../../../database/db";
import { SiteKnowledgeDB } from "../../../site-discovery/db";
import { canonicalProjectPath } from "../../discovery-query-cache";
import { hydrateDiscoveryState } from "../hydration";
import { resetDiscoveryProjectRegistryForTests } from "../registry";
import { patchDiscoveryState } from "../state";

const startDiscoveryJobMock = vi.hoisted(() =>
    vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
    }),
);

vi.mock("../execution", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../execution")>();
    return {
        ...actual,
        startDiscoveryJob: (...args: Parameters<typeof actual.startDiscoveryJob>) =>
            startDiscoveryJobMock(...args),
    };
});

describe("hydrateDiscoveryState auto-resume", () => {
    const projects: string[] = [];

    afterEach(async () => {
        startDiscoveryJobMock.mockClear();
        resetDiscoveryProjectRegistryForTests();
        await Promise.all(
            projects.splice(0).map((project) => fs.rm(project, { recursive: true, force: true })),
        );
    });

    async function seedPausedSessionReadyToAutoResume(projectPath: string): Promise<void> {
        const canonical = canonicalProjectPath(projectPath);
        await fs.mkdir(path.join(canonical, ".raiken"), { recursive: true });
        const db = new CodeGraphDB(canonical);
        try {
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), canonical);
            siteDb.saveSession({
                projectPath: canonical,
                startUrl: "https://example.test/",
                status: "paused",
                pagesDiscovered: 2,
                linksFound: 1,
                startedAt: Date.now(),
                completedAt: null,
                blockedAtUrl: "https://example.test/login",
                queueJson: "[]",
                maxPages: 50,
                maxDepth: 3,
            });
        } finally {
            db.close();
        }
        patchDiscoveryState(canonical, {
            phase: "paused",
            requiresAuth: true,
            authBlockersFound: 1,
            blockedAtUrl: "https://example.test/login",
        });
    }

    it("starts exactly one job when hydrate runs twice before auto-resume completes", async () => {
        const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-auto-resume-"));
        projects.push(projectPath);
        await seedPausedSessionReadyToAutoResume(projectPath);
        const canonical = canonicalProjectPath(projectPath);

        await Promise.all([hydrateDiscoveryState(canonical), hydrateDiscoveryState(canonical)]);

        await vi.waitFor(() => expect(startDiscoveryJobMock).toHaveBeenCalledTimes(1), {
            timeout: 3000,
        });
        expect(startDiscoveryJobMock).toHaveBeenCalledWith(
            canonical,
            expect.objectContaining({
                startUrl: "https://example.test/login",
                continueSession: true,
            }),
        );
    });
});
