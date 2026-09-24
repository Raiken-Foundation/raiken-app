import { applyConfigPatch, buildAiConfigPatch } from "@raiken/core";
import { describe, expect, it } from "vitest";
import { createSettingsConfigPatch } from "../config-patch";

describe("CLI and dashboard patch parity", () => {
    it("preserves omitted secrets through applyConfigPatch", () => {
        const existing = {
            ai: {
                provider: "openai",
                apiKey: "sk-saved",
                apiKeys: { openai: "sk-saved" },
                model: "old-model",
            },
            integrations: { linear: { teamKey: "ENG", apiKey: "lin_saved" } },
        };

        const cliPatch = buildAiConfigPatch({ model: "new-model", apiKey: "" });
        expect("error" in cliPatch).toBe(false);
        if ("error" in cliPatch) return;

        const dashboardPatch = createSettingsConfigPatch(
            {
                ai: { provider: "openai", model: "new-model", apiKeyPresent: true },
                integrations: { linear: { teamKey: "ENG", apiKeyPresent: true } },
            },
            { aiKeys: {}, linearApiKey: "" },
        );

        for (const patch of [{ ai: cliPatch.patch }, dashboardPatch]) {
            const merged = applyConfigPatch(existing, patch);
            expect(merged).toMatchObject({
                ai: {
                    apiKey: "sk-saved",
                    apiKeys: { openai: "sk-saved" },
                    model: "new-model",
                },
                integrations: { linear: { teamKey: "ENG", apiKey: "lin_saved" } },
            });
        }
    });
});

describe("shared config patch exports", () => {
    it("re-exports CLI and dashboard patch builders with identical secret semantics", () => {
        const cli = buildAiConfigPatch({ provider: "openai", model: "gpt-4o", apiKey: "" });
        expect(cli).toEqual({ patch: { provider: "openai", model: "gpt-4o" } });

        const dashboard = createSettingsConfigPatch(
            { ai: { provider: "openai", model: "gpt-4o", apiKeyPresent: true } },
            { aiKeys: {}, linearApiKey: "" },
        );
        expect(dashboard).toEqual({ ai: { provider: "openai", model: "gpt-4o" } });
    });
});

describe("createSettingsConfigPatch", () => {
    const publicConfig = {
        ai: {
            provider: "openai" as const,
            model: "gpt-4o",
            apiKeyPresent: true,
            apiKeysPresent: { openai: true },
        },
        integrations: {
            linear: { teamKey: "ENG", apiKeyPresent: true },
        },
    };

    it("does not turn empty write-only drafts into credential clears", () => {
        const patch = createSettingsConfigPatch(publicConfig, {
            aiKeys: {},
            linearApiKey: "",
        });

        expect(patch).toEqual({
            ai: { provider: "openai", model: "gpt-4o" },
            integrations: { linear: { teamKey: "ENG" } },
        });
    });

    it("includes a secret only when the user explicitly typed a replacement", () => {
        const patch = createSettingsConfigPatch(publicConfig, {
            aiKeys: { openai: "sk-new-openai-key" },
            linearApiKey: "lin_api_new_key",
        });

        expect(patch).toMatchObject({
            ai: {
                provider: "openai",
                apiKey: "sk-new-openai-key",
                apiKeys: { openai: "sk-new-openai-key" },
            },
            integrations: {
                linear: { teamKey: "ENG", apiKey: "lin_api_new_key" },
            },
        });
    });
});
