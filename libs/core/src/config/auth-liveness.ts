/**
 * Live probe for "storageState looks valid but the app still bounces to login."
 *
 * {@link inspectAuthState} can only prove cookie expiry from the file. Session
 * cookies and localStorage-only states always read as valid — this module opens
 * a short browser session and checks whether a protected URL still lands on a
 * login page.
 */

import { AgentMemory } from "../agent/memory";
import { BrowserSession } from "../browser/session";
import { looksLikeLoginUrl } from "../site-discovery/detectors/auth";
import { DiscoveryQueryService } from "../site-discovery/query-service";
import { readPlaywrightBaseURL, readPlaywrightWebServerUrl } from "../testing/playwright-config";
import {
    type AuthStateInspection,
    inspectAuthState,
    resolveAuthStorageStatePath,
} from "./auth-state";

const CACHE_KEY = "auth_liveness";
/** Re-use a fresh live verdict for this long before probing again. */
export const AUTH_LIVENESS_TTL_MS = 15 * 60 * 1000;

export type AuthLivenessStatus =
    | "no_state"
    | "file_unusable"
    | "live"
    | "stale"
    | "probe_failed"
    | "skipped_no_url";

export interface AuthLivenessResult {
    status: AuthLivenessStatus;
    /** Absolute path of the storage state when one exists. */
    statePath: string | null;
    /** URL that was (or would be) probed. */
    probeUrl: string | null;
    /** Final URL after navigation, when a live probe ran. */
    landedUrl?: string;
    /** File inspection when the state exists. */
    inspection?: AuthStateInspection;
    /** True when the verdict came from AgentMemory cache. */
    fromCache?: boolean;
    message: string;
}

interface CachedVerdict {
    status: "live" | "stale";
    statePath: string;
    probeUrl: string;
    landedUrl?: string;
    probedAt: number;
}

export interface ProbeAuthStateOptions {
    projectPath: string;
    /** Override probe target (defaults to auth-required route or seed URL). */
    url?: string;
    /** Force a live probe even when a fresh cache hit exists. */
    force?: boolean;
    headed?: boolean;
    /**
     * Injectable navigation for tests. Receives absolute URL + storage path;
     * returns the landing URL after navigation (or throws).
     */
    navigate?: (url: string, storageStatePath: string) => Promise<string>;
}

function readCache(projectPath: string, statePath: string): CachedVerdict | null {
    try {
        const raw = AgentMemory.getInstance(projectPath).getPreference(CACHE_KEY);
        if (!raw?.trim()) return null;
        const parsed = JSON.parse(raw) as CachedVerdict;
        if (
            !parsed ||
            (parsed.status !== "live" && parsed.status !== "stale") ||
            parsed.statePath !== statePath ||
            typeof parsed.probedAt !== "number"
        ) {
            return null;
        }
        if (Date.now() - parsed.probedAt > AUTH_LIVENESS_TTL_MS) return null;
        return parsed;
    } catch {
        return null;
    }
}

function writeCache(projectPath: string, verdict: CachedVerdict): void {
    try {
        AgentMemory.getInstance(projectPath).setPreference(CACHE_KEY, JSON.stringify(verdict));
    } catch {
        // Cache is best-effort.
    }
}

/** Clear the liveness cache (e.g. after `raiken auth` refreshes state). */
export function clearAuthLivenessCache(projectPath: string): void {
    try {
        AgentMemory.getInstance(projectPath).setPreference(CACHE_KEY, "");
    } catch {
        /* ignore */
    }
}

/**
 * Pick a URL that should stay authenticated if storageState is live:
 * first unresolved auth_required blocker URL, else Playwright baseURL / seed.
 */
export async function resolveAuthProbeUrl(projectPath: string): Promise<string | null> {
    try {
        const discovery = new DiscoveryQueryService(projectPath);
        try {
            const blockers = discovery.getUnresolvedBlockers();
            const authUrl = blockers.find((b) => b.category === "auth_required")?.url;
            if (authUrl) return authUrl;
            const { pages } = discovery.listPages({ limit: 50 });
            const nonLogin = pages.find((p) => !looksLikeLoginUrl(p.url));
            if (nonLogin?.url) return nonLogin.url;
        } finally {
            discovery.close();
        }
    } catch {
        /* fall through */
    }
    return (
        (await readPlaywrightBaseURL(projectPath).catch(() => null)) ??
        (await readPlaywrightWebServerUrl(projectPath).catch(() => null))
    );
}

