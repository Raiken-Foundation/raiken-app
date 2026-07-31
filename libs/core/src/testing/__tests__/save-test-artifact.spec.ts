import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveTestArtifact } from "../save-test-artifact";

const temporaryDirectories: string[] = [];

async function makeProject(): Promise<string> {
    const projectPath = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "raiken-save-artifact-")),
    );
    temporaryDirectories.push(projectPath);
    await fs.mkdir(path.join(projectPath, "e2e"), { recursive: true });
    return projectPath;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

const EXISTING = 'import { test } from "@playwright/test";\n\ntest("old", async () => {});\n';
const REPLACEMENT = 'import { test } from "@playwright/test";\n\ntest("new", async () => {});\n';

describe("saveTestArtifact", () => {
    it("dedupes to a free name when avoiding overwrite", async () => {
        const projectPath = await makeProject();
        await fs.writeFile(path.join(projectPath, "e2e", "login.spec.ts"), EXISTING);

        const result = await saveTestArtifact({
            projectPath,
            fileName: "login.spec.ts",
            testDir: "e2e",
            rawContent: REPLACEMENT,
            avoidOverwrite: true,
            learn: { autoLearn: "off" },
        });

        expect(result.success).toBe(true);
        expect(result.filePath).toBe("e2e/login-2.spec.ts");
    });

    it("writes through when overwrite is intended", async () => {
        const projectPath = await makeProject();
        await fs.writeFile(path.join(projectPath, "e2e", "login.spec.ts"), EXISTING);

        const result = await saveTestArtifact({
            projectPath,
            fileName: "login.spec.ts",
            testDir: "e2e",
            rawContent: REPLACEMENT,
            avoidOverwrite: false,
            learn: { autoLearn: "off" },
        });

        expect(result.filePath).toBe("e2e/login.spec.ts");
        await expect(
            fs.readFile(path.join(projectPath, "e2e", "login.spec.ts"), "utf-8"),
        ).resolves.toContain('test("new"');
    });

    it("reuses the same file when content is unchanged", async () => {
        const projectPath = await makeProject();
        await fs.writeFile(path.join(projectPath, "e2e", "login.spec.ts"), EXISTING);

        const result = await saveTestArtifact({
            projectPath,
            fileName: "login.spec.ts",
            testDir: "e2e",
            rawContent: EXISTING,
            avoidOverwrite: true,
            learn: { autoLearn: "off" },
        });

        expect(result.filePath).toBe("e2e/login.spec.ts");
    });

    it("strips edit markers for agent writes", async () => {
        const projectPath = await makeProject();
        const raw = `<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\nimport { test } from '@playwright/test';\n`;

        const result = await saveTestArtifact({
            projectPath,
            relativePath: "e2e/agent.spec.ts",
            rawContent: raw,
            stripEditMarkersFromRaw: true,
            learn: { autoLearn: "off" },
        });

        expect(result.success).toBe(true);
        await expect(
            fs.readFile(path.join(projectPath, "e2e", "agent.spec.ts"), "utf-8"),
        ).resolves.not.toContain("<<<<<<< SEARCH");
    });
});
