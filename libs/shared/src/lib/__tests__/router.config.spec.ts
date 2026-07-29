import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appRouter } from "../router";

const temporaryDirectories: string[] = [];

async function makeProject(config: Record<string, unknown>): Promise<string> {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-router-config-"));
    temporaryDirectories.push(projectPath);
    await fs.writeFile(
        path.join(projectPath, "raiken.config.json"),
        `${JSON.stringify(config, null, 4)}\n`,
    );
    return projectPath;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

describe("configuration router contract", () => {
    it("returns a redacted public configuration with validation metadata", async () => {
        const projectPath = await makeProject({
            ai: { provider: "openai", apiKey: "sk-test-secret", apiKeys: { openai: "sk-other" } },
            auth: { credentials: { password: "password-secret" } },
            integrations: { linear: { apiKey: "lin_api_secret" } },
        });
        const caller = appRouter.createCaller({ projectPath });

        const response = await caller.getConfig();

        expect(response.validation).toEqual({ valid: true, issues: [] });
        expect(JSON.stringify(response)).not.toContain("secret");
        expect(response.config).toMatchObject({
            ai: { apiKeyPresent: true, apiKeysPresent: { openai: true } },
            auth: { credentials: { passwordPresent: true } },
            integrations: { linear: { apiKeyPresent: true } },
        });
    });

    it("preserves a saved API key when a public patch changes only the model", async () => {
        const projectPath = await makeProject({
            ai: { provider: "openai", apiKey: "sk-test-secret", model: "old-model" },
        });
        const caller = appRouter.createCaller({ projectPath });

        await expect(
            caller.updateConfig({ config: { ai: { model: "new-model", apiKey: "" } } }),
        ).resolves.toEqual({ success: true });

        const stored = JSON.parse(
            await fs.readFile(path.join(projectPath, "raiken.config.json"), "utf-8"),
        ) as { ai: { apiKey?: string; model?: string } };
        expect(stored.ai).toEqual({
            provider: "openai",
            apiKey: "sk-test-secret",
            model: "new-model",
        });
    });

    it("clears credentials only through the explicit clearSecrets field", async () => {
        const projectPath = await makeProject({
            ai: { apiKey: "sk-test-secret" },
        });
        const caller = appRouter.createCaller({ projectPath });

        await expect(
            caller.updateConfig({ config: {}, clearSecrets: ["ai.apiKey"] }),
        ).resolves.toEqual({ success: true });

        const stored = JSON.parse(
            await fs.readFile(path.join(projectPath, "raiken.config.json"), "utf-8"),
        ) as { ai: Record<string, unknown> };
        expect(stored.ai).toEqual({});
    });

    it("uses a mutation for model lookup and keeps the response credential-free", async () => {
        const projectPath = await makeProject({ ai: { provider: "deepseek" } });
        const caller = appRouter.createCaller({ projectPath });

        const response = await caller.fetchAIModels({ provider: "deepseek" });

        expect(response.provider).toBe("deepseek");
        expect(JSON.stringify(response)).not.toContain("apiKey");
        expect(response.models.length).toBeGreaterThan(0);
    });
});
