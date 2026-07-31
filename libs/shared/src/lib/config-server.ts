/**
 * Server/CLI configuration re-exports from `@raiken/core`.
 *
 * Not re-exported from `@raiken/shared`'s browser entry — import this module
 * (or `@raiken/shared/server`) from Node-only callers.
 */
export type {
    AIProviderId,
    AiConfigPatchOptions,
    PublicRaikenConfig as CorePublicRaikenConfig,
    RaikenConfig as CoreRaikenConfig,
    ResolvedDiscoveryConfig,
} from "@raiken/core";
export {
    AI_PROVIDER_IDS,
    aiConfigWithRememberedKey,
    applyConfigPatch,
    buildAiConfigPatch,
    configExample,
    defaultConfig,
    getStoredProviderKeys,
    loadAuthConfig,
    loadAutonomyConfig,
    loadDiscoveryConfig,
    loadIndexingConfig,
    loadIntegrationsConfig,
    loadTestDirectory,
    mergeConfig,
    readStoredProviderKeys,
    redactConfig,
    resolveAuthStorageStateDestination,
    resolveAuthStorageStatePath,
    validateConfig,
} from "@raiken/core";

import { mergeConfig, type RaikenConfig } from "@raiken/core";

export function createConfig(overrides: Partial<RaikenConfig> = {}): RaikenConfig {
    return mergeConfig(overrides);
}
