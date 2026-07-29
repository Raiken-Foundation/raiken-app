import { describe, expect, it } from "vitest";
import { normalizeModelOptions, resolveProviderKeyStatus } from "../ai-provider-panel";

describe("normalizeModelOptions", () => {
    it("deduplicates provider models and fills missing display names", () => {
        const models = normalizeModelOptions([
            { id: "deepseek-chat", source: "recommended" },
            { id: "deepseek-chat", name: "Duplicate" },
            { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
        ]);

        expect(models).toEqual([
            { id: "deepseek-chat", name: "deepseek-chat", source: "recommended" },
            { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
        ]);
    });

    it("keeps a saved or typed custom model selectable", () => {
        const models = normalizeModelOptions(
            [{ id: "gpt-4o", name: "GPT-4o", source: "recommended" }],
            "custom/provider-model",
        );

        expect(models[0]).toMatchObject({
            id: "custom/provider-model",
            name: "custom/provider-model",
            description: "Current custom model",
        });
        expect(models.map((model) => model.id)).toContain("gpt-4o");
    });
});

describe("resolveProviderKeyStatus", () => {
    it("shows a saved project key for a provider remembered in apiKeys", () => {
        expect(
            resolveProviderKeyStatus(
                "deepseek",
                "openrouter",
                undefined,
                { deepseek: "sk-deepseek-project-key" },
                "missing",
            ),
        ).toMatchObject({ source: "project", label: "key saved" });
    });

    it("shows an environment key before a saved project key because env wins at runtime", () => {
        expect(
            resolveProviderKeyStatus(
                "deepseek",
                "deepseek",
                "sk-deepseek-project-key",
                { deepseek: "sk-deepseek-project-key" },
                "environment",
                "DEEPSEEK_API_KEY",
            ),
        ).toMatchObject({ source: "environment", label: "using DEEPSEEK_API_KEY" });
    });

    it("identifies keyless providers without calling them configured", () => {
        expect(
            resolveProviderKeyStatus("ollama", "ollama", undefined, {}, "not-required"),
        ).toMatchObject({ source: "not-required", label: "no key needed" });
    });
});
