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

import * as fs from "node:fs";
import * as path from "node:path";
import type { LanguageModel } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
    AI_PROVIDER_IDS,
    type AIProviderId,
    raikenConfigSchema,
} from "../config/schema";

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
    },
    openai: {
        id: "openai",
        label: "OpenAI",
        description: "Direct access to GPT-4o, o1, o3-mini, etc.",
        defaultBaseURL: "https://api.openai.com/v1",
        defaultModel: "gpt-4o",
        envVars: ["OPENAI_API_KEY"],
        publicCatalog: false,
        apiKeyUrl: "https://platform.openai.com/api-keys",
        apiKeyPlaceholder: "sk-…",
    },
    anthropic: {
        id: "anthropic",
        label: "Anthropic",
        description: "Direct access to Claude (Sonnet, Opus, Haiku).",
        defaultBaseURL: "https://api.anthropic.com/v1",
        defaultModel: "claude-sonnet-4-5",
        envVars: ["ANTHROPIC_API_KEY"],
        publicCatalog: false,
        apiKeyUrl: "https://console.anthropic.com/settings/keys",
        apiKeyPlaceholder: "sk-ant-…",
    },
    google: {
        id: "google",
        label: "Google AI Studio",
        description: "Gemini 2.5 / 2.0 family via Google's Generative AI API.",
        defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
        defaultModel: "gemini-2.0-flash",
        envVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
        publicCatalog: false,
        apiKeyUrl: "https://aistudio.google.com/app/apikey",
        apiKeyPlaceholder: "AIza…",
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
    },
    deepseek: {
        id: "deepseek",
        label: "DeepSeek",
        description: "DeepSeek V3, R1 reasoning models.",
        defaultBaseURL: "https://api.deepseek.com/v1",
        defaultModel: "deepseek-chat",
        envVars: ["DEEPSEEK_API_KEY"],
        publicCatalog: false,
        apiKeyUrl: "https://platform.deepseek.com/api_keys",
        apiKeyPlaceholder: "sk-…",
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
    },
};

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
 * Falls back to a generic AI_API_KEY if nothing else matches.
 */
export function readApiKeyFromEnv(provider: AIProviderId): string | undefined {
    const def = AI_PROVIDERS[provider];
    for (const name of def.envVars) {
        const value = process.env[name];
        if (value && value.trim()) return value;
    }
    const generic = process.env["AI_API_KEY"];
    return generic && generic.trim() ? generic : undefined;
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
 *   3. Environment variables (override config keys; never overrides model)
 *   4. Programmatic `override`
 */
export function resolveAIConfig(
    projectPath: string,
    override?: AIConfigOverride,
): ResolvedAIConfig {
    let configFromFile: {
        provider?: string;
        apiKey?: string;
        model?: string;
        baseURL?: string;
        maxTokens?: number;
        temperature?: number;
    } = {};

    const configPath = path.join(projectPath, "raiken.config.json");
    if (fs.existsSync(configPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            const result = raikenConfigSchema.safeParse(raw);
            if (result.success && result.data.ai) {
                configFromFile = result.data.ai as typeof configFromFile;
            }
        } catch {
            // ignored — keep defaults
        }
    }

    const providerId = (override?.provider ??
        configFromFile.provider ??
        "openrouter") as string;
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
    } else if (configFromFile.apiKey) {
        apiKey = configFromFile.apiKey;
        apiKeySource = "config";
    }

    return {
        provider: provider.id,
        apiKey,
        apiKeySource,
        apiKeyEnvVar,
        model: override?.model ?? configFromFile.model ?? provider.defaultModel,
        baseURL:
            override?.baseURL ?? configFromFile.baseURL ?? provider.defaultBaseURL,
        maxTokens: override?.maxTokens ?? configFromFile.maxTokens ?? 4000,
        temperature: override?.temperature ?? configFromFile.temperature ?? 0.7,
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
        switch (provider.id) {
            case "openrouter":
                return await fetchOpenRouterModels(baseURL);
            case "anthropic":
                return await fetchAnthropicModels(baseURL, apiKey);
            case "google":
                return await fetchGoogleModels(baseURL, apiKey);
            case "ollama":
                return await fetchOllamaModels(baseURL);
            default:
                return await fetchOpenAICompatibleModels(baseURL, apiKey);
        }
    } catch (err) {
        return {
            models: [],
            error: err instanceof Error ? err.message : String(err),
        };
    }
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
        .filter((m) =>
            (m.supportedGenerationMethods ?? []).includes("generateContent"),
        )
        .map((m) => {
            const id = m.name.replace(/^models\//, "");
            return {
                id,
                name: m.displayName || id,
                context: m.inputTokenLimit,
                description: m.description,
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
    }));
    return { models };
}

// ---------------------------------------------------------------------------
// Runtime client factory
// ---------------------------------------------------------------------------

/**
 * Returns an AI SDK chat-capable model handle for the resolved config.
 *
 * For now we route every provider through the OpenRouter/OpenAI-compatible
 * client by pointing it at the provider's own base URL. This works because
 * every provider in {@link AI_PROVIDERS} (with the exception of Anthropic and
 * Google) speaks the OpenAI chat completions wire format. For Anthropic and
 * Google we still recommend OpenRouter; users wanting native SDK clients can
 * select "openrouter" and pick the same model.
 */
export interface AIClient {
    provider: AIProviderId;
    model: LanguageModel;
}

export function createAIClient(resolved: ResolvedAIConfig): AIClient {
    const client = createOpenRouter({
        apiKey: resolved.apiKey ?? "",
        baseURL: resolved.baseURL,
    });
    return {
        provider: resolved.provider,
        model: client.chat(resolved.model) as unknown as LanguageModel,
    };
}
