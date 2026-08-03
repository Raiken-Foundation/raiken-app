/**
 * Multi-provider AI configuration utilities.
 *
 * Centralizes everything that varies per AI provider:
 *   - default model + base URL
 *   - environment-variable name(s) for the API key
 *   - how to fetch the live model catalog from the provider's API
 *   - which AI SDK client to instantiate at runtime
 *
 * The goal: the rest of the codebase reads from `resolveAIConfig()` /
 * `createAIClient()` instead of hardcoding `OPENROUTER_API_KEY` everywhere.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { defaultConfig, loadAIConfigSection } from "../config";
import { AI_PROVIDER_IDS, type AIProviderId } from "../config/schema";

/**
 * What a model is known to accept. `undefined` means unknown — callers keep
 * today's try-and-fall-back behavior. Only `false` changes anything: it lets a
 * call site skip a request the provider is known to reject, instead of paying
 * for the round-trip and leaking the raw provider error into the CLI.
 */
export interface ModelCapabilities {
    /** Accepts image parts in messages. */
    vision?: boolean;
    /** Accepts `response_format` / structured-output (json_schema) requests. */
    structuredOutput?: boolean;
    /**
     * Spends output tokens on internal reasoning before the answer
     * (o-series, deepseek-reasoner). Reasoning models need a larger token
     * budget and a longer request timeout than their chat-model siblings.
     */
    reasoning?: boolean;
}

export interface ProviderDefinition {
    id: AIProviderId;
    label: string;
    /** Human-readable summary used in the UI. */
    description: string;
    /** Default base URL for this provider's REST API. */
    defaultBaseURL: string;
    /** Default model identifier when none is specified. */
    defaultModel: string;
    /** Environment variables checked for an API key (in order). */
    envVars: string[];
    /** Whether the provider's models can be listed without an API key. */
    publicCatalog: boolean;
    /** Where to obtain an API key. */
    apiKeyUrl?: string;
    /** Format hint for the API key input field. */
    apiKeyPlaceholder?: string;
    /** Curated models shown before/when live provider discovery is unavailable. */
    recommendedModels: ModelInfo[];
    /** Capabilities assumed for any model of this provider not listed above. */
    defaultCapabilities?: ModelCapabilities;
}

