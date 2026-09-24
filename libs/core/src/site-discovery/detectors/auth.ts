/**
 * Auth detector.
 *
 * Recognises six auth-required signals, in priority order:
 *
 *   1. **HTTP 401/403** — server explicitly says "auth required".
 *   2. **Login redirect chain** — request to non-login URL was redirected
 *      via 30x to a login-shaped URL (NextAuth middleware, Rails Devise,
 *      Spring Security, ...). Detected from Playwright's request chain so
 *      it fires even if the login page itself never hydrates a form.
 *   3. **Login form rendered** — `<input type="password">` + submit-shaped
 *      element on the page.
 *   4. **OAuth-only landing pages** — "Sign in with Google" etc., but only
 *      when paired with a login-shaped URL.
 *   5. **Explicit auth error copy** — "please log in", "unauthorized", ...
 *
 * URL patterns are deliberately not a standalone signal: routes like
 * `/account/settings`, `/auth/callback`, or `/sso/landing` legitimately
 * appear on authenticated apps. A blocker is only emitted when there is
 * concrete evidence the page is gating on auth.
 */

import type { Page, Request, Response } from "playwright";

import type { AuthBlocker, AuthBlockerType, DiscoveryBlocker } from "../types";
import { type BlockerDetector, type BlockerDetectorContext, buildBlocker } from "./types";
import { getVisibleText } from "./util";

/**
 * Login-shaped URL patterns. Single source of truth — the interactive
 * auth handoff module and the CLI auth command both import
 * {@link looksLikeLoginUrl} below (and exported {@link LOGIN_URL_PATTERNS}
 * where they need the raw set).
 *
 * Coverage rationale:
 *  - Hyphen, underscore, and bare variants for English ("sign-in", "sign_in",
 *    "signin"). Devise / Rails apps overwhelmingly use `/users/sign_in`,
 *    Clerk uses `/sign-in`, NextAuth uses `/auth/signin`.
 *  - `/sso/...` for enterprise federated-login landing pages (Okta, Auth0
 *    universal login, Azure AD).
 *  - `/account/...` for some BCP shells that route the credentials form
 *    under an account namespace.
 *  - `/oauth/...` for protocol entry points (the *authorize* leg, not
 *    the callback — those are excluded below).
 *
 * Anchored to a leading slash so query strings or hostname segments that
 * incidentally contain "login" don't match.
 */
export const LOGIN_URL_PATTERNS: readonly RegExp[] = [
    /\/login(?:\/|$)/i,
    /\/signin(?:\/|$)/i,
    /\/sign-in(?:\/|$)/i,
    /\/sign_in(?:\/|$)/i,
    /\/log-in(?:\/|$)/i,
    /\/log_in(?:\/|$)/i,
    /\/authenticate(?:\/|$)/i,
    // Only the terminal `/auth` (or `/auth/`) — NOT every `/auth/*` route.
    // Apps commonly use `/auth` as a namespace for non-login pages; login
    // leaves like `/auth/login` and `/auth/signin` are still matched by the
    // `/login` and `/signin` patterns above. This kills the biggest source of
    // `/auth/*` false positives.
    /\/auth\/?$/i,
    /\/sso(?:\/|$)/i,
    /\/account\/(?:login|signin|sign-in|sign_in)(?:\/|$)/i,
    /\/oauth(?:\/|$)/i,
];

/**
 * Paths that *look* login-shaped via {@link LOGIN_URL_PATTERNS} but are
 * actually success/completion legs of an auth dance — pausing the crawl
 * on them produces a confusing false positive.
 *
 *  - `/auth/callback?code=…` is the OAuth/OIDC redirect-back handler.
 *    The user is *done* logging in by this point; the page just exchanges
 *    the code for a session and bounces. Treating it as a login wall
 *    interrupts a successful flow.
 *  - `/auth/verify`, `/auth/verify-request` are magic-link landing pages
 *    AFTER the user clicked the email — same story.
 *  - `/oauth/token` and `/oauth/authorize/callback` are protocol terminals.
 *  - `/auth/error` is NextAuth's failure page; surfacing it as "auth
 *    required" obscures the real error (the user already tried to log in).
 */
const LOGIN_URL_EXCLUSIONS: readonly RegExp[] = [
    /\/auth\/(?:callback|verify|verify-request|complete|finalize|error|signout|sign-out|logout)(?:\/|$)/i,
    /\/oauth\/(?:callback|token|authorize\/callback|complete)(?:\/|$)/i,
    /\/sso\/(?:callback|complete|finalize)(?:\/|$)/i,
    /\/login\/(?:callback|complete)(?:\/|$)/i,
];

