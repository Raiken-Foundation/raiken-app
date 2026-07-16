/**
 * `raiken config` / `/config` — CLI parity for the dashboard's Settings →
 * AI Provider panel. `buildAiConfigPatch` covers the flag-precedence logic
 * in isolation; the rest exercises `configCommand` end-to-end against a real
 * temp project directory (same `updateConfig` tRPC procedure the dashboard
 * uses), matching `discover-resume.spec.ts`'s "test against the real thing,
 * not a mock" approach.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelInfo } from "@raiken/core";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withThrowExit } from "../../repl/exit";

// The REPL wizard's model step fetches the live model catalog. Stubbed to an
// empty list by default (falls back to freeform text entry, no network) —
// the one test that needs the numbered picker overrides this per-call.
const mockListProviderModels = vi.fn(async () => ({ models: [] as ModelInfo[] }));

vi.mock(import("@raiken/core"), async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        listProviderModels: mockListProviderModels,
    };
});

const { buildAiConfigPatch, configCommand, looksLikeApiKey } = await import("../config");

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

describe("buildAiConfigPatch", () => {
    it("builds a patch from provider/model/baseUrl flags", () => {
        const result = buildAiConfigPatch({ provider: "openai", model: "gpt-4o" });
        expect(result).toEqual({ patch: { provider: "openai", model: "gpt-4o" } });
    });

    it("lowercases and trims a provider id", () => {
        const result = buildAiConfigPatch({ provider: " OpenAI " });
        expect(result).toEqual({ patch: { provider: "openai" } });
    });

    it("rejects an unknown provider id", () => {
        const result = buildAiConfigPatch({ provider: "bogus" });
        expect("error" in result && result.error).toContain('Unknown provider: "bogus"');
    });

    it("sets apiKey from --api-key", () => {
        const result = buildAiConfigPatch({ apiKey: "sk-test-123" });
        expect(result).toEqual({ patch: { apiKey: "sk-test-123" } });
    });

    it("--unset-key clears the key and wins over a simultaneous --api-key", () => {
        const result = buildAiConfigPatch({ apiKey: "sk-test-123", unsetKey: true });
        expect(result).toEqual({ patch: { apiKey: "" } });
    });

    it("returns an empty patch when no relevant flags are set", () => {
        const result = buildAiConfigPatch({ json: true, list: true });
        expect(result).toEqual({ patch: {} });
    });
});

describe("looksLikeApiKey", () => {
    it("recognizes known provider key prefixes", () => {
        expect(looksLikeApiKey("sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789")).toBe(true);
        expect(looksLikeApiKey("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toBe(true);
        expect(looksLikeApiKey("sk-proj-abcdefghijklmnopqrstuvwxyz")).toBe(true);
        expect(looksLikeApiKey("gsk_abcdefghijklmnopqrstuvwxyz")).toBe(true);
        expect(looksLikeApiKey("AIzaSyAbcdefghijklmnopqrstuvwxyz")).toBe(true);
        expect(looksLikeApiKey("pplx-abcdefghijklmnopqrstuvwxyz")).toBe(true);
        expect(looksLikeApiKey("xai-abcdefghijklmnopqrstuvwxyz")).toBe(true);
    });

    it("falls back to a long mixed alnum heuristic for unlisted formats", () => {
        expect(looksLikeApiKey("0b3d85ff19ae4280b3f5919571f370d2abcdefgh")).toBe(true);
        expect(looksLikeApiKey("deepseek-v4-pro")).toBe(false); // no digits, too short
    });

    it("rejects multi-token input (flags, sentences)", () => {
        expect(looksLikeApiKey("--provider openai --api-key sk-test-123")).toBe(false);
        expect(looksLikeApiKey("test the login flow")).toBe(false);
    });

    it("rejects short or plain hyphenated phrases", () => {
        expect(looksLikeApiKey("test-the-login-flow")).toBe(false);
        expect(looksLikeApiKey("sk-abc")).toBe(false);
    });

    it("rejects slash/bang-prefixed tokens (commands, not keys)", () => {
        expect(looksLikeApiKey("/config")).toBe(false);
        expect(looksLikeApiKey("!ls")).toBe(false);
    });
});

describe("configCommand", () => {
    let projectPath: string;
    let originalCwd: string;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        originalCwd = process.cwd();
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-config-cmd-"));
        process.chdir(projectPath);
        for (const key of AI_ENV_VARS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(projectPath, { recursive: true, force: true });
        for (const key of AI_ENV_VARS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        vi.restoreAllMocks();
    });

    function readConfig(): Record<string, unknown> {
        const raw = fs.readFileSync(path.join(projectPath, "raiken.config.json"), "utf-8");
        return JSON.parse(raw);
    }

    it("writes provider/apiKey/model to raiken.config.json via direct flags", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});

        await configCommand(undefined, {
            provider: "openai",
            apiKey: "sk-test-123",
            model: "gpt-4o",
        });

        const config = readConfig();
        expect(config.ai).toMatchObject({
            provider: "openai",
            apiKey: "sk-test-123",
            model: "gpt-4o",
        });
    });

    it("--unset-key clears a previously saved key", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});

        await configCommand(undefined, { provider: "openai", apiKey: "sk-test-123" });
        expect((readConfig().ai as Record<string, unknown>).apiKey).toBe("sk-test-123");

        await configCommand(undefined, { unsetKey: true });
        expect((readConfig().ai as Record<string, unknown>).apiKey).toBe("");
    });

    it("rejects an unknown provider with exit code 1 and no file write", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const code = await withThrowExit(() => configCommand(undefined, { provider: "bogus" }));

        expect(code).toBe(1);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown provider: "bogus"'));
        expect(fs.existsSync(path.join(projectPath, "raiken.config.json"))).toBe(false);
    });

    it("rejects an unsupported config section with exit code 1", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const code = await withThrowExit(() => configCommand("testing", {}));

        expect(code).toBe(1);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown config section'));
    });

    it("treats a bare key positional (no flags) as --api-key for the current provider", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});

        await configCommand("sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789", {});

        const config = readConfig();
        expect(config.ai).toMatchObject({
            apiKey: "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789",
        });
        // Default provider (openrouter) is left untouched — the point is to
        // set a key without needing to also specify --provider.
        expect((config.ai as Record<string, unknown>).provider).toBeUndefined();
    });

    it("an explicit --api-key flag wins over a key-like positional", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});

        await configCommand("sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789", {
            apiKey: "sk-explicit-flag-value",
        });

        expect((readConfig().ai as Record<string, unknown>).apiKey).toBe("sk-explicit-flag-value");
    });

    it("--list --json emits the provider catalog and current config, without writing anything", async () => {
        let output = "";
        vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
            output += typeof chunk === "string" ? chunk : String(chunk);
            return true;
        });

        await configCommand(undefined, { list: true, json: true });

        const parsed = JSON.parse(output);
        expect(parsed.current.provider).toBe("openrouter");
        expect(parsed.current.hasKey).toBe(false);
        expect(parsed.providers.map((p: { id: string }) => p.id)).toContain("ollama");
        expect(fs.existsSync(path.join(projectPath, "raiken.config.json"))).toBe(false);
    });

    it("reflects an env-sourced key as the active provider's key source", async () => {
        process.env.ANTHROPIC_API_KEY = "sk-ant-env-test";
        vi.spyOn(console, "log").mockImplementation(() => {});
        let output = "";
        vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
            output += typeof chunk === "string" ? chunk : String(chunk);
            return true;
        });

        await configCommand(undefined, {
            list: true,
            json: true,
            provider: undefined,
        });
        // No provider saved yet — default is openrouter, unaffected by the
        // Anthropic env var.
        expect(JSON.parse(output).current.hasKey).toBe(false);

        output = "";
        await configCommand(undefined, { provider: "anthropic" });
        await configCommand(undefined, { list: true, json: true });
        const parsed = JSON.parse(output);
        expect(parsed.current.provider).toBe("anthropic");
        expect(parsed.current.hasKey).toBe(true);
        expect(parsed.current.apiKeySource).toBe("env");
        expect(parsed.current.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
    });

    it("fromRepl with no flags prints the catalog instead of launching the interactive wizard", async () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

        await configCommand(undefined, { fromRepl: true });

        expect(logSpy).toHaveBeenCalled();
        const printed = logSpy.mock.calls.flat().join("\n");
        expect(printed).toContain("AI configuration");
        // Hint must include the `/config` prefix — bare flags typed at the
        // next prompt (no leading `/config`) get sent as a chat message
        // instead of running the command.
        expect(printed).toContain("/config <api-key>");
        expect(printed).toContain("/config --provider openai --api-key sk-... --model gpt-4o");
        expect(fs.existsSync(path.join(projectPath, "raiken.config.json"))).toBe(false);
    });

    describe("REPL-native wizard (fromRepl + replAsk)", () => {
        beforeEach(() => {
            vi.spyOn(console, "log").mockImplementation(() => {});
            mockListProviderModels.mockReset().mockResolvedValue({ models: [] });
        });

        /** Feeds one scripted answer per `ask()` call, in order. */
        function scriptedAsk(
            answers: Array<string | null>,
        ): (query: string) => Promise<string | null> {
            let i = 0;
            return async () => {
                const answer = i < answers.length ? answers[i] : null;
                i += 1;
                return answer;
            };
        }

        it("picks a provider by id, sets a key, keeps the default model, and saves", async () => {
            await configCommand(undefined, {
                fromRepl: true,
                replAsk: scriptedAsk(["deepseek", "sk-test-deepseek-key", "", "y"]),
            });

            expect(readConfig().ai).toMatchObject({
                provider: "deepseek",
                apiKey: "sk-test-deepseek-key",
            });
        });

        it("lets you pick a model by number from the fetched catalog", async () => {
            mockListProviderModels.mockResolvedValue({
                models: [
                    { id: "model-a", name: "Model A", source: "recommended" },
                    { id: "model-b", name: "Model B", source: "recommended" },
                ] satisfies ModelInfo[],
            });

            await configCommand(undefined, {
                fromRepl: true,
                // provider, key, model (pick #2 from the list), confirm
                replAsk: scriptedAsk(["deepseek", "sk-test-deepseek-key", "2", "y"]),
            });

            expect(readConfig().ai).toMatchObject({ provider: "deepseek", model: "model-b" });
        });

        it("falls back to freeform entry when the catalog fetch fails", async () => {
            mockListProviderModels.mockResolvedValue({ models: [], error: "network unreachable" });

            await configCommand(undefined, {
                fromRepl: true,
                replAsk: scriptedAsk(["deepseek", "sk-test-deepseek-key", "some-custom-model", "y"]),
            });

            expect(readConfig().ai).toMatchObject({ provider: "deepseek", model: "some-custom-model" });
        });

        it("skips the key prompt entirely for a keyless provider (Ollama)", async () => {
            await configCommand(undefined, {
                fromRepl: true,
                replAsk: scriptedAsk(["ollama", "", "y"]),
            });

            const config = readConfig();
            expect((config.ai as Record<string, unknown>).provider).toBe("ollama");
            // Switching *to* a keyless provider still clears any stale key
            // from the previous provider (same as the interactive wizard).
            expect((config.ai as Record<string, unknown>).apiKey).toBe("");
        });

        it("Enter on the provider prompt keeps the current provider", async () => {
            await configCommand(undefined, { provider: "anthropic", apiKey: "sk-ant-existing" });

            await configCommand(undefined, {
                fromRepl: true,
                replAsk: scriptedAsk(["", "", "", "y"]), // provider, key, model, confirm
            });

            expect((readConfig().ai as Record<string, unknown>).provider).toBe("anthropic");
        });

        it("rejects an unrecognized provider answer without writing anything", async () => {
            await configCommand(undefined, {
                fromRepl: true,
                replAsk: scriptedAsk(["not-a-real-provider"]),
            });

            expect(fs.existsSync(path.join(projectPath, "raiken.config.json"))).toBe(false);
        });

        it("Ctrl-C (null) at any step cancels without writing anything", async () => {
            await configCommand(undefined, { fromRepl: true, replAsk: scriptedAsk([null]) });

            expect(fs.existsSync(path.join(projectPath, "raiken.config.json"))).toBe(false);
        });

        it("declining the final confirmation does not write anything", async () => {
            await configCommand(undefined, {
                fromRepl: true,
                replAsk: scriptedAsk(["openai", "sk-test-openai", "", "n"]),
            });

            expect(fs.existsSync(path.join(projectPath, "raiken.config.json"))).toBe(false);
        });

        it("requires a base URL for the custom provider and aborts if left blank", async () => {
            // Order: provider, key, base URL (blank -> abort before the model
            // step is ever reached).
            await configCommand(undefined, {
                fromRepl: true,
                replAsk: scriptedAsk(["custom", "sk-test", ""]),
            });

            expect(fs.existsSync(path.join(projectPath, "raiken.config.json"))).toBe(false);

            // Order: provider, key, base URL, model, confirm. Base URL comes
            // before the model prompt since fetching a live model list needs
            // it (matters most for self-hosted/custom endpoints).
            await configCommand(undefined, {
                fromRepl: true,
                replAsk: scriptedAsk([
                    "custom",
                    "sk-test",
                    "http://localhost:1234/v1",
                    "my-model",
                    "y",
                ]),
            });

            expect(readConfig().ai).toMatchObject({
                provider: "custom",
                baseURL: "http://localhost:1234/v1",
                model: "my-model",
            });
        });
    });
});