export const AI_PROVIDERS: Record<AIProviderId, ProviderDefinition> = {
    openrouter: {
        id: "openrouter",
        label: "OpenRouter",
        description: "Single key, every model. Default Raiken provider.",
        defaultBaseURL: "https://openrouter.ai/api/v1",
        defaultModel: "anthropic/claude-sonnet-4.5",
        envVars: ["OPENROUTER_API_KEY"],
        publicCatalog: true,
        apiKeyUrl: "https://openrouter.ai/keys",
        apiKeyPlaceholder: "sk-or-v1-…",
        recommendedModels: [
            {
                id: "anthropic/claude-sonnet-4.5",
                name: "Claude Sonnet 4.5",
                description: "Default balanced coding model",
                context: 200_000,
                source: "recommended",
                capabilities: { vision: true, structuredOutput: true },
            },
            {
                id: "openai/gpt-4o",
                name: "GPT-4o",
                description: "Fast general-purpose model",
                context: 128_000,
                source: "recommended",
                capabilities: { vision: true, structuredOutput: true },
            },
            {
                id: "deepseek/deepseek-chat",
                name: "DeepSeek Chat",
                description: "Cost-efficient OpenAI-compatible chat model",
                source: "recommended",
                capabilities: { vision: false, structuredOutput: false },
            },
        ],
    },
    openai: {
        id: "openai",
        defaultCapabilities: { structuredOutput: true },
        label: "OpenAI",
        description: "Direct access to GPT-4o, o1, o3-mini, etc.",
        defaultBaseURL: "https://api.openai.com/v1",
        defaultModel: "gpt-4o",
        envVars: ["OPENAI_API_KEY"],
        publicCatalog: false,
        apiKeyUrl: "https://platform.openai.com/api-keys",
        apiKeyPlaceholder: "sk-…",
        recommendedModels: [
            {
                id: "gpt-4o",
                name: "GPT-4o",
                description: "Fast multimodal general-purpose model",
                context: 128_000,
                source: "recommended",
                capabilities: { vision: true, structuredOutput: true },
            },
            {
                id: "gpt-4o-mini",
                name: "GPT-4o mini",
                description: "Lower-cost everyday model",
                context: 128_000,
                source: "recommended",
                capabilities: { vision: true, structuredOutput: true },
            },
            {
                id: "o3-mini",
                name: "o3 mini",
                description: "Reasoning-oriented model",
                source: "recommended",
                capabilities: { vision: false, structuredOutput: true, reasoning: true },
            },
        ],
    },
    anthropic: {
        id: "anthropic",
        defaultCapabilities: { vision: true, structuredOutput: true },
        label: "Anthropic",
        description: "Direct access to Claude (Sonnet, Opus, Haiku).",
        defaultBaseURL: "https://api.anthropic.com/v1",
        defaultModel: "claude-sonnet-4-5",
        envVars: ["ANTHROPIC_API_KEY"],
        publicCatalog: false,
        apiKeyUrl: "https://console.anthropic.com/settings/keys",
        apiKeyPlaceholder: "sk-ant-…",
        recommendedModels: [
            {
                id: "claude-sonnet-4-5",
                name: "Claude Sonnet 4.5",
                description: "Balanced coding and reasoning",
                context: 200_000,
                source: "recommended",
            },
            {
                id: "claude-opus-4-1",
                name: "Claude Opus 4.1",
                description: "Heavier reasoning model",
                context: 200_000,
                source: "recommended",
            },
            {
                id: "claude-haiku-3-5",
                name: "Claude Haiku 3.5",
                description: "Fast lower-cost model",
                context: 200_000,
                source: "recommended",
            },
        ],
    },
    google: {
        id: "google",
        defaultCapabilities: { vision: true, structuredOutput: true },
        label: "Google AI Studio",
        description: "Gemini 2.5 / 2.0 family via Google's Generative AI API.",
        defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
        defaultModel: "gemini-2.0-flash",
        envVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
        publicCatalog: false,
        apiKeyUrl: "https://aistudio.google.com/app/apikey",
        apiKeyPlaceholder: "AIza…",
        recommendedModels: [
            {
                id: "gemini-2.0-flash",
                name: "Gemini 2.0 Flash",
                description: "Fast Gemini model",
                source: "recommended",
            },
            {
                id: "gemini-2.5-pro",
                name: "Gemini 2.5 Pro",
                description: "Reasoning-oriented Gemini model",
                source: "recommended",
                capabilities: { reasoning: true },
            },
            {
                id: "gemini-2.5-flash",
                name: "Gemini 2.5 Flash",
                description: "Fast 2.5-series Gemini model",
                source: "recommended",
            },
        ],
    },
    groq: {
        id: "groq",
        label: "Groq",
        description: "Ultra-fast inference for Llama, Mixtral, Gemma.",
        defaultBaseURL: "https://api.groq.com/openai/v1",
        defaultModel: "llama-3.3-70b-versatile",
        envVars: ["GROQ_API_KEY"],
        publicCatalog: false,
        apiKeyUrl: "https://console.groq.com/keys",
        apiKeyPlaceholder: "gsk_…",
        recommendedModels: [
            {
                id: "llama-3.3-70b-versatile",
                name: "Llama 3.3 70B Versatile",
                description: "Default Groq model",
                source: "recommended",
            },
            {
                id: "llama-3.1-8b-instant",
                name: "Llama 3.1 8B Instant",
                description: "Very fast low-latency model",
                source: "recommended",
            },
        ],
    },
    mistral: {
        id: "mistral",
        label: "Mistral AI",
        description: "Mistral Large, Codestral, Pixtral.",
        defaultBaseURL: "https://api.mistral.ai/v1",
        defaultModel: "mistral-large-latest",
        envVars: ["MISTRAL_API_KEY"],
        publicCatalog: false,
        apiKeyUrl: "https://console.mistral.ai/api-keys",
        apiKeyPlaceholder: "…",
        recommendedModels: [
            {
                id: "mistral-large-latest",
                name: "Mistral Large",
                description: "Default Mistral model",
                source: "recommended",
            },
            {
                id: "codestral-latest",
                name: "Codestral",
                description: "Code-focused Mistral model",
                source: "recommended",
            },
        ],
    },
    deepseek: {
        id: "deepseek",
        defaultCapabilities: { vision: false, structuredOutput: false },
        label: "DeepSeek",
        description: "DeepSeek chat and reasoning models.",
        defaultBaseURL: "https://api.deepseek.com/v1",
        defaultModel: "deepseek-chat",
        envVars: ["DEEPSEEK_API_KEY"],
        publicCatalog: false,
        apiKeyUrl: "https://platform.deepseek.com/api_keys",
        apiKeyPlaceholder: "sk-…",
        recommendedModels: [
            {
                id: "deepseek-chat",
                name: "DeepSeek Chat",
                description: "Default DeepSeek chat model",
                source: "recommended",
                capabilities: { vision: false, structuredOutput: false },
            },
            {
                id: "deepseek-reasoner",
                name: "DeepSeek Reasoner",
                description: "Reasoning model for harder planning/debugging",
                source: "recommended",
                capabilities: { vision: false, structuredOutput: false, reasoning: true },
            },
        ],
    },
    xai: {
        id: "xai",
        label: "xAI",
        description: "Grok models from xAI.",
        defaultBaseURL: "https://api.x.ai/v1",
        defaultModel: "grok-2-latest",
        envVars: ["XAI_API_KEY"],
        publicCatalog: false,
        apiKeyUrl: "https://console.x.ai/",
        apiKeyPlaceholder: "xai-…",
        recommendedModels: [
            {
                id: "grok-2-latest",
                name: "Grok 2",
                description: "Default xAI model",
                source: "recommended",
            },
        ],
    },
    together: {
        id: "together",
        label: "Together AI",
        description: "Hosted open-source models (Llama, Qwen, Mixtral).",
        defaultBaseURL: "https://api.together.xyz/v1",
        defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        envVars: ["TOGETHER_API_KEY"],
        publicCatalog: false,
        apiKeyUrl: "https://api.together.xyz/settings/api-keys",
        apiKeyPlaceholder: "…",
        recommendedModels: [
            {
                id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
                name: "Llama 3.3 70B Instruct Turbo",
                description: "Default Together model",
                source: "recommended",
            },
            {
                id: "Qwen/Qwen2.5-Coder-32B-Instruct",
                name: "Qwen 2.5 Coder 32B",
                description: "Code-focused open model",
                source: "recommended",
            },
        ],
    },
    perplexity: {
        id: "perplexity",
        label: "Perplexity",
        description: "Sonar models with native web search.",
        defaultBaseURL: "https://api.perplexity.ai",
        defaultModel: "sonar",
        envVars: ["PERPLEXITY_API_KEY"],
        publicCatalog: false,
        apiKeyUrl: "https://www.perplexity.ai/settings/api",
        apiKeyPlaceholder: "pplx-…",
        recommendedModels: [
            {
                id: "sonar",
                name: "Sonar",
                description: "Default Perplexity model",
                source: "recommended",
            },
            {
                id: "sonar-pro",
                name: "Sonar Pro",
                description: "Higher-capability Perplexity model",
                source: "recommended",
            },
        ],
    },
    ollama: {
        id: "ollama",
        label: "Ollama (local)",
        description: "Self-hosted models via a local Ollama server.",
        defaultBaseURL: "http://localhost:11434/v1",
        defaultModel: "llama3.2",
        envVars: [],
        publicCatalog: true,
        apiKeyPlaceholder: "(usually empty)",
        recommendedModels: [
            {
                id: "llama3.2",
                name: "Llama 3.2",
                description: "Common local Ollama model",
                source: "recommended",
            },
            {
                id: "qwen2.5-coder",
                name: "Qwen 2.5 Coder",
                description: "Common local code model",
                source: "recommended",
            },
        ],
    },
    custom: {
        id: "custom",
        label: "Custom (OpenAI-compatible)",
        description: "Any OpenAI-compatible endpoint. Set base URL and key.",
        defaultBaseURL: "",
        defaultModel: "",
        envVars: ["AI_API_KEY"],
        publicCatalog: false,
        apiKeyPlaceholder: "…",
        recommendedModels: [],
    },
};

