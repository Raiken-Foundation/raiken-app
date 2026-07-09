import { describe, expect, it } from "vitest";
import { normalizeModelOptions } from "./ai-provider-panel";

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
