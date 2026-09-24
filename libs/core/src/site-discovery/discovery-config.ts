/**
 * Canonical SiteDiscovery option resolution.
 *
 * Single factory for building {@link DiscoveryOptions} and {@link SiteDiscovery}
 * instances from project config plus explicit overrides (CLI flags, tRPC inputs).
 */

import { resolveUsableAuthStorageStatePath } from "../config/auth-state";
import { loadDiscoveryConfig, type ResolvedDiscoveryConfig } from "../config/load";
import { SiteDiscovery } from "./crawler";
import type { DiscoveryLockHandle } from "./project-lock";
import type { DiscoveryOptions } from "./types";

export type { ResolvedDiscoveryConfig };

export interface SiteDiscoveryOverrides {
    maxPages?: number | string | null;
    maxDepth?: number | string | null;
    maxConcurrency?: number | string | null;
    timeout?: number | string | null;
    excludePatterns?: string[];
    pauseOnAuth?: boolean;
    preserveQueryParams?: boolean;
    maxRunTimeMs?: number | string | null;
    settleQuietMs?: number | string | null;
    settleMaxMs?: number | string | null;
    storageStatePath?: string | null;
    skipAuth?: boolean;
    continueSession?: boolean;
    purgeQueueOnResume?: boolean;
}

export interface ResolveSiteDiscoveryOptionsInput {
    projectPath: string;
    startUrl: string;
    overrides?: SiteDiscoveryOverrides;
    /**
     * When resuming via CLI `--continue`, persisted session limits beat explicit
     * overrides (matching legacy `session?.maxPages ?? parseNumber(flag, config)`).
     */
    session?: { maxPages?: number | null; maxDepth?: number | null } | null;
    preferSessionLimits?: boolean;
    /** When true (default), resolve usable auth storage state unless overridden. */
    resolveStorageState?: boolean;
}

function resolvePositiveInt(value: number | string | null | undefined, fallback: number): number {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveNonNegativeInt(
    value: number | string | null | undefined,
    fallback: number,
): number {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveMaxPages(
    config: ResolvedDiscoveryConfig,
    overrides: SiteDiscoveryOverrides,
    session: ResolveSiteDiscoveryOptionsInput["session"],
    preferSessionLimits: boolean,
): number {
    if (preferSessionLimits && session?.maxPages != null) {
        return resolvePositiveInt(session.maxPages, config.maxPages);
    }
    if (overrides.maxPages !== undefined) {
        return resolvePositiveInt(overrides.maxPages, config.maxPages);
    }
    return config.maxPages;
}

function resolveMaxDepth(
    config: ResolvedDiscoveryConfig,
    overrides: SiteDiscoveryOverrides,
    session: ResolveSiteDiscoveryOptionsInput["session"],
    preferSessionLimits: boolean,
): number {
    if (preferSessionLimits && session?.maxDepth != null) {
        return resolvePositiveInt(session.maxDepth, config.maxDepth);
    }
    if (overrides.maxDepth !== undefined) {
        return resolvePositiveInt(overrides.maxDepth, config.maxDepth);
    }
    return config.maxDepth;
}

/**
 * Effective {@link DiscoveryOptions} for a crawl: canonical project config
 * merged with explicit overrides. Override precedence is documented per field
 * in {@link ResolveSiteDiscoveryOptionsInput}.
 */
export function resolveSiteDiscoveryOptions(
    input: ResolveSiteDiscoveryOptionsInput,
): DiscoveryOptions {
    const config = loadDiscoveryConfig(input.projectPath);
    const overrides = input.overrides ?? {};
    const preferSessionLimits = input.preferSessionLimits ?? false;
    const resolveStorageState = input.resolveStorageState ?? true;

    const maxPages = resolveMaxPages(config, overrides, input.session, preferSessionLimits);
    const maxDepth = resolveMaxDepth(config, overrides, input.session, preferSessionLimits);

    const maxConcurrency =
        overrides.maxConcurrency !== undefined
            ? resolvePositiveInt(overrides.maxConcurrency, config.maxConcurrency)
            : config.maxConcurrency;

    const timeout =
        overrides.timeout !== undefined
            ? resolvePositiveInt(overrides.timeout, config.timeout)
            : config.timeout;

    const maxRunTimeMs =
        overrides.maxRunTimeMs !== undefined
            ? resolveNonNegativeInt(overrides.maxRunTimeMs, config.maxRunTimeMs)
            : config.maxRunTimeMs;

    const excludePatterns =
        overrides.excludePatterns !== undefined && overrides.excludePatterns.length > 0
            ? overrides.excludePatterns
            : config.excludePatterns;

    const pauseOnAuth = overrides.skipAuth
        ? false
        : overrides.pauseOnAuth !== undefined
          ? overrides.pauseOnAuth
          : config.pauseOnAuth;

    const preserveQueryParams =
        overrides.preserveQueryParams !== undefined
            ? overrides.preserveQueryParams
            : config.preserveQueryParams;

    const settleQuietMs =
        overrides.settleQuietMs !== undefined
            ? resolveNonNegativeInt(overrides.settleQuietMs, config.settleQuietMs)
            : config.settleQuietMs;
    const settleMaxMs =
        overrides.settleMaxMs !== undefined
            ? resolveNonNegativeInt(overrides.settleMaxMs, config.settleMaxMs)
            : config.settleMaxMs;

    let storageStatePath: string | null = null;
    if (overrides.storageStatePath !== undefined) {
        storageStatePath = overrides.storageStatePath;
    } else if (resolveStorageState) {
        storageStatePath = resolveUsableAuthStorageStatePath(input.projectPath);
    }

    return {
        projectPath: input.projectPath,
        startUrl: input.startUrl,
        maxPages,
        maxDepth,
        maxConcurrency,
        timeout,
        excludePatterns,
        pauseOnAuth,
        preserveQueryParams,
        maxRunTimeMs,
        settleQuietMs,
        settleMaxMs,
        storageStatePath,
        continueSession: overrides.continueSession ?? false,
        purgeQueueOnResume: overrides.purgeQueueOnResume ?? false,
    };
}

/** Build a {@link SiteDiscovery} instance from canonical config plus overrides. */
export function createSiteDiscovery(
    input: ResolveSiteDiscoveryOptionsInput,
    discoveryLock?: DiscoveryLockHandle,
): SiteDiscovery {
    return new SiteDiscovery(resolveSiteDiscoveryOptions(input), discoveryLock);
}
