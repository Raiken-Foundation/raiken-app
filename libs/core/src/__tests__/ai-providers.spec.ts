import { describe, expect, it, vi } from "vitest";
import {
    callWithTokenBudget,
    isEmptyLengthResponse,
    listProviders,
    modelSupportsReasoning,
    type ResolvedAIConfig,
    resolveTokenBudget,
} from "../agent/ai-providers";

function aiConfig(
    overrides: Partial<Pick<ResolvedAIConfig, "provider" | "model" | "maxTokens">> = {},
): ResolvedAIConfig {
    return {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
        apiKeySource: "env",
        maxTokens: 4000,
        temperature: 0.7,
        ...overrides,
    };
}

const emptyLengthResponse = {
    content: "",
    response_metadata: { finish_reason: "length" },
};

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

describe("reasoning capability", () => {
    it("marks known reasoning models", () => {
        expect(modelSupportsReasoning("openai", "o3-mini")).toBe(true);
        expect(modelSupportsReasoning("deepseek", "deepseek-reasoner")).toBe(true);
        expect(modelSupportsReasoning("google", "gemini-2.5-pro")).toBe(true);
    });

    it("leaves chat models and unknown models non-reasoning", () => {
        expect(modelSupportsReasoning("deepseek", "deepseek-chat")).toBe(false);
        expect(modelSupportsReasoning("openrouter", "deepseek/deepseek-chat")).toBe(false);
        expect(modelSupportsReasoning("openrouter", "deepseek/deepseek-v4-pro")).toBe(false);
        expect(modelSupportsReasoning("ollama", "llama3.2")).toBe(false);
    });
});

describe("resolveTokenBudget", () => {
    it("never drops below the resolved config (config contract)", () => {
        expect(resolveTokenBudget(aiConfig({ maxTokens: 4000 }))).toBe(4000);
        expect(resolveTokenBudget(aiConfig({ maxTokens: 1500 }))).toBe(2000);
    });

    it("gives reasoning models a higher floor", () => {
        expect(
            resolveTokenBudget(aiConfig({ provider: "openai", model: "o3-mini", maxTokens: 1500 })),
        ).toBe(4000);
        expect(
            resolveTokenBudget(aiConfig({ provider: "openai", model: "o3-mini", maxTokens: 8000 })),
        ).toBe(8000);
    });
});

describe("callWithTokenBudget", () => {
    it("retries once at 2x budget on the empty-length signature", async () => {
        let calls = 0;
        const result = await callWithTokenBudget({
            ai: aiConfig({ maxTokens: 2000 }),
            invoke: async () => {
                calls += 1;
                return calls === 1 ? emptyLengthResponse : { content: "ok" };
            },
            isExhausted: isEmptyLengthResponse,
        });

        expect(calls).toBe(2);
        expect(extractText(result)).toBe("ok");
    });

    it("throws a distinct error (naming the doubled budget) when the retry also exhausts", async () => {
        await expect(
            callWithTokenBudget({
                ai: aiConfig({ model: "deepseek/deepseek-v4-pro", maxTokens: 2000 }),
                invoke: async () => emptyLengthResponse,
                isExhausted: isEmptyLengthResponse,
            }),
        ).rejects.toThrow(/exhausted its reasoning budget.*\(4000\)/);
    });

    it("does not retry a normal response", async () => {
        const invoke = vi.fn(async () => ({ content: "fine" }));
        const result = await callWithTokenBudget({
            ai: aiConfig(),
            invoke,
            isExhausted: isEmptyLengthResponse,
        });
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(extractText(result)).toBe("fine");
    });

    it("does not retry an empty response that was not length-capped", async () => {
        const invoke = vi.fn(async () => ({
            content: "",
            response_metadata: { finish_reason: "stop" },
        }));
        await callWithTokenBudget({
            ai: aiConfig(),
            invoke,
            isExhausted: isEmptyLengthResponse,
        });
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it("passes the extended timeout to reasoning models", async () => {
        const timeouts: number[] = [];
        await callWithTokenBudget({
            ai: aiConfig({ provider: "openai", model: "o3-mini" }),
            invoke: async (_llm, timeoutMs) => {
                timeouts.push(timeoutMs);
                return { content: "ok" };
            },
        });
        expect(timeouts[0]).toBe(120_000);
    });
});

describe("isEmptyLengthResponse", () => {
    it("recognizes the empty + length-capped signature", () => {
        expect(isEmptyLengthResponse(emptyLengthResponse)).toBe(true);
        expect(
            isEmptyLengthResponse({
                content: [],
                response_metadata: { stop_reason: "max_tokens" },
            }),
        ).toBe(true);
        expect(
            isEmptyLengthResponse({
                content: "",
                response_metadata: { finishReason: "MAX_TOKENS" },
            }),
        ).toBe(true);
    });

    it("rejects usable or non-length-capped responses", () => {
        expect(isEmptyLengthResponse({ content: "text" })).toBe(false);
        expect(
            isEmptyLengthResponse({ content: "", response_metadata: { finish_reason: "stop" } }),
        ).toBe(false);
        expect(isEmptyLengthResponse(null)).toBe(false);
        expect(isEmptyLengthResponse("")).toBe(false);
    });
});

function extractText(response: unknown): string {
    return typeof (response as { content?: unknown }).content === "string"
        ? ((response as { content?: string }).content ?? "")
        : "";
}