/**
 * Known capabilities for a provider/model pair: the model's own catalog entry
 * merged over the provider's defaults. Unknown models of a known provider get
 * the provider defaults; unknown providers get `{}` (= try and fall back).
 */
export function getModelCapabilities(provider: AIProviderId, model: string): ModelCapabilities {
    const definition = AI_PROVIDERS[provider] as ProviderDefinition | undefined;
    if (!definition) return {};
    const entry = definition.recommendedModels.find((m) => m.id === model);
    return { ...definition.defaultCapabilities, ...entry?.capabilities };
}

/** Convenience wrappers: `undefined` (unknown) is treated as "worth trying". */
export function modelSupportsVision(provider: AIProviderId, model: string): boolean {
    return getModelCapabilities(provider, model).vision !== false;
}

export function modelSupportsStructuredOutput(provider: AIProviderId, model: string): boolean {
    return getModelCapabilities(provider, model).structuredOutput !== false;
}

/** True when the model is known to spend output tokens on reasoning. */
export function modelSupportsReasoning(provider: AIProviderId, model: string): boolean {
    return getModelCapabilities(provider, model).reasoning === true;
}

/**
 * Every OpenAI-compatible provider is spoken to through the OpenRouter wire
 * adapter (see `buildAISdkModel`), so AI SDK warnings would name "openrouter"
 * even when the configured provider is DeepSeek or Groq. Remember which
 * configured provider each model id belongs to so the warning logger below can
 * print the name the user actually chose.
 */