/**
 * Logout-shaped URL patterns. Navigating to one of these DESTROYS the
 * session the crawl is running on — the auth detector already excludes
 * them from wall-detection (they're not login pages), but that only stops
 * the *pause*; the crawler still navigated there and killed its own
 * session mid-run. The crawler consults {@link looksLikeLogoutUrl} at the
 * enqueue layer and refuses to navigate these while a storage state is
 * loaded (the link itself is still recorded as discovered structure).
 *
 * Segment-anchored like {@link LOGIN_URL_PATTERNS}: `/signout-everywhere`
 * or `?next=/logout` do not match.
 */
export const LOGOUT_URL_PATTERNS: readonly RegExp[] = [
    /\/logout(?:\/|$)/i,
    /\/log-out(?:\/|$)/i,
    /\/log_out(?:\/|$)/i,
    /\/signout(?:\/|$)/i,
    /\/sign-out(?:\/|$)/i,
    /\/sign_out(?:\/|$)/i,
];

const OAUTH_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
    { pattern: /sign in with google/i, provider: "Google" },
    { pattern: /sign in with github/i, provider: "GitHub" },
    { pattern: /sign in with microsoft/i, provider: "Microsoft" },
    { pattern: /sign in with apple/i, provider: "Apple" },
    { pattern: /sign in with facebook/i, provider: "Facebook" },
    { pattern: /continue with google/i, provider: "Google" },
    { pattern: /continue with github/i, provider: "GitHub" },
    { pattern: /log in with google/i, provider: "Google" },
    { pattern: /log in with github/i, provider: "GitHub" },
];

/**
 * Unambiguous auth-error PHRASES. These are safe to match against a page's
 * visible text because they almost never appear as incidental body copy.
 * Single words like "forbidden" / "unauthorized" are deliberately NOT here —
 * a docs page or blog about HTTP status codes would trip them. Those are only
 * consulted inside a scoped error/alert element (see {@link ERROR_ONLY_PATTERNS}).
 */
const AUTH_ERROR_PHRASES: RegExp[] = [
    /access denied/i,
    /please log in/i,
    /please sign in/i,
    /authentication required/i,
    /you must be logged in/i,
    /login required/i,
    /you don't have permission/i,
    /not authorized to/i,
];

/**
 * Broader single-word signals only trusted when they appear inside a scoped
 * error/alert element (role="alert", .alert-danger, …) — never against the
 * whole page body, where they produce false positives.
 */
const ERROR_ONLY_PATTERNS: RegExp[] = [
    ...AUTH_ERROR_PHRASES,
    /unauthorized/i,
    /forbidden/i,
    /not authorized/i,
];

const ERROR_SELECTORS = [
    ".error",
    ".alert-danger",
    ".alert-error",
    '[role="alert"]',
    ".message-error",
];

const SUBMIT_SELECTORS = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("sign in")',
    'button:has-text("log in")',
    'button:has-text("login")',
    'button:has-text("continue")',
];

export interface AuthDetectorOptions {
    /** Override the priority used in the pipeline. Defaults to 100. */
    priority?: number;
}

/**
 * Build the singleton auth detector. Kept as a factory (rather than a
 * `const detector =`) so consumers can override the priority for tests.
 */
export function createAuthDetector(options: AuthDetectorOptions = {}): BlockerDetector {
    const priority = options.priority ?? 100;
    return {
        id: "auth",
        category: "auth_required",
        priority,
        async detect(ctx: BlockerDetectorContext): Promise<DiscoveryBlocker | null> {
            const detected = await detectAuth(ctx);
            return detected;
        },
    };
}

/**
 * Internal: returns either an `AuthBlocker` (DiscoveryBlocker with the
 * legacy `blockerType` field populated) or `null`. Exported so the back-
 * compat `AuthDetector` class shim can call it without re-implementing
 * the pipeline ordering.
 */
