/**
 * Config loading helpers that read `raiken.config.json` off disk.
 *
 * `schema.ts` stays pure (zod definitions + in-memory defaults/merging) so it
 * has no I/O and is trivial to unit test; this file is the one place that
 * actually touches the filesystem for the sections that need a "give me the
 * resolved value right now" helper.
 */
import type { z } from "zod";
import {
    type AIConfig,
    type AuthConfig,
    type AutonomyConfig,
    aiConfigSchema,
    authConfigSchema,
    autonomyConfigSchema,
    type BrowserConfig,
    browserConfigSchema,
    type DiscoveryConfig,
    defaultConfig,
    discoveryConfigSchema,
    type IndexingConfig,
    type IntegrationsConfig,
    indexingConfigSchema,
    integrationsConfigSchema,
    type QuarantineConfig,
    quarantineConfigSchema,
} from "./schema";
import { readRawConfigSync } from "./store";

/** Fully-resolved discovery config with no optional fields. */
export type ResolvedDiscoveryConfig = Required<DiscoveryConfig>;
export type ResolvedAutonomyConfig = Required<AutonomyConfig>;
export type ResolvedIndexingConfig = Required<IndexingConfig>;
export type ResolvedBrowserConfig = Required<BrowserConfig>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a raw config section field-by-field so one invalid key does not
 * discard the rest of the section.
 */
export function parseSectionPartial<S extends z.ZodObject<z.ZodRawShape>>(
    schema: S,
    raw: unknown,
): Partial<z.infer<S>> {
    if (!isRecord(raw)) {
        return {};
    }

    const result: Partial<z.infer<S>> = {};
    for (const [key, fieldSchema] of Object.entries(schema.shape)) {
        if (!(key in raw)) {
            continue;
        }
        const parsed = (fieldSchema as z.ZodTypeAny).safeParse(raw[key]);
        if (parsed.success) {
            (result as Record<string, unknown>)[key] = parsed.data;
        }
    }
    return result;
}

/** @deprecated Prefer {@link parseSectionPartial} with `discoveryConfigSchema`. */
export function parseDiscoverySectionPartial(raw: unknown): Partial<DiscoveryConfig> {
    return parseSectionPartial(discoveryConfigSchema, raw);
}

function readConfigSection<S extends z.ZodObject<z.ZodRawShape>>(
    projectPath: string,
    sectionKey: string,
    schema: S,
): Partial<z.infer<S>> {
    try {
        const raw = readRawConfigSync(projectPath);
        return parseSectionPartial(schema, isRecord(raw) ? raw[sectionKey] : undefined);
    } catch {
        return {};
    }
}

/**
 * Merge a partial discovery section with canonical defaults.
 */
export function resolveDiscoveryConfig(
    onDisk: Partial<DiscoveryConfig> = {},
): ResolvedDiscoveryConfig {
    return { ...defaultConfig.discovery, ...onDisk };
}

export function loadAuthConfig(projectPath: string): AuthConfig {
    return readConfigSection(projectPath, "auth", authConfigSchema);
}

/**
 * Resolve the `browser` section of `raiken.config.json`, merged with defaults.
 */
export function loadBrowserConfig(projectPath: string): ResolvedBrowserConfig {
    const onDisk = readConfigSection(projectPath, "browser", browserConfigSchema);
    return { ...defaultConfig.browser, ...onDisk };
}

/**
 * Resolve the `autonomy` section of `raiken.config.json`, merged with
 * defaults, and optionally with a session-scoped override on top (e.g. the
 * CLI REPL's `/mode` command reflecting the *current* run's autonomy without
 * permanently rewriting the project's shared config file).
 */
export function loadAutonomyConfig(
    projectPath: string,
    override?: Partial<AutonomyConfig>,
): ResolvedAutonomyConfig {
    const onDisk = readConfigSection(projectPath, "autonomy", autonomyConfigSchema);
    return { ...defaultConfig.autonomy, ...onDisk, ...override };
}

/**
 * Resolve the `discovery` section of `raiken.config.json` via the canonical
 * discovery schema and defaults. Unrelated invalid config sections are
 * ignored; invalid discovery fields fall back to defaults individually.
 */
export function loadDiscoveryConfig(projectPath: string): ResolvedDiscoveryConfig {
    try {
        const raw = readRawConfigSync(projectPath);
        const onDisk = parseDiscoverySectionPartial(isRecord(raw) ? raw["discovery"] : undefined);
        return resolveDiscoveryConfig(onDisk);
    } catch {
        return { ...defaultConfig.discovery };
    }
}

export function loadIndexingConfig(projectPath: string): ResolvedIndexingConfig {
    const onDisk = readConfigSection(projectPath, "indexing", indexingConfigSchema);
    return { ...defaultConfig.indexing, ...onDisk };
}

export function loadIntegrationsConfig(projectPath: string): IntegrationsConfig {
    return readConfigSection(projectPath, "integrations", integrationsConfigSchema);
}

/**
 * Resolve the flaky-test quarantine list. Empty when the section or config
 * is absent — quarantine is strictly opt-in.
 */
export function loadQuarantineConfig(projectPath: string): Required<QuarantineConfig> {
    const onDisk = readConfigSection(projectPath, "quarantine", quarantineConfigSchema);
    return { testFiles: onDisk.testFiles ?? [] };
}

/** Field-tolerant read of the `ai` section without validating unrelated sections. */
export function loadAIConfigSection(projectPath: string): AIConfig {
    return readConfigSection(projectPath, "ai", aiConfigSchema);
}

/**
 * Resolve the project's configured test directory, falling back to the
 * canonical default when the config is missing, invalid, or empty.
 */
export function loadTestDirectory(projectPath: string): string {
    try {
        const raw = readRawConfigSync(projectPath);
        const testDirectory = isRecord(raw) ? raw["testDirectory"] : undefined;
        if (typeof testDirectory === "string" && testDirectory.trim()) {
            return testDirectory.trim();
        }
    } catch {
        // Config missing or invalid — fall back to defaults below.
    }
    return defaultConfig.testDirectory;
}
