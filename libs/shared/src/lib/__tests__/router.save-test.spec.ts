import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appRouter } from "../router";

const temporaryDirectories: string[] = [];

async function makeProject(): Promise<string> {
    // Resolve symlinks (macOS `/var` → `/private/var`), or the router's own
    // project-containment check rejects paths under the temp dir.
    const projectPath = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "raiken-router-save-")),
    );
    temporaryDirectories.push(projectPath);
    await fs.mkdir(path.join(projectPath, "e2e"), { recursive: true });
    return projectPath;
}

const EXISTING = 'import { test } from "@playwright/test";\n\ntest("old", async () => {});\n';
const REPLACEMENT = 'import { test } from "@playwright/test";\n\ntest("new", async () => {});\n';

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

describe("saveGeneratedTest overwrite semantics", () => {
    // The guard that exists so an invented file name can't clobber an
    // unrelated spec someone else wrote.
    it("dedupes to a free name when avoiding overwrite", async () => {
        const projectPath = await makeProject();
        await fs.writeFile(path.join(projectPath, "e2e", "login.spec.ts"), EXISTING);
        const caller = appRouter.createCaller({ projectPath });

        const result = await caller.saveGeneratedTest({
            fileName: "login.spec.ts",
            content: REPLACEMENT,
            testDir: "e2e",
            avoidOverwrite: true,
        });

        expect(result.filePath).toBe("e2e/login-2.spec.ts");
        await expect(
            fs.readFile(path.join(projectPath, "e2e", "login.spec.ts"), "utf-8"),
        ).resolves.toContain('test("old"');
    });

    // The reported regression: an update deliberately aimed at an existing
    // spec was written to `login-2.spec.ts`, so the file the user asked to
    // fix stayed broken while a near-duplicate appeared beside it.
    it("writes through to the requested file when overwrite is intended", async () => {
        const projectPath = await makeProject();
        await fs.writeFile(path.join(projectPath, "e2e", "login.spec.ts"), EXISTING);
        const caller = appRouter.createCaller({ projectPath });

        const result = await caller.saveGeneratedTest({
            fileName: "login.spec.ts",
            content: REPLACEMENT,
            testDir: "e2e",
            avoidOverwrite: false,
        });

        expect(result.filePath).toBe("e2e/login.spec.ts");
        await expect(
            fs.readFile(path.join(projectPath, "e2e", "login.spec.ts"), "utf-8"),
        ).resolves.toContain('test("new"');
        await expect(fs.access(path.join(projectPath, "e2e", "login-2.spec.ts"))).rejects.toThrow();
    });

    // Re-saving identical content must be idempotent, or an approved save
    // followed by a repair no-op would fan out into numbered copies.
    it("reuses the same file when the content is unchanged", async () => {
        const projectPath = await makeProject();
        await fs.writeFile(path.join(projectPath, "e2e", "login.spec.ts"), EXISTING);
        const caller = appRouter.createCaller({ projectPath });

        const result = await caller.saveGeneratedTest({
            fileName: "login.spec.ts",
            content: EXISTING,
            testDir: "e2e",
            avoidOverwrite: true,
        });

        expect(result.filePath).toBe("e2e/login.spec.ts");
    });
});
