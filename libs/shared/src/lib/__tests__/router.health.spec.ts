import { describe, expect, it } from "vitest";
import { appRouter } from "../router";
import { getRaikenVersion } from "../version";

describe("appRouter health contract", () => {
    it("reports the running engine with a version string", async () => {
        const caller = appRouter.createCaller({ projectPath: process.cwd() });

        await expect(caller.getHealth()).resolves.toMatchObject({
            engine: "raiken",
            version: getRaikenVersion(),
            liveness: "alive",
        });
    });

    it("includes readiness probes without breaking legacy consumers", async () => {
        const caller = appRouter.createCaller({ projectPath: process.cwd() });
        const health = await caller.getHealth();

        expect(["ok", "degraded", "not_ready"]).toContain(health.status);
        expect(["ready", "not_ready"]).toContain(health.readiness);
        expect(health.checks).toMatchObject({
            config: expect.any(String),
            database: expect.any(String),
            ai: expect.any(String),
            operation: expect.any(String),
            auth: expect.any(String),
        });
    });
});