const configuredProviderByModel = new Map<string, AIProviderId>();

interface AISdkWarning {
    type?: string;
    feature?: string;
    message?: string;
    details?: string;
}

/**
 * Replace the AI SDK's default warning logger once per process. Two fixes over
 * the default: warnings name the configured provider instead of the wire
 * adapter, and "compatibility" notices (SDK-internal, e.g. specificationVersion
 * shims) are dropped — they read like errors but describe normal operation.
 * A user-supplied `AI_SDK_LOG_WARNINGS` global is left untouched.
 */
function installWarningLogger(): void {
    const scope = globalThis as { AI_SDK_LOG_WARNINGS?: unknown; __raikenWarningLogger?: boolean };
    if (scope.__raikenWarningLogger || scope.AI_SDK_LOG_WARNINGS !== undefined) return;
    scope.__raikenWarningLogger = true;
    scope.AI_SDK_LOG_WARNINGS = (options: {
        warnings: AISdkWarning[];
        provider: string;
        model: string;
    }) => {
        const provider = configuredProviderByModel.get(options.model) ?? options.provider;
        for (const warning of options.warnings) {
            if (warning.type === "compatibility") continue;
            const detail =
                warning.type === "unsupported" && warning.feature
                    ? `the feature "${warning.feature}" is not supported${
                          warning.details ? ` (${warning.details})` : ""
                      }`
                    : (warning.message ?? warning.details ?? JSON.stringify(warning));
            console.warn(`AI provider warning (${provider} / ${options.model}): ${detail}`);
        }
    };
}

export function listProviders(): ProviderDefinition[] {
    return AI_PROVIDER_IDS.map((id) => AI_PROVIDERS[id]);
}

export function getProvider(id: string | undefined): ProviderDefinition {
    if (id && (AI_PROVIDER_IDS as readonly string[]).includes(id)) {
        return AI_PROVIDERS[id as AIProviderId];
    }
    return AI_PROVIDERS.openrouter;
}

/**
 * Look up an API key from the environment using the provider's known env vars.
 * `AI_API_KEY` is intentionally reserved for the `custom` provider: applying
 * one generic key to every first-party provider cross-wires credentials (for
 * example, a gateway token being sent to Anthropic). Built-in providers only
 * read their explicitly documented environment variables.
 */
export function readApiKeyFromEnv(provider: AIProviderId): string | undefined {
    const def = AI_PROVIDERS[provider];
    for (const name of def.envVars) {
        const value = process.env[name];
        if (value?.trim()) return value;
    }
    if (provider !== "custom") return undefined;
    const { AI_API_KEY: generic } = process.env;
    return generic?.trim() ? generic : undefined;
}

export interface ResolvedAIConfig {
    provider: AIProviderId;
    apiKey?: string;
    /** Source of the resolved API key, useful for status/diagnostics. */
    apiKeySource: "env" | "config" | "none";
    /** Env var name used (if `apiKeySource === "env"`). */
    apiKeyEnvVar?: string;
    model: string;
    baseURL: string;
    maxTokens: number;
    temperature: number;
}

export interface AIConfigOverride {
    provider?: AIProviderId | string;
    apiKey?: string;
    model?: string;
    baseURL?: string;
    maxTokens?: number;
    temperature?: number;
}

/**
 * Resolve the AI configuration for `projectPath` by merging:
 *   1. Provider defaults (model, base URL, env-var lookup)
 *   2. raiken.config.json (if present)
 *   3. Environment variables — API KEY ONLY (via readApiKeyFromEnv); env does
 *      not override provider, model, baseURL, temperature, or maxTokens
 *   4. Programmatic `override` (wins over everything, including model)
 */
