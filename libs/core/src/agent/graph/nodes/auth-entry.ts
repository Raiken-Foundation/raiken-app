import { resolveUsableAuthStorageStatePath } from "../../../config/auth-state";
import { loadSiteKnowledge } from "../../../site-discovery/knowledge-loader";
import { AgentMemory } from "../../memory";

/**
 * Smart authenticated entry for SSO / login-walled apps.
 *
 * Many apps make their ORIGIN ROOT ("/") a marketing/login page that redirects
 * to an identity provider — even for an already-authenticated session. Deep
 * routes (e.g. "/overview") instead complete SSO silently and render the app.
 * If the agent always enters at the bare origin it captures the login page,
 * trips the auth interruption, and never reaches the real app.
 *
 * Crucially this is DISCOVERY-DRIVEN: the real app origin and candidate routes
 * come from discovered pages, NOT from `project_base_url` — that value gets
 * poisoned when a login redirect lands the browser on the identity provider's
 * origin (e.g. accounts.example.com), which would otherwise send every future
 * run straight to the login wall.
 */

/** Memory key for the last route where we captured real, unblocked app DOM. */
const REMEMBERED_ENTRY_KEY = "authenticated_entry_url";

/** Paths that are themselves auth/landing routes — never good content entries. */
const AUTH_PATH =
    /(login|log-in|signin|sign-in|sign_in|signup|sign-up|sign_up|register|auth|sso|oauth|callback|forgot|reset|welcome|get-?started|realms)/i;

/** Hostnames that belong to an identity provider, not the app under test. */
const AUTH_HOST =
    /^(accounts?|auth|login|signin|sso|idp?|oauth|identity|keycloak|okta|auth0|login\w*)\./i;

/** True when a hostname looks like an identity provider rather than the app. */
export function isAuthHost(hostname: string): boolean {
    return AUTH_HOST.test(hostname) || /(^|\.)(okta|auth0)\.com$/i.test(hostname);
}

/**
 * True when a reusable Playwright storage state exists for the project — the
 * signal that we have a session to reuse and that login walls are recoverable.
 */
export function hasAuthSession(projectPath: string): boolean {
    try {
        return resolveUsableAuthStorageStatePath(projectPath) !== null;
    } catch {
        return false;
    }
}

/**
 * A URL usable as an authenticated entry point: not an identity-provider host,
 * not the bare root, and not an auth/landing route. When `appOrigin` is given,
 * the URL must also match it (so we don't cross into another origin).
 */
function isContentRoute(url: string, appOrigin: string | null): boolean {
    try {
        const u = new URL(url);
        // about:blank / data: / file: parse fine but are not app pages —
        // remembering one as the "authenticated entry" would poison every
        // future run with a URL that can never render the app.
        if (u.protocol !== "http:" && u.protocol !== "https:") return false;
        if (isAuthHost(u.hostname)) return false;
        if (appOrigin && u.origin !== appOrigin) return false;
        const p = u.pathname.replace(/\/+$/, "");
        if (p === "") return false;
        if (AUTH_PATH.test(p)) return false;
        return true;
    } catch {
        return false;
    }
}

/** True when a URL is the bare origin, an auth path, or an identity-provider host. */
function needsAuthedEntryUpgrade(url: string): boolean {
    try {
        const u = new URL(url);
        if (isAuthHost(u.hostname)) return true;
        const p = u.pathname.replace(/\/+$/, "");
        return p === "" || AUTH_PATH.test(p);
    } catch {
        return false;
    }
}

function getRememberedEntry(projectPath: string): string | null {
    try {
        return AgentMemory.getInstance(projectPath).getPreference(REMEMBERED_ENTRY_KEY) || null;
    } catch {
        return null;
    }
}

/**
 * Remember a route where we captured real, unblocked app DOM so future runs can
 * enter there directly instead of bouncing off the origin's login wall.
 */
export function rememberAuthedEntry(projectPath: string, url: string | null | undefined): void {
    if (!url || !isContentRoute(url, null)) return;
    try {
        AgentMemory.getInstance(projectPath).setPreference(REMEMBERED_ENTRY_KEY, url);
    } catch {
        /* memory unavailable — non-critical */
    }
}

/**
 * The app's real origin, inferred from discovered routes: the most common
 * non-identity-provider origin. Robust against a `project_base_url` that a login
 * redirect poisoned with the IdP's origin.
 */
function inferAppOrigin(routes: Array<{ url: string }>): string | null {
    const counts = new Map<string, number>();
    for (const r of routes) {
        try {
            const u = new URL(r.url);
            if (isAuthHost(u.hostname)) continue;
            counts.set(u.origin, (counts.get(u.origin) ?? 0) + 1);
        } catch {
            /* skip unparseable */
        }
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [origin, count] of counts) {
        if (count > bestCount) {
            best = origin;
            bestCount = count;
        }
    }
    return best;
}

/**
 * Ordered candidate protected routes to try when the origin root is a login
 * wall: the remembered entry first, then discovered content routes (shallowest
 * first, so dashboard-like landing pages win over deep detail pages). Purely
 * discovery-driven so a poisoned base URL can't hide the real app routes.
 */
export async function getCandidateAuthedRoutes(projectPath: string): Promise<string[]> {
    let routes: Array<{ url: string; depth?: number }> = [];
    try {
        const knowledge = await loadSiteKnowledge(projectPath);
        routes = knowledge?.routes ?? [];
    } catch {
        routes = [];
    }

    const appOrigin = inferAppOrigin(routes);
    const candidates: string[] = [];

    const remembered = getRememberedEntry(projectPath);
    if (remembered && isContentRoute(remembered, appOrigin)) candidates.push(remembered);

    const sorted = [...routes].sort((a, b) => (a.depth ?? 99) - (b.depth ?? 99));
    for (const r of sorted) {
        if (isContentRoute(r.url, appOrigin)) candidates.push(r.url);
    }

    return [...new Set(candidates)];
}

/**
 * The app's real origin (e.g. "http://localhost:5500"), inferred from discovered
 * routes rather than `project_base_url` — which a login redirect can poison with
 * the identity provider's origin. Used to resolve relative navigation targets
 * (like "/" or "/overview") to a valid absolute URL that points at the app, not
 * the login wall. Returns null when nothing has been discovered yet.
 */
export async function getAppOrigin(projectPath: string): Promise<string | null> {
    try {
        const knowledge = await loadSiteKnowledge(projectPath);
        return inferAppOrigin(knowledge?.routes ?? []);
    } catch {
        return null;
    }
}

/**
 * Pick the URL to enter the app at. Respects an explicit user-supplied URL; only
 * upgrades a bare-origin / auth / identity-provider entry to a known content
 * route when a reusable session exists and candidates are known.
 */
export async function resolveEntryUrl(
    projectPath: string,
    url: string,
    hasExplicitTarget: boolean,
): Promise<string> {
    if (hasExplicitTarget) return url;
    if (!hasAuthSession(projectPath)) return url;
    if (!needsAuthedEntryUpgrade(url)) return url;

    const candidates = await getCandidateAuthedRoutes(projectPath);
    return candidates[0] ?? url;
}
