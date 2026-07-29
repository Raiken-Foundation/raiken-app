import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestExecutionService } from "../testing/test-execution-service";

const projects: string[] = [];

afterEach(async () => {
    await Promise.all(projects.splice(0).map((project) => fs.rm(project, { recursive: true })));
});

describe("TestExecutionService", () => {
    it("rejects an inline test path outside the project before spawning Playwright", async () => {
        const project = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-test-service-"));
        projects.push(project);
        const service = new TestExecutionService();
        const result = await service.run(project, {
            testFile: "../outside.spec.ts",
            inlineContent: 'test("outside", async () => {});',
        });
        expect(result.success).toBe(false);
        expect(result.stderr).toContain("outside project");
        await expect(fs.access(path.join(project, "..", "outside.spec.ts"))).rejects.toThrow();
    });

    it("reports no cancellation when the project has no active run", () => {
        expect(new TestExecutionService().cancel("/tmp/no-active-raiken-project")).toBe(false);
    });
});
