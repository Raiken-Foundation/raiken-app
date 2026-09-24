import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createProjectApplication } from "@raiken/core";
import { afterEach, describe, expect, it } from "vitest";
import { appRouter } from "../router";
import { getRaikenVersion } from "../version";

const projects: string[] = [];

async function makeProject(): Promise<string> {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-router-parity-"));
    projects.push(project);
    return project;
}

afterEach(async () => {
    await Promise.all(projects.splice(0).map((project) => fs.rm(project, { recursive: true })));
});

describe("router ↔ application parity", () => {
    it("getHealth matches transport-free contract and version", async () => {
        const projectPath = await makeProject();
        await fs.writeFile(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({ ai: { provider: "openrouter" } }),
        );
        const caller = appRouter.createCaller({ projectPath });
        await expect(caller.getHealth()).resolves.toMatchObject({
            engine: "raiken",
            version: getRaikenVersion(),
            liveness: "alive",
            readiness: "ready",
        });
    });

    it("getConfig delegates to ConfigApplication", async () => {
        const projectPath = process.cwd();
        const caller = appRouter.createCaller({ projectPath });
        const app = createProjectApplication(projectPath);
        await expect(caller.getConfig()).resolves.toEqual(await app.config.getPublicConfig());
    });

    it("clearAgentMemory matches ChatApplication", async () => {
        const projectPath = process.cwd();
        const caller = appRouter.createCaller({ projectPath });
        const app = createProjectApplication(projectPath);
        await expect(caller.clearAgentMemory()).resolves.toEqual(app.chat.clearAgentMemory());
    });

    it("listActiveHitlWorkflows matches HitlApplication", async () => {
        const projectPath = await makeProject();
        const caller = appRouter.createCaller({ projectPath });
        const app = createProjectApplication(projectPath);
        await expect(caller.listActiveHitlWorkflows()).resolves.toEqual(
            await app.hitl.listActive(),
        );
    });

    it("getGraphStats matches IndexingApplication", async () => {
        const projectPath = await makeProject();
        const caller = appRouter.createCaller({ projectPath });
        const app = createProjectApplication(projectPath);
        await expect(caller.getGraphStats({})).resolves.toEqual(app.indexing.getGraphStats({}));
    });

    it("getDiscoveryStats matches DiscoveryApplication", async () => {
        const projectPath = await makeProject();
        const caller = appRouter.createCaller({ projectPath });
        const app = createProjectApplication(projectPath);
        const stats = app.discovery.getStats();
        await expect(caller.getDiscoveryStats({ path: projectPath })).resolves.toMatchObject({
            ...stats,
            timestamp: expect.any(String),
        });
    });

    it("runDoctor matches QualityApplication", async () => {
        const projectPath = await makeProject();
        const caller = appRouter.createCaller({ projectPath });
        const app = createProjectApplication(projectPath);
        await expect(caller.runDoctor({})).resolves.toEqual(await app.quality.runDoctor({}));
    });

    it("listTestFiles matches TestingApplication", async () => {
        const projectPath = process.cwd();
        const caller = appRouter.createCaller({ projectPath });
        const app = createProjectApplication(projectPath);
        await expect(caller.listTestFiles({})).resolves.toEqual(
            await app.testing.listTestFiles({}),
        );
    });

    it("continueDiscovery returns structured failure when no paused session exists", async () => {
        const projectPath = await makeProject();
        const caller = appRouter.createCaller({ projectPath });
        const result = await caller.continueDiscovery({ path: projectPath });
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/paused/i);
    });

    it("cancelBrowserHandoff matches DiscoveryApplication", async () => {
        const projectPath = await makeProject();
        const caller = appRouter.createCaller({ projectPath });
        const app = createProjectApplication(projectPath);
        await expect(caller.cancelBrowserHandoff({ path: projectPath })).resolves.toEqual(
            app.discovery.cancelBrowserHandoff(),
        );
    });
});