function landingLooksLikeLogin(landedUrl: string, title?: string): boolean {
    if (looksLikeLoginUrl(landedUrl)) return true;
    if (title && /\b(sign[\s-]?in|log[\s-]?in|authenticate)\b/i.test(title)) return true;
    return false;
}

async function defaultNavigate(
    projectPath: string,
    url: string,
    storageStatePath: string,
    headed?: boolean,
): Promise<{ landedUrl: string; title: string }> {
    const session = BrowserSession.getInstance(projectPath);
    try {
        await session.start({
            headless: headed !== true,
            storageStatePath,
        });
        const dom = await session.navigate(url);
        return { landedUrl: dom.url, title: dom.title };
    } finally {
        await session.close().catch(() => undefined);
    }
}

/**
 * Probe whether the project's storageState still authenticates against the app.
 * Soft for cover (returns a result); callers decide whether to refuse or warn.
 */
export async function probeAuthState(options: ProbeAuthStateOptions): Promise<AuthLivenessResult> {
    const { projectPath } = options;
    const statePath = resolveAuthStorageStatePath(projectPath);
    if (!statePath) {
        return {
            status: "no_state",
            statePath: null,
            probeUrl: null,
            message: "No Playwright storageState on disk.",
        };
    }

    const inspection = inspectAuthState(statePath);
    if (inspection.status !== "valid") {
        return {
            status: "file_unusable",
            statePath,
            probeUrl: null,
            inspection,
            message:
                inspection.status === "expired"
                    ? `storageState cookies have expired — run \`raiken auth\` to refresh.`
                    : `storageState is ${inspection.status} — run \`raiken auth\` to capture a session.`,
        };
    }

    const probeUrl = options.url ?? (await resolveAuthProbeUrl(projectPath));
    if (!probeUrl) {
        return {
            status: "skipped_no_url",
            statePath,
            probeUrl: null,
            inspection,
            message: "storageState looks valid on disk; no URL available to live-probe.",
        };
    }

    if (!options.force) {
        const cached = readCache(projectPath, statePath);
        if (cached) {
            return {
                status: cached.status,
                statePath,
                probeUrl: cached.probeUrl,
                landedUrl: cached.landedUrl,
                inspection,
                fromCache: true,
                message:
                    cached.status === "live"
                        ? "storageState still authenticates (cached)."
                        : `storageState looks valid but the app still showed a login page at ${cached.landedUrl ?? cached.probeUrl} — run \`raiken auth\`.`,
            };
        }
    }

    try {
        let landedUrl: string;
        let title = "";
        if (options.navigate) {
            landedUrl = await options.navigate(probeUrl, statePath);
        } else {
            const result = await defaultNavigate(projectPath, probeUrl, statePath, options.headed);
            landedUrl = result.landedUrl;
            title = result.title;
        }

        const stale = landingLooksLikeLogin(landedUrl, title);
        const status: "live" | "stale" = stale ? "stale" : "live";
        writeCache(projectPath, {
            status,
            statePath,
            probeUrl,
            landedUrl,
            probedAt: Date.now(),
        });

        return {
            status,
            statePath,
            probeUrl,
            landedUrl,
            inspection,
            message: stale
                ? `storageState looks valid but landed on login at ${landedUrl} — run \`raiken auth\` to refresh.`
                : `storageState authenticated against ${landedUrl}.`,
        };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
            status: "probe_failed",
            statePath,
            probeUrl,
            inspection,
            message: `Could not live-probe storageState at ${probeUrl}: ${detail}`,
        };
    }
}

/** True when cover / repair should treat auth as unusable. */
export function authLivenessBlocks(result: AuthLivenessResult): boolean {
    return result.status === "stale" || result.status === "file_unusable";
}
