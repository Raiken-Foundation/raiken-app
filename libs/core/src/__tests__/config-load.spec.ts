import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    defaultConfig,
    loadAIConfigSection,
    loadAuthConfig,
    loadAutonomyConfig,
    loadDiscoveryConfig,
    loadIndexingConfig,
    loadIntegrationsConfig,
    loadTestDirectory,
    writeConfigAtomicSync,
} from "../config";

const temporaryDirectories: string[] = [];

async function makeProject(config: Record<string, unknown> = {}): Promise<string> {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-config-load-"));
    temporaryDirectories.push(projectPath);
    if (Object.keys(config).length > 0) {
        writeConfigAtomicSync(projectPath, config);
    }
    return projectPath;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

describe("section resolvers", () => {
    it("loadAuthConfig merges valid auth fields and ignores invalid ones", async () => {
        const projectPath = await makeProject({
            auth: {
                storageStatePath: ".raiken/session.json",
                baseUrl: "https://app.test",
                credentials: { usernameEnv: "TEST_USER", password: "not-in-public-api" },
                loginPath: 123,
            },
        });

        expect(loadAuthConfig(projectPath)).toMatchObject({
            storageStatePath: ".raiken/session.json",
            baseUrl: "https://app.test",
            credentials: { usernameEnv: "TEST_USER", password: "not-in-public-api" },
        });
    });

    it("loadAutonomyConfig preserves valid autonomy when another section is invalid", async () => {
        const projectPath = await makeProject({
            ai: { temperature: "hot" },
            autonomy: { autoCorrect: "apply", maxRetries: 5, autoLearn: "nope" },
        });

        expect(loadAutonomyConfig(projectPath)).toMatchObject({
            autoCorrect: "apply",
            maxRetries: 5,
            autoLearn: defaultConfig.autonomy.autoLearn,
        });
    });

    it("loadIndexingConfig resolves fullScan with defaults", async () => {
        const projectPath = await makeProject({ indexing: { fullScan: true } });
        expect(loadIndexingConfig(projectPath)).toEqual({ fullScan: true });

        const missing = await makeProject();
        expect(loadIndexingConfig(missing)).toEqual(defaultConfig.indexing);
    });

    it("loadIntegrationsConfig preserves valid integrations when unrelated sections fail", async () => {
        const projectPath = await makeProject({
            browser: { defaultBrowser: "safari" },
            integrations: {
                provider: "linear",
                github: { owner: "acme", repo: "app" },
                branchPatterns: ["ENG-\\d+"],
            },
        });

        expect(loadIntegrationsConfig(projectPath)).toMatchObject({
            provider: "linear",
            github: { owner: "acme", repo: "app" },
            branchPatterns: ["ENG-\\d+"],
        });
    });

    it("loadAIConfigSection ignores invalid ai fields individually", async () => {
        const projectPath = await makeProject({
            ai: {
                provider: "openai",
                model: "gpt-4o",
                maxTokens: "lots",
                temperature: 0.2,
            },
        });

        expect(loadAIConfigSection(projectPath)).toMatchObject({
            provider: "openai",
            model: "gpt-4o",
            temperature: 0.2,
        });
        expect(loadAIConfigSection(projectPath).maxTokens).toBeUndefined();
    });

    it("loadTestDirectory falls back to canonical default", async () => {
        const projectPath = await makeProject({ testDirectory: "  tests/e2e  " });
        expect(loadTestDirectory(projectPath)).toBe("tests/e2e");

        const missing = await makeProject();
        expect(loadTestDirectory(missing)).toBe(defaultConfig.testDirectory);
    });

    it("loadDiscoveryConfig preserves valid discovery when unrelated sections are malformed", async () => {
        const projectPath = await makeProject({
            features: { video: "yes" },
            discovery: { maxPages: 12, preserveQueryParams: true },
        });

        expect(loadDiscoveryConfig(projectPath)).toMatchObject({
            maxPages: 12,
            preserveQueryParams: true,
            maxDepth: defaultConfig.discovery.maxDepth,
        });
    });
});

describe("env-over-file precedence for AI resolution", () => {
    const previous = process.env["OPENAI_API_KEY"];

    afterEach(() => {
        if (previous === undefined) delete process.env["OPENAI_API_KEY"];
        else process.env["OPENAI_API_KEY"] = previous;
    });

    it("prefers environment API keys over saved config values", async () => {
        const projectPath = await makeProject({
            ai: { provider: "openai", apiKey: "sk-from-file", model: "gpt-4o" },
        });
        process.env["OPENAI_API_KEY"] = "sk-from-env";

        const { resolveAIConfig } = await import("../agent/ai-providers");
        const resolved = resolveAIConfig(projectPath);

        expect(resolved.apiKey).toBe("sk-from-env");
        expect(resolved.apiKeySource).toBe("env");
        expect(resolved.model).toBe("gpt-4o");
    });
});
