import { describe, expect, it } from "vitest";
import { applyConfigPatch, buildAiConfigPatch, redactConfig } from "../config";

describe("buildAiConfigPatch", () => {
    it("builds a patch from provider/model/baseUrl flags", () => {
        const result = buildAiConfigPatch({
            provider: "openai",
            model: "gpt-4o",
            baseUrl: "https://api.openai.com/v1",
        });
        expect(result).toEqual({
            patch: {
                provider: "openai",
                model: "gpt-4o",
                baseURL: "https://api.openai.com/v1",
            },
        });
    });

    it("lowercases and trims a provider id", () => {
        expect(buildAiConfigPatch({ provider: " OpenAI " })).toEqual({
            patch: { provider: "openai" },
        });
    });

    it("rejects an unknown provider id", () => {
        const result = buildAiConfigPatch({ provider: "bogus" });
        expect("error" in result && result.error).toContain('Unknown provider: "bogus"');
    });

    it("sets apiKey from --api-key and --unset-key uses explicit clear", () => {
        expect(buildAiConfigPatch({ apiKey: "sk-test-123" })).toEqual({
            patch: { apiKey: "sk-test-123" },
        });
        expect(buildAiConfigPatch({ apiKey: "sk-test-123", unsetKey: true })).toEqual({
            patch: {},
            clearSecrets: ["ai.apiKey"],
        });
    });

    it("returns an empty patch when no relevant flags are set", () => {
        expect(buildAiConfigPatch({})).toEqual({ patch: {} });
    });
});

describe("config patch contract", () => {
    it("CLI patches preserve omitted secrets through applyConfigPatch", () => {
        const existing = {
            ai: {
                provider: "openai",
                apiKey: "sk-saved",
                apiKeys: { openai: "sk-saved" },
                model: "old-model",
            },
        };

        const cliPatch = buildAiConfigPatch({ model: "new-model", apiKey: "" });
        expect("error" in cliPatch).toBe(false);
        if ("error" in cliPatch) return;

        const merged = applyConfigPatch(existing, { ai: cliPatch.patch });
        expect(merged).toMatchObject({
            ai: {
                apiKey: "sk-saved",
                apiKeys: { openai: "sk-saved" },
                model: "new-model",
            },
        });
    });

    it("CLI unset honors explicit secret semantics", () => {
        const existing = {
            ai: { provider: "openai", apiKey: "sk-saved", model: "gpt-4o" },
        };

        const unset = buildAiConfigPatch({ unsetKey: true });
        expect("error" in unset).toBe(false);
        if ("error" in unset) return;
        const cleared = applyConfigPatch(existing, { ai: unset.patch }, unset.clearSecrets);
        expect((cleared["ai"] as Record<string, unknown>)["apiKey"]).toBeUndefined();
    });

    it("redactConfig strips secrets merged from explicit key patches", () => {
        const merged = applyConfigPatch(
            {},
            { ai: { provider: "openai", apiKey: "sk-secret", apiKeys: { openai: "sk-secret" } } },
        );
        const publicConfig = redactConfig(merged);
        expect(JSON.stringify(publicConfig)).not.toContain("secret");
        expect(publicConfig).toMatchObject({
            ai: { provider: "openai", apiKeyPresent: true, apiKeysPresent: { openai: true } },
        });
    });
});
