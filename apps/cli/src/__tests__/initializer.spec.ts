/**
 * `raiken init` AI-provider detection (ux-10).
 *
 * `raiken.config.json` used to hardcode `ai.provider: "openrouter"`
 * regardless of what was actually in the environment — a project with only
 * `ANTHROPIC_API_KEY` set would get a config that checks for
 * `OPENROUTER_API_KEY`, and `raiken status` would report the key as
 * "missing" forever. `detectAIProviderFromEnv` is what `createRaikenConfig`
 * uses to pick a provider that actually matches what's available.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectAIProviderFromEnv, getPlaywrightInstallCommand } from "../initializer";

const ALL_ENV_VARS = [
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

describe("detectAIProviderFromEnv", () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of ALL_ENV_VARS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of ALL_ENV_VARS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    it("returns null when nothing is set", () => {
        expect(detectAIProviderFromEnv()).toBeNull();
    });

    it("detects a single non-default provider from its env var", () => {
        process.env.ANTHROPIC_API_KEY = "sk-ant-test";
        expect(detectAIProviderFromEnv()).toEqual({
            provider: "anthropic",
            envVar: "ANTHROPIC_API_KEY",
        });
    });

    it("prefers openrouter when both openrouter and another provider are set", () => {
        process.env.ANTHROPIC_API_KEY = "sk-ant-test";
        process.env.OPENROUTER_API_KEY = "sk-or-test";
        expect(detectAIProviderFromEnv()).toEqual({
            provider: "openrouter",
            envVar: "OPENROUTER_API_KEY",
        });
    });

    it("ignores blank/whitespace-only env values", () => {
        process.env.ANTHROPIC_API_KEY = "   ";
        expect(detectAIProviderFromEnv()).toBeNull();
    });

    it("never auto-selects the custom provider from the generic AI_API_KEY fallback", () => {
        process.env.AI_API_KEY = "some-generic-key";
        expect(detectAIProviderFromEnv()).toBeNull();
    });

    it("supports Google's alternate GEMINI_API_KEY env var", () => {
        process.env.GEMINI_API_KEY = "AIzaSyTest";
        expect(detectAIProviderFromEnv()).toEqual({
            provider: "google",
            envVar: "GEMINI_API_KEY",
        });
    });
});

describe("getPlaywrightInstallCommand", () => {
    it("uses npm install -D by default", () => {
        expect(getPlaywrightInstallCommand("npm")).toEqual({
            cmd: "npm",
            args: ["install", "-D", "@playwright/test"],
        });
    });

    it("uses yarn add -D", () => {
        expect(getPlaywrightInstallCommand("yarn")).toEqual({
            cmd: "yarn",
            args: ["add", "-D", "@playwright/test"],
        });
    });

    it("uses pnpm add -D", () => {
        expect(getPlaywrightInstallCommand("pnpm")).toEqual({
            cmd: "pnpm",
            args: ["add", "-D", "@playwright/test"],
        });
    });

    it("uses bun add -d (lowercase flag)", () => {
        expect(getPlaywrightInstallCommand("bun")).toEqual({
            cmd: "bun",
            args: ["add", "-d", "@playwright/test"],
        });
    });
});
