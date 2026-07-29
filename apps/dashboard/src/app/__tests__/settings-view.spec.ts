import type { PublicRaikenConfig } from "@raiken/shared";
import { describe, expect, it } from "vitest";
import { createSettingsConfigPatch } from "../settings-view";

describe("createSettingsConfigPatch", () => {
    const publicConfig: Partial<PublicRaikenConfig> = {
        ai: {
            provider: "openai",
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
