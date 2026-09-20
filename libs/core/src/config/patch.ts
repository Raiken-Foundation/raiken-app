/**
 * CLI/server configuration patch builders. Dashboard clients use the
 * browser-safe adapter in `@raiken/shared/lib/config-patch` instead.
 *
 * All writes still merge through {@link applyConfigPatch} in store.ts.
 */
import { AI_PROVIDER_IDS, type AIProviderId } from "./schema";
import { readRawConfigSync } from "./store";

export type StoredProviderKeys = Partial<Record<AIProviderId, string>>;

export interface AiConfigPatchOptions {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    /** Clear the saved key (falls back to an env var, if one is set). */
    unsetKey?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read remembered provider keys while supporting the original one-key config
 * shape. The active legacy key is folded into the map in memory, so the next
 * provider change upgrades the file without losing a credential.
 */
export function readStoredProviderKeys(config: unknown): StoredProviderKeys {
    if (!isRecord(config) || !isRecord(config["ai"])) return {};
    const ai = config["ai"];
    const keys: StoredProviderKeys = {};
    const apiKeys = ai["apiKeys"];
    if (isRecord(apiKeys)) {
        for (const providerId of AI_PROVIDER_IDS) {
            const key = apiKeys[providerId];
            if (typeof key === "string" && key.trim()) keys[providerId] = key;
        }
    }

    const legacyKey =
        typeof ai["apiKey"] === "string" && ai["apiKey"].trim() ? ai["apiKey"] : undefined;
    const activeProvider =
        typeof ai["provider"] === "string" &&
        (AI_PROVIDER_IDS as readonly string[]).includes(ai["provider"])
            ? (ai["provider"] as AIProviderId)
            : "openrouter";
    if (legacyKey && !keys[activeProvider]) keys[activeProvider] = legacyKey;
    return keys;
}

export function getStoredProviderKeys(projectPath: string): StoredProviderKeys {
    try {
        return readStoredProviderKeys(readRawConfigSync(projectPath));
    } catch {
        return {};
    }
}

export function aiConfigWithRememberedKey(
    ai: Record<string, unknown>,
    providerId: AIProviderId,
    keys: StoredProviderKeys,
): Record<string, unknown> {
    const key = ai["apiKey"];
    if (typeof key !== "string") return ai;
    return {
        ...ai,
        apiKeys: {
            ...keys,
            [providerId]: key,
        },
    };
}

/**
 * Pure patch-builder for CLI flag precedence/validation without touching disk.
 */
export function buildAiConfigPatch(
    options: AiConfigPatchOptions,
): { patch: Record<string, unknown>; clearSecrets?: string[] } | { error: string } {
    if (options.provider) {
        const id = options.provider.trim().toLowerCase();
        if (!(AI_PROVIDER_IDS as readonly string[]).includes(id)) {
            return {
                error:
                    `Unknown provider: "${options.provider}". ` +
                    `Valid providers: ${AI_PROVIDER_IDS.join(", ")}`,
            };
        }
    }

    const patch: Record<string, unknown> = {};
    if (options.provider) patch["provider"] = options.provider.trim().toLowerCase();
    if (options.model) patch["model"] = options.model;
    if (options.baseUrl) patch["baseURL"] = options.baseUrl;
    if (options.unsetKey) {
        // Clear BOTH the legacy active key and the provider-scoped map entry
        // the modern shape stores under — the old patch only cleared
        // ai.apiKey, leaving the live key active after a reported unset
        // (review finding).
        const clearSecrets = ["ai.apiKey"];
        const provider = (patch["provider"] as AIProviderId | undefined) ?? undefined;
        if (provider && (AI_PROVIDER_IDS as readonly string[]).includes(provider)) {
            clearSecrets.push(`ai.apiKeys.${provider}`);
        }
        return { patch, clearSecrets };
    }
    if (options.apiKey) patch["apiKey"] = options.apiKey;

    return { patch };
}
