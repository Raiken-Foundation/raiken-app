import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRawConfig } from "../../config/store";
import { ConfigApplication } from "../config";

const projects: string[] = [];

async function makeProject(): Promise<string> {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-app-config-"));
    projects.push(project);
    return project;
}

afterEach(async () => {
    await Promise.all(projects.splice(0).map((project) => fs.rm(project, { recursive: true })));
});

describe("ConfigApplication contract", () => {
    it("rejects invalid config patches before writing", async () => {
        const project = await makeProject();
        const config = new ConfigApplication(project);

        const result = await config.updateConfig({
            config: { ai: { temperature: 99 } },
        });

        expect(result.success).toBe(false);
        expect(result.errors?.length).toBeGreaterThan(0);
    });

    it("merges valid partial config patches", async () => {
        const project = await makeProject();
        const config = new ConfigApplication(project);

        const result = await config.updateConfig({
            config: { testDirectory: "tests/e2e" },
        });

        expect(result.success).toBe(true);
        const publicConfig = await config.getPublicConfig();
        expect(publicConfig.config.testDirectory).toBe("tests/e2e");
    });

    it("clears secrets via clearSecrets without persisting them", async () => {
        const project = await makeProject();
        const config = new ConfigApplication(project);

        await config.updateConfig({
            config: {
                ai: {
                    provider: "openrouter",
                    apiKey: "sk-secret-on-disk",
                },
            },
        });

        const cleared = await config.updateConfig({
            config: {},
            clearSecrets: ["ai.apiKey"],
        });
        expect(cleared.success).toBe(true);

        const publicConfig = await config.getPublicConfig();
        expect(publicConfig.config.ai?.provider).toBe("openrouter");

        const raw = await readRawConfig(project);
        const ai = raw["ai"] as Record<string, unknown> | undefined;
        expect(ai?.["apiKey"]).toBeUndefined();
    });
});
