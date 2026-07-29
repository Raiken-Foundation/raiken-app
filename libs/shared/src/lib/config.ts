import { defaultConfig as coreDefaultConfig, mergeConfig, type RaikenConfig } from "@raiken/core";

export type { RaikenConfig } from "@raiken/core";
export {
    configExample,
    defaultConfig,
    mergeConfig,
    resolveAuthStorageStateDestination,
    resolveAuthStorageStatePath,
    validateConfig,
} from "@raiken/core";

/** Fully-resolved discovery config with no optional fields. */
export interface ResolvedDiscoveryConfig {
    maxPages: number;
    maxDepth: number;
    maxConcurrency: number;
    timeout: number;
    excludePatterns: string[];
    pauseOnAuth: boolean;
    maxRunTimeMs: number;
    preserveQueryParams: boolean;
}

const DISCOVERY_DEFAULTS: ResolvedDiscoveryConfig =
    coreDefaultConfig.discovery as ResolvedDiscoveryConfig;

export function createConfig(overrides: Partial<RaikenConfig> = {}): RaikenConfig {
    return mergeConfig(overrides);
}

/**
 * Read and validate discovery config from raiken.config.json.
 * Falls back to defaults for any missing or invalid values.
 */
export function loadDiscoveryConfig(projectPath: string): ResolvedDiscoveryConfig {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsSync = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pathMod = require("node:path") as typeof import("node:path");

    const configPath = pathMod.join(projectPath, "raiken.config.json");

    try {
        const raw = fsSync.readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw) as { discovery?: Partial<ResolvedDiscoveryConfig> };
        const d = parsed.discovery ?? {};

        return {
            maxPages:
                typeof d.maxPages === "number" && d.maxPages > 0
                    ? d.maxPages
                    : DISCOVERY_DEFAULTS.maxPages,
            maxDepth:
                typeof d.maxDepth === "number" && d.maxDepth > 0
                    ? d.maxDepth
                    : DISCOVERY_DEFAULTS.maxDepth,
            maxConcurrency:
                typeof d.maxConcurrency === "number" && d.maxConcurrency > 0
                    ? d.maxConcurrency
                    : DISCOVERY_DEFAULTS.maxConcurrency,
            timeout:
                typeof d.timeout === "number" && d.timeout > 0
                    ? d.timeout
                    : DISCOVERY_DEFAULTS.timeout,
            excludePatterns: Array.isArray(d.excludePatterns)
                ? d.excludePatterns
                : DISCOVERY_DEFAULTS.excludePatterns,
            pauseOnAuth:
                typeof d.pauseOnAuth === "boolean" ? d.pauseOnAuth : DISCOVERY_DEFAULTS.pauseOnAuth,
            maxRunTimeMs:
                typeof d.maxRunTimeMs === "number" && d.maxRunTimeMs >= 0
                    ? d.maxRunTimeMs
                    : DISCOVERY_DEFAULTS.maxRunTimeMs,
            preserveQueryParams:
                typeof d.preserveQueryParams === "boolean"
                    ? d.preserveQueryParams
                    : DISCOVERY_DEFAULTS.preserveQueryParams,
        };
    } catch {
        return { ...DISCOVERY_DEFAULTS };
    }
}