export function resolveAIConfig(
    projectPath: string,
    override?: AIConfigOverride,
): ResolvedAIConfig {
    const configFromFile: ReturnType<typeof loadAIConfigSection> = loadAIConfigSection(projectPath);

    const providerId = (override?.provider ?? configFromFile.provider ?? "openrouter") as string;
    const provider = getProvider(providerId);

    const envKey = readApiKeyFromEnv(provider.id);

    let apiKey: string | undefined;
    let apiKeySource: ResolvedAIConfig["apiKeySource"] = "none";
    let apiKeyEnvVar: string | undefined;

    if (override?.apiKey) {
        apiKey = override.apiKey;
        apiKeySource = "config";
    } else if (envKey) {
        apiKey = envKey;
        apiKeySource = "env";
        apiKeyEnvVar = provider.envVars.find((name) => process.env[name]?.trim());
    } else {
        // `apiKey` is the legacy/current-provider field. Once an `apiKeys`
        // map exists, only consult it for the provider recorded in the file:
        // an override for a different provider must never reuse the active
        // provider's credential.
        const canUseLegacyKey =
            configFromFile.provider === provider.id ||
            (!configFromFile.provider && provider.id === "openrouter");
        const savedKey =
            configFromFile.apiKeys?.[provider.id] ??
            (canUseLegacyKey ? configFromFile.apiKey : undefined);
        if (savedKey) {
            apiKey = savedKey;
            apiKeySource = "config";
        }
    }

    return {
        provider: provider.id,
        apiKey,
        apiKeySource,
        apiKeyEnvVar,
        model: override?.model ?? configFromFile.model ?? provider.defaultModel,
        baseURL: override?.baseURL ?? configFromFile.baseURL ?? provider.defaultBaseURL,
        maxTokens: override?.maxTokens ?? configFromFile.maxTokens ?? defaultConfig.ai.maxTokens,
        temperature:
            override?.temperature ?? configFromFile.temperature ?? defaultConfig.ai.temperature,
    };
}

// ---------------------------------------------------------------------------
// Model catalog discovery
// ---------------------------------------------------------------------------

export interface ModelInfo {
    id: string;
    /** Display name; falls back to id when the provider doesn't expose one. */
    name: string;
    /** Optional context window size in tokens. */
    context?: number;
    /** Free-form description (may include pricing/owner). */
    description?: string;
    /** Whether the provider tags this model as deprecated. */
    deprecated?: boolean;
    /** Where this option came from. */
    source?: "live" | "recommended";
    /** Known capabilities; absent fields mean "unknown, try and fall back". */
    capabilities?: ModelCapabilities;
}

interface ListModelsArgs {
    provider: AIProviderId;
    apiKey?: string;
    baseURL?: string;
}

/**
 * Fetch the live model catalog for a given provider.
 *
 * Returns an empty list on auth/network errors so the UI can fall back to a
 * free-form text input. Callers should treat this as a soft hint, not gospel.
 */
