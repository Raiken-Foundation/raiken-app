import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readApiKeyFromEnv, resolveAIConfig } from "../agent/ai-providers";

const AI_ENV_VARS = [
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
    "XAI_API_KEY",
    "TOGETHER_API_KEY",
    "PERPLEXITY_API_KEY",
    "AI_API_KEY",
];

describe("provider environment key resolution", () => {
    const previous: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const name of AI_ENV_VARS) {
            previous[name] = process.env[name];
            delete process.env[name];
        }
    });

    afterEach(() => {
        for (const name of AI_ENV_VARS) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    });

    it("does not send a generic custom-provider key to a built-in provider", () => {
        process.env["AI_API_KEY"] = "gateway-only-key";

        expect(readApiKeyFromEnv("anthropic")).toBeUndefined();
        expect(readApiKeyFromEnv("openrouter")).toBeUndefined();
        expect(readApiKeyFromEnv("custom")).toBe("gateway-only-key");
    });

    it("uses the selected provider's documented key variable", () => {
        process.env["ANTHROPIC_API_KEY"] = "sk-ant-provider-key";
        process.env["AI_API_KEY"] = "gateway-only-key";

        expect(readApiKeyFromEnv("anthropic")).toBe("sk-ant-provider-key");
        expect(readApiKeyFromEnv("custom")).toBe("gateway-only-key");
    });

    it("supports Google’s alternate API-key variable in documented order", () => {
        process.env["GEMINI_API_KEY"] = "gemini-key";
        expect(readApiKeyFromEnv("google")).toBe("gemini-key");

        process.env["GOOGLE_API_KEY"] = "google-key";
        expect(readApiKeyFromEnv("google")).toBe("google-key");
    });
});

describe("provider-scoped saved keys", () => {
    let projectPath: string;

    beforeEach(() => {
        for (const name of AI_ENV_VARS) vi.stubEnv(name, "");
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-ai-config-"));
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
        vi.unstubAllEnvs();
    });

    it("selects the saved key that belongs to the resolved provider", () => {
        fs.writeFileSync(
            path.join(projectPath, "raiken.config.json"),
            JSON.stringify({
                ai: {
                    provider: "deepseek",
                    apiKey: "sk-deepseek-active",
                    apiKeys: {
                        openai: "sk-openai-remembered",
                        deepseek: "sk-deepseek-remembered",
                    },
                },
            }),
        );

        expect(resolveAIConfig(projectPath).apiKey).toBe("sk-deepseek-remembered");
        expect(resolveAIConfig(projectPath, { provider: "openai" }).apiKey).toBe(
            "sk-openai-remembered",
        );
    });
});
