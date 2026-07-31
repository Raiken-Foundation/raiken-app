import { describe, expect, it } from "vitest";
import { listProviders } from "../agent/ai-providers";

describe("AI providers", () => {
    it("defines selectable recommended models for every built-in provider", () => {
        for (const provider of listProviders()) {
            if (provider.id === "custom") {
                expect(provider.recommendedModels).toEqual([]);
                continue;
            }

            expect(provider.recommendedModels.length, provider.id).toBeGreaterThan(0);
            expect(
                provider.recommendedModels.some((model) => model.id === provider.defaultModel),
                provider.id,
            ).toBe(true);
            expect(
                provider.recommendedModels.every((model) => model.source === "recommended"),
            ).toBe(true);
        }
    });
});