export async function listProviderModels(
    args: ListModelsArgs,
): Promise<{ models: ModelInfo[]; error?: string }> {
    const provider = getProvider(args.provider);
    const baseURL = args.baseURL?.trim() || provider.defaultBaseURL;
    const apiKey = args.apiKey?.trim() || readApiKeyFromEnv(provider.id);

    try {
        let result: { models: ModelInfo[]; error?: string };
        switch (provider.id) {
            case "openrouter":
                result = await fetchOpenRouterModels(baseURL);
                break;
            case "anthropic":
                result = await fetchAnthropicModels(baseURL, apiKey);
                break;
            case "google":
                result = await fetchGoogleModels(baseURL, apiKey);
                break;
            case "ollama":
                result = await fetchOllamaModels(baseURL);
                break;
            default:
                result = await fetchOpenAICompatibleModels(baseURL, apiKey);
        }
        return mergeRecommendedModels(provider, result);
    } catch (err) {
        return {
            models: provider.recommendedModels,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

function mergeRecommendedModels(
    provider: ProviderDefinition,
    result: { models: ModelInfo[]; error?: string },
): { models: ModelInfo[]; error?: string } {
    const seen = new Set<string>();
    const models = [...result.models, ...provider.recommendedModels]
        .filter((model) => {
            if (seen.has(model.id)) return false;
            seen.add(model.id);
            return true;
        })
        .map((model) => ({
            ...model,
            source: model.source ?? "live",
        }));
    return { ...result, models };
}

async function fetchOpenRouterModels(baseURL: string) {
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`);
    if (!res.ok) throw new Error(`OpenRouter ${res.status} ${res.statusText}`);
    const json = (await res.json()) as {
        data?: Array<{
            id: string;
            name?: string;
            context_length?: number;
            description?: string;
        }>;
    };
    const models: ModelInfo[] = (json.data ?? []).map((m) => ({
        id: m.id,
        name: m.name || m.id,
        context: m.context_length,
        description: m.description,
        source: "live",
    }));
    return { models };
}

async function fetchOpenAICompatibleModels(baseURL: string, apiKey?: string) {
    if (!apiKey) {
        return {
            models: [],
            error: "API key required to list models for this provider.",
        };
    }
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
        throw new Error(`Provider /models returned ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
        data?: Array<{ id: string; owned_by?: string; created?: number }>;
    };
    const models: ModelInfo[] = (json.data ?? []).map((m) => ({
        id: m.id,
        name: m.id,
        description: m.owned_by ? `owned by ${m.owned_by}` : undefined,
        source: "live",
    }));
    return { models };
}

async function fetchAnthropicModels(baseURL: string, apiKey?: string) {
    if (!apiKey) {
        return {
            models: [],
            error: "ANTHROPIC_API_KEY required to list Anthropic models.",
        };
    }
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/models?limit=200`, {
        headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
        },
    });
    if (!res.ok) {
        throw new Error(`Anthropic /models returned ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
        data?: Array<{ id: string; display_name?: string; type?: string }>;
    };
    const models: ModelInfo[] = (json.data ?? []).map((m) => ({
        id: m.id,
        name: m.display_name || m.id,
        source: "live",
    }));
    return { models };
}

async function fetchGoogleModels(baseURL: string, apiKey?: string) {
    if (!apiKey) {
        return {
            models: [],
            error: "GOOGLE_API_KEY required to list Gemini models.",
        };
    }
    const url = `${baseURL.replace(/\/$/, "")}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Google /models returned ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
        models?: Array<{
            name: string;
            displayName?: string;
            description?: string;
            inputTokenLimit?: number;
            supportedGenerationMethods?: string[];
        }>;
    };
    const models: ModelInfo[] = (json.models ?? [])
        .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m) => {
            const id = m.name.replace(/^models\//, "");
            return {
                id,
                name: m.displayName || id,
                context: m.inputTokenLimit,
                description: m.description,
                source: "live" as const,
            };
        });
    return { models };
}

async function fetchOllamaModels(baseURL: string) {
    // Ollama's native /api/tags is more reliable than its /v1/models shim
    const root = baseURL.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    const res = await fetch(`${root}/api/tags`);
    if (!res.ok) {
        throw new Error(`Ollama /api/tags returned ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
        models?: Array<{ name: string; size?: number; digest?: string }>;
    };
    const models: ModelInfo[] = (json.models ?? []).map((m) => ({
        id: m.name,
        name: m.name,
        description: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : undefined,
        source: "live",
    }));
    return { models };
}

// ---------------------------------------------------------------------------
// Runtime client factory
// ---------------------------------------------------------------------------

/**
 * Build an AI SDK `LanguageModel` for the given provider/model.
 *
 * Anthropic and Google do not speak the OpenAI chat-completions wire format, so
 * they get their native AI SDK providers. Everything else (OpenAI, OpenRouter,
 * Ollama, custom, and any OpenAI-compatible endpoint) is routed through the
 * OpenRouter client pointed at the provider's own base URL.
 */
export function buildAISdkModel(input: {
    provider: AIProviderId;
    apiKey?: string;
    baseURL?: string;
    model: string;
}): LanguageModel {
    const apiKey = input.apiKey ?? "";
    installWarningLogger();
    configuredProviderByModel.set(input.model, input.provider);
    switch (input.provider) {
        case "anthropic": {
            const client = createAnthropic({ apiKey });
            return client(input.model) as unknown as LanguageModel;
        }
        case "google": {
            const client = createGoogleGenerativeAI({ apiKey });
            return client(input.model) as unknown as LanguageModel;
        }
        default: {
            const client = createOpenRouter({
                apiKey,
                ...(input.baseURL ? { baseURL: input.baseURL } : {}),
            });
            return client.chat(input.model) as unknown as LanguageModel;
        }
    }
}

