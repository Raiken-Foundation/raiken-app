import { createSettingsConfigPatch } from "@raiken/shared";
import { describe, expect, it } from "vitest";
import { createInitialFormState, reduceSettingsForm } from "../use-settings-form";

describe("settings form reducer", () => {
    const baseConfig = {
        ai: { provider: "openai", model: "gpt-4o", apiKeyPresent: true },
        browser: { headless: true },
        integrations: { linear: { teamKey: "ENG", apiKeyPresent: true } },
    };

    it("syncs authoritative config when not dirty", () => {
        let state = createInitialFormState({ testDirectory: "old" });
        state = reduceSettingsForm(state, {
            type: "updateTop",
            field: "testDirectory",
            value: "draft",
        });
        expect(state.dirty).toBe(true);

        state = reduceSettingsForm(state, { type: "sync", config: baseConfig });
        expect(state.dirty).toBe(true);
        expect(state.form.testDirectory).toBe("draft");

        state = reduceSettingsForm(state, { type: "reset", config: baseConfig });
        state = reduceSettingsForm(state, {
            type: "sync",
            config: { ...baseConfig, testDirectory: "e2e" },
        });
        expect(state.dirty).toBe(false);
        expect(state.form).toEqual({ ...baseConfig, testDirectory: "e2e" });
        expect(state.secretDrafts).toEqual({ aiKeys: {}, linearApiKey: "" });
    });

    it("ignores authoritative sync while dirty to avoid clobbering edits", () => {
        let state = createInitialFormState(baseConfig);
        state = reduceSettingsForm(state, {
            type: "update",
            section: "browser",
            field: "headless",
            value: false,
        });
        expect(state.dirty).toBe(true);

        state = reduceSettingsForm(state, {
            type: "sync",
            config: { ...baseConfig, browser: { headless: true } },
        });
        expect(state.form.browser).toEqual({ headless: false });
        expect(state.dirty).toBe(true);
    });

    it("resets form and secret drafts on discard", () => {
        let state = createInitialFormState(baseConfig);
        state = reduceSettingsForm(state, {
            type: "updateAiKeyDraft",
            provider: "openai",
            value: "sk-draft",
        });
        state = reduceSettingsForm(state, {
            type: "updateLinearApiKey",
            value: "lin_draft",
        });

        state = reduceSettingsForm(state, { type: "reset", config: baseConfig });
        expect(state.dirty).toBe(false);
        expect(state.secretDrafts).toEqual({ aiKeys: {}, linearApiKey: "" });
        expect(state.form).toEqual(baseConfig);
    });

    it("clears secret drafts after a successful save mark", () => {
        let state = createInitialFormState(baseConfig);
        state = reduceSettingsForm(state, {
            type: "updateAiKeyDraft",
            provider: "openai",
            value: "sk-new",
        });
        state = reduceSettingsForm(state, { type: "markSaved" });
        expect(state.dirty).toBe(false);
        expect(state.secretDrafts).toEqual({ aiKeys: {}, linearApiKey: "" });
    });
});

describe("settings section patch composition", () => {
    it("omits empty secret drafts so saved keys are preserved", () => {
        const form = {
            ai: { provider: "openai", model: "gpt-4o", apiKeyPresent: true },
            integrations: { linear: { teamKey: "ENG", apiKeyPresent: true } },
        };
        const patch = createSettingsConfigPatch(form, { aiKeys: {}, linearApiKey: "" });
        expect(patch).toEqual({
            ai: { provider: "openai", model: "gpt-4o" },
            integrations: { linear: { teamKey: "ENG" } },
        });
    });

    it("includes typed replacements and strips present flags", () => {
        const form = {
            ai: {
                provider: "anthropic",
                model: "claude",
                apiKeyPresent: true,
                apiKeysPresent: { anthropic: true },
            },
            integrations: { linear: { teamKey: "ENG", apiKeyPresent: true } },
        };
        const patch = createSettingsConfigPatch(form, {
            aiKeys: { anthropic: "sk-ant-new" },
            linearApiKey: "lin_new",
        });
        expect(patch).toMatchObject({
            ai: {
                provider: "anthropic",
                apiKey: "sk-ant-new",
                apiKeys: { anthropic: "sk-ant-new" },
            },
            integrations: { linear: { teamKey: "ENG", apiKey: "lin_new" } },
        });
    });

    it("remembers per-provider AI key drafts when switching providers", () => {
        let state = createInitialFormState({
            ai: { provider: "openai", model: "gpt-4o" },
        });
        state = reduceSettingsForm(state, {
            type: "updateAiKeyDraft",
            provider: "openai",
            value: "sk-openai",
        });
        state = reduceSettingsForm(state, {
            type: "update",
            section: "ai",
            field: "provider",
            value: "anthropic",
        });
        state = reduceSettingsForm(state, {
            type: "updateAiKeyDraft",
            provider: "anthropic",
            value: "sk-anthropic",
        });

        expect(state.secretDrafts.aiKeys).toEqual({
            openai: "sk-openai",
            anthropic: "sk-anthropic",
        });

        const patch = createSettingsConfigPatch(state.form, state.secretDrafts);
        expect(patch).toMatchObject({
            ai: {
                provider: "anthropic",
                apiKey: "sk-anthropic",
                apiKeys: { openai: "sk-openai", anthropic: "sk-anthropic" },
            },
        });
    });
});
