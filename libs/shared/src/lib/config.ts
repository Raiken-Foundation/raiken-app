import { defaultConfig as coreDefaultConfig, mergeConfig, type RaikenConfig } from "@raiken/core";

export type { RaikenConfig } from "@raiken/core";
export { configExample, defaultConfig, mergeConfig, validateConfig } from "@raiken/core";

/** Fully-resolved discovery config with no optional fields. */
export interface ResolvedDiscoveryConfig {
    maxPages: number;
    maxDepth: number;
    maxConcurrency: number;
    timeout: number;
    excludePatterns: string[];
    pauseOnAuth: boolean;
    maxRunTimeMs: number;
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
        };
    } catch {
        return { ...DISCOVERY_DEFAULTS };
    }
}

/**
 * Read the configured `auth.storageStatePath` from `raiken.config.json`,
 * resolving relative paths against the project root. Returns the absolute
 * path string when set (regardless of whether the file exists), or `null`
 * when no config file is present, the JSON is invalid, or the field is
 * missing/empty.
 *
 * Shared by both the read-side resolver ({@link resolveAuthStorageStatePath})
 * and the write-side resolver ({@link resolveAuthStorageStateDestination})
 * so the path-resolution rules can't drift between "load auth state for a
 * crawl" and "save auth state from a handoff".
 */
function readConfiguredStorageStatePath(projectPath: string): string | null {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsSync = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pathMod = require("node:path") as typeof import("node:path");

    try {
        const configPath = pathMod.join(projectPath, "raiken.config.json");
        const raw = fsSync.readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw) as { auth?: { storageStatePath?: string } };
        const configured = parsed.auth?.storageStatePath;
        if (typeof configured !== "string" || configured.length === 0) return null;
        return pathMod.isAbsolute(configured) ? configured : pathMod.join(projectPath, configured);
    } catch {
        return null;
    }
}

/**
 * Resolve where to LOAD an existing auth storage state from. Used by
 * `raiken discover` and the dashboard to attach storage to a crawl.
 *
 * Resolution order:
 *  1. `auth.storageStatePath` from `raiken.config.json` (if file exists).
 *  2. `.raiken/auth-state.json` (legacy default, if file exists).
 *  3. `null` — no auth state available.
 *
 * Returns `null` if neither path exists on disk so callers can decide
 * whether to crawl unauthenticated or surface an error.
 */
export function resolveAuthStorageStatePath(projectPath: string): string | null {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsSync = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pathMod = require("node:path") as typeof import("node:path");

    const configured = readConfiguredStorageStatePath(projectPath);
    if (configured && fsSync.existsSync(configured)) return configured;

    const fallbackPath = pathMod.join(projectPath, ".raiken", "auth-state.json");
    if (fsSync.existsSync(fallbackPath)) return fallbackPath;

    return null;
}

/**
 * Resolve where to WRITE auth storage state to. Used by `raiken auth`
 * and the dashboard's manual handoff to persist a freshly-captured
 * Playwright storage-state snapshot.
 *
 * Resolution order (intentionally different from the read resolver — the
 * destination doesn't need to already exist):
 *  1. `auth.storageStatePath` from `raiken.config.json` if configured.
 *  2. `.raiken/auth-state.json` as the legacy default.
 *
 * Pre-fix this resolver didn't exist; both `raiken auth` and
 * `runManualHandoff` hardcoded `.raiken/auth-state.json`, ignoring the
 * configured path. The result was a confusing split-brain: the next
 * crawl would load from the configured path (per `resolveAuthStorageStatePath`
 * above) while the handoff had silently written to `.raiken/`,
 * effectively making the configured path read-only.
 *
 * Always returns a non-null path. Caller is responsible for ensuring
 * the parent directory exists before writing.
 */
export function resolveAuthStorageStateDestination(projectPath: string): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pathMod = require("node:path") as typeof import("node:path");

    const configured = readConfiguredStorageStatePath(projectPath);
    if (configured) return configured;

    return pathMod.join(projectPath, ".raiken", "auth-state.json");
}