/**
 * Returns an AI SDK chat-capable model handle for the resolved config.
 * Native providers (Anthropic, Google) use their own SDK; OpenAI-compatible
 * providers route through the OpenRouter client at the configured base URL.
 */
export interface AIClient {
    provider: AIProviderId;
    model: LanguageModel;
}

export function createAIClient(resolved: ResolvedAIConfig): AIClient {
    return {
        provider: resolved.provider,
        model: buildAISdkModel({
            provider: resolved.provider,
            apiKey: resolved.apiKey,
            baseURL: resolved.baseURL,
            model: resolved.model,
        }),
    };
}

/**
 * Per-request timeout (ms) for every LLM call. Without this LangChain has no
 * request timeout, so a provider that accepts the connection but never responds
 * hangs the whole agent run forever (the dashboard just "loads infinitely").
 *
 * Set at the SDK-client level below for Anthropic/OpenAI (`clientOptions.timeout`
 * / `timeout`), which enforces it under the hood. `@langchain/google-genai` has
 * no equivalent client-level option, so callers MUST also pass
 * `{ timeout: LLM_REQUEST_TIMEOUT_MS }` as the second argument to every
 * `.invoke()` / `.stream()` / `.withStructuredOutput(...).invoke()` call —
 * LangChain's `Runnable.invoke(input, config)` turns `config.timeout` into a
 * real `AbortSignal` that every provider (including Google) threads through
 * to its underlying HTTP call. This is exported so every call site shares one
 * value instead of each node picking its own (or forgetting to set one).
 */
export const LLM_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Reasoning models can chew on a prompt for a while before their first output
 * token; the standard request timeout can cut them off before they ever
 * answer. Known reasoning models get 2× the standard timeout.
 */
export const REASONING_REQUEST_TIMEOUT_MS = 2 * LLM_REQUEST_TIMEOUT_MS;

/**
 * Minimum output-token budget for drafting calls. A call must never silently
 * drop below the user's configured maxTokens (the config contract), and it
 * must never be so small that a heavy draft cannot fit.
 */
export const TOKEN_BUDGET_FLOOR = 2000;

/**
 * Reasoning models spend output tokens on chain-of-thought before the answer
 * (e.g. ~1700 tokens of thinking plus ~1300 tokens of content for one draft);
 * give them twice the standard floor so the answer itself fits.
 */
export const REASONING_TOKEN_BUDGET_FLOOR = 4000;

/** Per-request timeout for a provider/model pair; reasoning models get more. */
export function requestTimeoutMs(ai: Pick<ResolvedAIConfig, "provider" | "model">): number {
    return modelSupportsReasoning(ai.provider, ai.model)
        ? REASONING_REQUEST_TIMEOUT_MS
        : LLM_REQUEST_TIMEOUT_MS;
}

/**
 * The output-token budget for one call: the resolved config, but never below
 * the drafting floor — reasoning models get a higher floor because they spend
 * tokens on thinking before the answer.
 */
export function resolveTokenBudget(
    ai: Pick<ResolvedAIConfig, "provider" | "model" | "maxTokens">,
): number {
    const floor = modelSupportsReasoning(ai.provider, ai.model)
        ? REASONING_TOKEN_BUDGET_FLOOR
        : TOKEN_BUDGET_FLOOR;
    return Math.max(ai.maxTokens, floor);
}

/**
 * Bounded retries. LangChain's default is 6 with exponential backoff, which on a
 * rate-limited/5xx provider can stall a single call for minutes. Two keeps us
 * resilient to transient blips without looking hung.
 */
export const LLM_MAX_RETRIES = 2;

/**
 * Build a LangChain chat model for the resolved config. The LangGraph agent
 * calls `.invoke()` / `.withStructuredOutput()` on this, so native Anthropic
 * and Google models work end-to-end (not only the OpenAI-compatible ones).
 *
 * Every model is given a hard request timeout and a bounded retry count so a
 * slow/unresponsive provider fails fast (surfaced as an error/pause) instead of
 * hanging the run indefinitely.
 */
