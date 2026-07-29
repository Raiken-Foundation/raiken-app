import { describe, expect, it } from "vitest";
import { appRouter } from "../router";
import { getRaikenVersion } from "../version";

describe("appRouter health contract", () => {
    it("reports the running engine with a version string", async () => {
        const caller = appRouter.createCaller({ projectPath: process.cwd() });

        await expect(caller.getHealth()).resolves.toMatchObject({
            status: "ok",
            engine: "raiken",
            version: getRaikenVersion(),
        });
    });
});