export async function detectAuth(ctx: BlockerDetectorContext): Promise<AuthBlocker | null> {
    const { page, url, response } = ctx;

    // Strongest signal: server explicitly says "auth required".
    if (response && checkHttpStatus(response)) {
        return makeAuthBlocker(ctx, "http_status", { status: response.status() });
    }

    // Pre-DOM signal: a server-side redirect chain landed on a login-shaped
    // URL. This fires even if the login page itself doesn't expose a
    // `<input type="password">` (magic-link flows, slow-hydrating SPAs,
    // anti-bot heuristics that strip the form for headless browsers).
    if (response) {
        const redirectSignal = checkLoginRedirectChain(response);
        if (redirectSignal) {
            return makeAuthBlocker(ctx, "login_redirect", redirectSignal);
        }
    }

    // Strong signal: page is rendering an actual login form.
    const loginForm = await checkLoginForm(page);
    if (loginForm) {
        const matchedUrlPattern = checkUrlPatterns(url);
        // A password field alone is NOT a login wall on a non-login URL —
        // signed-in crawls of settings/change-password pages (and public
        // pages with any password input) used to be misfiled as auth routes
        // or pause the whole crawl (review finding). Off login-shaped URLs,
        // require corroboration: a known submit control (not the
        // "unknown" fallback) or an explicit auth-error message.
        if (matchedUrlPattern || loginForm.submitButton !== "unknown") {
            return makeAuthBlocker(ctx, matchedUrlPattern ? "url_pattern" : "login_form", {
                ...loginForm,
                matchedUrlPattern,
            });
        }
        const corroboratingError = await checkErrorMessages(page);
        if (corroboratingError) {
            return makeAuthBlocker(ctx, "login_form", {
                ...loginForm,
                matchedUrlPattern,
                errorMessage: corroboratingError.message,
            });
        }
        return null;
    }

    // OAuth-only landing pages: only treat as blockers if the URL also
    // looks login-y. Marketing pages frequently include "Sign in with
    // Google" widgets in the header without being auth walls.
    if (checkUrlPatterns(url)) {
        const oauthButton = await checkOAuthButtons(page);
        if (oauthButton) {
            return makeAuthBlocker(ctx, "oauth_button", oauthButton);
        }
    }

    // Explicit auth error copy ("please log in", "unauthorized", etc.).
    const errorMessage = await checkErrorMessages(page);
    if (errorMessage) {
        return makeAuthBlocker(ctx, "error_message", errorMessage);
    }

    return null;
}

function makeAuthBlocker(
    ctx: BlockerDetectorContext,
    blockerType: AuthBlockerType,
    evidence: Record<string, unknown>,
): AuthBlocker {
    const base = buildBlocker({
        ctx,
        detectorId: `auth:${blockerType}`,
        category: "auth_required",
        severity: "pause",
        evidence,
    });
    return { ...base, blockerType };
}

function checkUrlPatterns(url: string): boolean {
    return looksLikeLoginUrl(url);
}

/**
 * Public predicate that re-uses the same login-URL pattern set as the
 * detector. Exported so the crawler, the manual-handoff watcher, and
 * the CLI auth command all classify URLs identically — drift between
 * those three call sites was the root of H3 in the discovery audit.
 *
 * Match rules (applied to the URL's pathname, falling back to the raw
 * string if it doesn't parse as a URL):
 *
 *  1. If the path matches any {@link LOGIN_URL_EXCLUSIONS} pattern
 *     (OAuth callback, magic-link verify, signout, ...), return `false`.
 *     Exclusions win over inclusions because the same `/auth/...`
 *     namespace hosts both walls and success terminals — see the
 *     comments on `LOGIN_URL_EXCLUSIONS`.
 *  2. Otherwise, return `true` iff any {@link LOGIN_URL_PATTERNS}
 *     regex matches.
 *
 * Path-anchored matching (rather than substring) prevents query strings
 * with `?return=…/login` or hostnames like `login.example.com`'s
 * non-login pages from accidentally qualifying.
 */
export function looksLikeLoginUrl(url: string): boolean {
    const path = extractPath(url);
    if (LOGIN_URL_EXCLUSIONS.some((rx) => rx.test(path))) return false;
    return LOGIN_URL_PATTERNS.some((rx) => rx.test(path));
}

/**
 * Public predicate over {@link LOGOUT_URL_PATTERNS}, sharing the
 * path-extraction rules of {@link looksLikeLoginUrl} (pathname only —
 * a benign `?next=/logout` return-URL does not qualify).
 */
export function looksLikeLogoutUrl(url: string): boolean {
    const path = extractPath(url);
    return LOGOUT_URL_PATTERNS.some((rx) => rx.test(path));
}

/**
 * Pull the pathname out of a URL string. Returns the input unchanged
 * when it isn't parseable so callers passing already-extracted paths
 * (or relative URLs from test fixtures) still work.
 *
 * Pathname only — the search string is intentionally excluded so a
 * benign return-URL like `/?return=/login` doesn't trip the inclusion
 * patterns. The exclusion patterns also operate on path only; OAuth
 * callbacks like `/auth/callback?code=…` are excluded by their path
 * segment regardless of query string.
 */
function extractPath(url: string): string {
    try {
        return new URL(url).pathname;
    } catch {
        return url;
    }
}

