import {
    AI_PROVIDER_IDS as coreAIProviderIds,
    defaultConfig as coreDefaultConfig,
    mergeConfig,
    redactConfig,
} from "@raiken/core";
import { describe, expect, it } from "vitest";
import { defaultConfig as uiDefaultConfig } from "../config-defaults";
import { uiDefaultFieldsFromCore } from "../config-parity.server";
import { type PublicRaikenConfig, AI_PROVIDER_IDS as uiAIProviderIds } from "../config-public";

describe("shared/core config contract parity", () => {
    it("keeps browser-safe provider ids aligned with core", () => {
        expect(uiAIProviderIds).toEqual(coreAIProviderIds);
    });

    it("derives UI defaults from canonical core defaults without drift", () => {
        expect(uiDefaultConfig).toEqual(uiDefaultFieldsFromCore(coreDefaultConfig));
        expect(uiDefaultConfig).toEqual(uiDefaultFieldsFromCore(mergeConfig({})));
    });

    it("types core redaction output as the shared public transport config", () => {
        const merged = {
            ai: {
                provider: "openai",
                apiKey: "sk-secret",
                apiKeys: { openai: "sk-secret" },
                model: "gpt-4o",
            },
            auth: {
                credentials: { username: "alice", password: "hunter2", usernameEnv: "USER" },
            },
            integrations: {
                github: { token: "ghp_secret", owner: "acme" },
                linear: { apiKey: "lin_secret", teamKey: "ENG" },
            },
            testDirectory: "e2e",
        };

        const publicConfig: PublicRaikenConfig = redactConfig(merged);
        expect(JSON.stringify(publicConfig)).not.toContain("secret");
        expect(publicConfig).toMatchObject({
            ai: { provider: "openai", model: "gpt-4o", apiKeyPresent: true },
            auth: {
                credentials: { usernamePresent: true, passwordPresent: true, usernameEnv: "USER" },
            },
            integrations: {
                github: { owner: "acme", tokenPresent: true },
                linear: { teamKey: "ENG", apiKeyPresent: true },
            },
            testDirectory: "e2e",
        });
    });
});
