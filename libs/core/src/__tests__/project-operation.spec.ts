import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { lock } from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProjectOperation } from "../operations";

const projects: string[] = [];

afterEach(async () => {
    await Promise.all(projects.splice(0).map((project) => fs.rm(project, { recursive: true })));
});

describe("project operation coordinator", () => {
    it("excludes conflicting work across independent callers and releases cleanly", async () => {
        const project = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-operation-"));
        projects.push(project);
        await fs.mkdir(path.join(project, ".raiken"), { recursive: true });
        const releaseExternal = await lock(path.join(project, ".raiken", "operation.lock"), {
            realpath: false,
            retries: 0,
        });
        await expect(acquireProjectOperation(project, "test")).rejects.toThrow("already active");
        await releaseExternal();

        const second = await acquireProjectOperation(project, "test");
        expect(second.manifest).toMatchObject({ kind: "test" });
        await second.release();
    });

    it("rejects an independent same-process operation while a lease is held", async () => {
        const project = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-operation-"));
        projects.push(project);
        const agent = await acquireProjectOperation(project, "agent");

        await expect(acquireProjectOperation(project, "test")).rejects.toThrow("agent operation");
        await agent.release();
    });
});