export function createLangChainModel(resolved: ResolvedAIConfig): BaseChatModel {
    switch (resolved.provider) {
        case "anthropic":
            return new ChatAnthropic({
                apiKey: resolved.apiKey,
                model: resolved.model,
                temperature: resolved.temperature,
                maxTokens: resolved.maxTokens,
                maxRetries: LLM_MAX_RETRIES,
                clientOptions: { timeout: LLM_REQUEST_TIMEOUT_MS },
            });
        case "google":
            return new ChatGoogleGenerativeAI({
                apiKey: resolved.apiKey,
                model: resolved.model,
                temperature: resolved.temperature,
                maxOutputTokens: resolved.maxTokens,
                maxRetries: LLM_MAX_RETRIES,
            });
        case "openai":
            return new ChatOpenAI({
                apiKey: resolved.apiKey,
                model: resolved.model,
                temperature: resolved.temperature,
                maxTokens: resolved.maxTokens,
                timeout: LLM_REQUEST_TIMEOUT_MS,
                maxRetries: LLM_MAX_RETRIES,
            });
        default:
            // openrouter, ollama, custom, and any OpenAI-compatible endpoint.
            return new ChatOpenAI({
                apiKey: resolved.apiKey,
                model: resolved.model,
                temperature: resolved.temperature,
                maxTokens: resolved.maxTokens,
                timeout: LLM_REQUEST_TIMEOUT_MS,
                maxRetries: LLM_MAX_RETRIES,
                configuration: { baseURL: resolved.baseURL },
            });
    }
}

// ---------------------------------------------------------------------------
// Token-budgeted LLM calls
// ---------------------------------------------------------------------------

/** Normalize an AI SDK / LangChain content field into plain text. */
export function extractContentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) =>
                typeof part === "string"
                    ? part
                    : typeof part === "object" && part !== null && "text" in part
                      ? String((part as { text: unknown }).text)
                      : "",
            )
            .join("");
    }
    return "";
}

/** Extract the plain text from a model response message (LangChain AIMessage). */
export function extractMessageContent(response: unknown): string {
    if (!response || typeof response !== "object") return "";
    return extractContentText((response as { content?: unknown }).content);
}

/**
 * The reasoning-model failure signature: the response is empty and the call
 * was cut off at the output-token cap (finish_reason length/max_tokens), i.e.
 * the model spent its whole budget thinking and produced nothing usable.
 */
export function isEmptyLengthResponse(response: unknown): boolean {
    if (!response || typeof response !== "object") return false;
    if (extractMessageContent(response).trim().length > 0) return false;
    const meta =
        (response as { response_metadata?: Record<string, unknown> }).response_metadata ?? {};
    const finish = meta["finish_reason"] ?? meta["stop_reason"] ?? meta["finishReason"];
    return finish === "length" || finish === "max_tokens" || finish === "MAX_TOKENS";
}

/**
 * One LLM call under a config-respecting token budget, with a single bounded
 * retry for the empty-length failure signature: retry once at 2× the budget so
 * a reasoning model that spent its whole budget thinking isn't a guaranteed
 * dead end. Cost-bounded — at most one extra call, and only when the first
 * produced nothing usable. If the retry also exhausts, a distinct error is
 * thrown instead of a broken result being handed to the caller.
 */
export async function callWithTokenBudget<T>(options: {
    ai: ResolvedAIConfig;
    temperature?: number;
    /** Run the call once; receives the model, pre-built with its budget, and the request timeout. */
    invoke: (llm: BaseChatModel, timeoutMs: number) => Promise<T>;
    /** True when this result is a length-cap exhaustion with no usable output. */
    isExhausted?: (result: T) => boolean;
}): Promise<T> {
    const isExhausted = options.isExhausted ?? (() => false);
    const temperature = options.temperature ?? defaultConfig.ai.temperature;
    let maxTokens = resolveTokenBudget(options.ai);
    const timeoutMs = requestTimeoutMs(options.ai);
    const build = () => createLangChainModel({ ...options.ai, temperature, maxTokens });

    let result = await options.invoke(build(), timeoutMs);
    if (isExhausted(result)) {
        maxTokens *= 2;
        result = await options.invoke(build(), timeoutMs);
        if (isExhausted(result)) {
            throw new Error(
                `Model "${options.ai.model}" exhausted its reasoning budget: even after ` +
                    `retrying at 2× output tokens (${maxTokens}) it returned nothing usable. ` +
                    "Raise ai.maxTokens in raiken.config.json for reasoning-heavy drafts.",
            );
        }
    }
    return result;
}