async function checkLoginForm(
    page: Page,
): Promise<{ passwordField: string; submitButton: string } | null> {
    try {
        const passwordField = page.locator('input[type="password"]').first();
        if ((await passwordField.count()) === 0) return null;

        for (const selector of SUBMIT_SELECTORS) {
            if ((await page.locator(selector).first().count()) > 0) {
                return {
                    passwordField: 'input[type="password"]',
                    submitButton: selector,
                };
            }
        }
        return {
            passwordField: 'input[type="password"]',
            submitButton: "unknown",
        };
    } catch {
        return null;
    }
}

async function checkOAuthButtons(page: Page): Promise<{ provider: string; text: string } | null> {
    try {
        const content = await page.content();
        for (const { pattern, provider } of OAUTH_PATTERNS) {
            if (pattern.test(content)) {
                return {
                    provider,
                    text: content.match(pattern)?.[0] ?? `Sign in with ${provider}`,
                };
            }
        }
        return null;
    } catch {
        return null;
    }
}

async function checkErrorMessages(page: Page): Promise<{ message: string } | null> {
    try {
        // Match only the UNAMBIGUOUS phrases against page text. Single words
        // like "forbidden"/"unauthorized" are deliberately excluded here — they
        // appear as incidental copy on docs/blog pages and produced false auth
        // walls; those are only trusted inside a scoped error element below.
        //
        // Prefer VISIBLE body text over raw HTML: phrases hidden in <script>
        // JSON, comments, or metadata otherwise trip a false auth wall. Falls
        // back to page.content() when innerText isn't available (e.g. a page
        // mock without evaluate()).
        const content = await getVisibleText(page);
        for (const pattern of AUTH_ERROR_PHRASES) {
            const match = content.match(pattern);
            if (match) return { message: match[0] };
        }

        // Broader single-word signals are only trusted inside a scoped
        // error/alert element.
        for (const selector of ERROR_SELECTORS) {
            const element = page.locator(selector).first();
            if ((await element.count()) > 0) {
                const text = await element.textContent();
                if (text) {
                    for (const pattern of ERROR_ONLY_PATTERNS) {
                        if (pattern.test(text)) {
                            return { message: text.trim() };
                        }
                    }
                }
            }
        }
        return null;
    } catch {
        return null;
    }
}

function checkHttpStatus(response: Response): boolean {
    const status = response.status();
    return status === 401 || status === 403;
}

/**
 * Walk the request's redirect chain and return signal evidence iff a
 * non-login URL was redirected to a login-shaped URL.
 *
 * Returns `null` when:
 *  - There were no redirects (`finalUrl === origin`); the user navigated
 *    directly to the resolved URL.
 *  - The user navigated directly to a login URL (origin already matched
 *    a login pattern); they were *probably* testing the login page itself.
 *  - The chain landed somewhere that doesn't look like a login URL.
 *
 * Uses Playwright's `request.redirectedFrom()` chain rather than raw HTTP
 * status because by the time we get a Response, Playwright has transparently
 * followed every 30x and we'd otherwise see a 200 from the login page.
 *
 * Exported for unit tests.
 */
export function checkLoginRedirectChain(response: Response): {
    originUrl: string;
    finalUrl: string;
    chain: string[];
    hopCount: number;
} | null {
    const finalRequest: Request | null = response.request();
    if (!finalRequest) return null;

    // Walk backward from the final response's request to the original.
    // Capped at 20 hops as a runaway-loop guard; 1-2 hops is the norm.
    const chain: string[] = [];
    let cursor: Request | null = finalRequest;
    const MAX_HOPS = 20;
    for (let i = 0; i < MAX_HOPS; i++) {
        if (!cursor) break;
        chain.unshift(cursor.url());
        const prev: Request | null = cursor.redirectedFrom();
        if (!prev) break;
        cursor = prev;
    }

    if (chain.length < 2) {
        // No redirect in the chain — direct navigation to a single URL.
        return null;
    }

    const originUrl = chain[0];
    const finalUrl = response.url();

    // If the user navigated directly to a login URL, this isn't an auth
    // wall — they may be probing the login page itself.
    if (checkUrlPatterns(originUrl)) {
        return null;
    }

    // Only fire when the chain LANDED on something that looks like a login
    // URL. Same-origin marketing-page redirects (e.g. `/old-pricing` →
    // `/pricing`) must not pause discovery.
    if (!checkUrlPatterns(finalUrl)) {
        return null;
    }

    return {
        originUrl,
        finalUrl,
        chain,
        hopCount: chain.length - 1,
    };
}
