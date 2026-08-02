/**
 * Capability metadata exists so call sites can skip requests a model is known
 * to reject (vision on deepseek-chat, response_format on DeepSeek) instead of
 * paying the round-trip and leaking a raw provider error. `undefined` must
 * stay permissive — an unknown model keeps today's try-and-fall-back path.
 */
import { describe, expect, it } from "vitest";
import {
    getModelCapabilities,
    modelSupportsStructuredOutput,
    modelSupportsVision,
} from "../agent/ai-providers";

describe("getModelCapabilities", () => {
    it("marks deepseek-chat as text-only with no structured output", () => {
        expect(getModelCapabilities("deepseek", "deepseek-chat")).toEqual({
            vision: false,
            structuredOutput: false,
        });
        expect(modelSupportsVision("deepseek", "deepseek-chat")).toBe(false);
        expect(modelSupportsStructuredOutput("deepseek", "deepseek-chat")).toBe(false);
    });

    it("falls back to provider defaults for unlisted models of a known provider", () => {
        expect(getModelCapabilities("deepseek", "deepseek-v4-pro")).toEqual({
            vision: false,
            structuredOutput: false,
        });
        expect(getModelCapabilities("anthropic", "claude-fable-5")).toEqual({
            vision: true,
            structuredOutput: true,
        });
    });

    it("model-level capabilities override provider defaults", () => {
        expect(getModelCapabilities("openai", "o3-mini")).toEqual({
            vision: false,
            structuredOutput: true,
        });
    });

    it("treats unknown capabilities as worth trying", () => {
        expect(getModelCapabilities("ollama", "llama3.2")).toEqual({});
        expect(modelSupportsVision("ollama", "llama3.2")).toBe(true);
        expect(modelSupportsStructuredOutput("groq", "llama-3.3-70b-versatile")).toBe(true);
    });

    it("distinguishes the same underlying model across providers", () => {
        expect(modelSupportsVision("openrouter", "deepseek/deepseek-chat")).toBe(false);
        expect(modelSupportsVision("openrouter", "anthropic/claude-sonnet-4.5")).toBe(true);
    });
});
