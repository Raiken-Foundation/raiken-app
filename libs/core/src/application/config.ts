import {
    listProviderModels,
    listProviders,
    type ResolvedAIConfig,
    readApiKeyFromEnv,
    resolveAIConfig,
} from "../agent/ai-providers";
import {
    applyConfigPatch,
    getStoredProviderKeys,
    loadAIConfigSection,
    raikenConfigSchema,
    readPublicConfig,
    readRawConfig,
    writeConfigAtomic,
} from "../config";
import type { AIProviderId } from "../config/schema";
import type { ProjectApplicationContext } from "./context";

function readSavedProviderKeys(projectPath: string): {
    keys: Record<string, string>;
    activeProvider?: string;
    legacyKey?: string;
} {
    const ai = loadAIConfigSection(projectPath);
    return {
        keys: getStoredProviderKeys(projectPath),
        activeProvider: ai.provider,
        legacyKey: ai.apiKey,
    };
}

/** Project-scoped configuration reads and validated public patches. */
export class ConfigApplication implements ProjectApplicationContext {
    readonly projectPath: string;

    constructor(projectPath: string) {
        this.projectPath = projectPath;
    }

    getPublicConfig() {
        return readPublicConfig(this.projectPath);
    }

    async updateConfig(input: {
        config: Record<string, unknown>;
        clearSecrets?: string[];
    }): Promise<{ success: boolean; errors?: string[] }> {
        let existing: Record<string, unknown> = {};
        try {
            existing = await readRawConfig(this.projectPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                return {
                    success: false,
                    errors: ["Unable to read the existing raiken.config.json safely."],
                };
            }
        }

        const merged = applyConfigPatch(existing, input.config, input.clearSecrets);
        const validation = raikenConfigSchema.safeParse(merged);
        if (!validation.success) {
            return {
                success: false,
                errors: validation.error.issues.map(
                    (i) => `${i.path.join(".") || "config"}: ${i.message}`,
                ),
            };
        }

        await writeConfigAtomic(this.projectPath, validation.data);
        return { success: true };
    }

    listAIProviders() {
        const resolved = resolveAIConfig(this.projectPath);
        const saved = readSavedProviderKeys(this.projectPath);
        return {
            providers: listProviders().map((p) => {
                const envKey = readApiKeyFromEnv(p.id);
                const legacyKeyMatchesProvider =
                    saved.legacyKey &&
                    (saved.activeProvider === p.id ||
                        (!saved.activeProvider && p.id === "openrouter"));
                const hasProjectKey = Boolean(saved.keys[p.id] || legacyKeyMatchesProvider);
                const keySource =
                    p.envVars.length === 0
                        ? "not-required"
                        : envKey
                          ? "environment"
                          : hasProjectKey
                            ? "project"
                            : "missing";
                return {
                    id: p.id,
                    label: p.label,
                    description: p.description,
                    defaultModel: p.defaultModel,
                    defaultBaseURL: p.defaultBaseURL,
                    envVars: p.envVars,
                    publicCatalog: p.publicCatalog,
                    apiKeyUrl: p.apiKeyUrl,
                    apiKeyPlaceholder: p.apiKeyPlaceholder,
                    recommendedModels: p.recommendedModels,
                    keySource,
                    keyEnvVar: envKey ? p.envVars[0] : null,
                    hasKey: keySource !== "missing",
                };
            }),
            current: {
                provider: resolved.provider,
                model: resolved.model,
                baseURL: resolved.baseURL,
                hasKey: resolved.apiKeySource !== "none",
                apiKeySource: resolved.apiKeySource,
                apiKeyEnvVar: resolved.apiKeyEnvVar ?? null,
            },
        };
    }

    async fetchAIModels(input: { provider: AIProviderId; baseURL?: string; draftApiKey?: string }) {
        const resolved = resolveAIConfig(this.projectPath, {
            provider: input.provider,
            baseURL: input.baseURL,
            apiKey: input.draftApiKey,
        });
        const result = await listProviderModels({
            provider: input.provider,
            apiKey: resolved.apiKey,
            baseURL: resolved.baseURL,
        });
        return {
            provider: input.provider,
            models: result.models,
            error: result.error ?? null,
            count: result.models.length,
        };
    }

    resolveAI(): ResolvedAIConfig {
        return resolveAIConfig(this.projectPath);
    }
}
