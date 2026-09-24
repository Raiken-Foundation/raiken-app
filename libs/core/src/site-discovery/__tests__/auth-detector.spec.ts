/**
 * Auth Detector Tests
 *
 * Drives the auth detector through its public surface (`detectAuth`) and
 * a stub `Page`/`Response`. The previous test reached into private
 * methods on a class; that class is now a thin shim over `detectors/auth.ts`,
 * so we test the module directly.
 */

import { describe, expect, it } from "vitest";

import {
    checkLoginRedirectChain,
    detectAuth,
    looksLikeLoginUrl,
    looksLikeLogoutUrl,
} from "../detectors/auth";

const PROJECT_PATH = "/test/project";

interface FakeLocator {
    count: () => Promise<number>;
    first: () => FakeLocator;
    textContent?: () => Promise<string | null>;
}

function makePage(opts: { content?: string; locators?: Record<string, FakeLocator> }) {
    const locators = opts.locators ?? {};
    const defaultLocator: FakeLocator = {
        count: async () => 0,
        first() {
            return this;
        },
        textContent: async () => null,
    };
    return {
        content: async () => opts.content ?? "<html><body></body></html>",
        locator(selector: string) {
            return locators[selector] ?? defaultLocator;
        },
    } as unknown as import("playwright").Page;
}

/**
 * Build a Playwright Response stub.
 *
 *   makeResponse(401)
 *      → status 401, no redirect chain (single direct request).
 *
 *   makeResponse(200, { finalUrl, chain: ["/", "/login"] })
 *      → final response url is `/login`; the request chain represents a
 *        302 from `/` to `/login` (oldest → newest). Used by the
 *        login-redirect detection tests.
 */
function makeResponse(status: number, opts: { finalUrl?: string; chain?: string[] } = {}) {
    const finalUrl = opts.finalUrl ?? opts.chain?.at(-1) ?? "http://localhost:3000/";
    const chain = opts.chain ?? [finalUrl];

    type FakeRequest = {
        url: () => string;
        redirectedFrom: () => FakeRequest | null;
    };

    // Build a linked list of requests, oldest first → newest last.
    let prev: FakeRequest | null = null;
    let finalRequest: FakeRequest | null = null;
    for (const url of chain) {
        const captured = prev;
        const node: FakeRequest = {
            url: () => url,
            redirectedFrom: () => captured,
        };
        prev = node;
        finalRequest = node;
    }

    return {
        status: () => status,
        url: () => finalUrl,
        request: () => finalRequest,
    } as unknown as import("playwright").Response;
}

describe("detectAuth", () => {
    it("flags a 401 response as auth_required (http_status)", async () => {
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/api/me",
            page: makePage({}),
            response: makeResponse(401),
        });
        expect(blocker?.category).toBe("auth_required");
        expect(blocker?.detectorId).toBe("auth:http_status");
        expect(blocker?.blockerType).toBe("http_status");
    });

    it("flags a 403 response too", async () => {
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/api/secret",
            page: makePage({}),
            response: makeResponse(403),
        });
        expect(blocker?.detectorId).toBe("auth:http_status");
    });

    it("ignores 200 responses", async () => {
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000",
            page: makePage({}),
            response: makeResponse(200),
        });
        expect(blocker).toBeNull();
    });

    it("detects an explicit auth error message in page content", async () => {
        const page = makePage({
            content: "<html><body><div>Please log in to continue.</div></body></html>",
        });
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/dashboard",
            page,
        });
        expect(blocker?.detectorId).toBe("auth:error_message");
    });

    it("does NOT pause on a marketing page that just hosts a 'Sign in with Google' button", async () => {
        // The OAuth check only fires when the URL also looks login-y.
        const page = makePage({
            content: "<html><body><a>Sign in with Google</a></body></html>",
        });
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/marketing",
            page,
        });
        expect(blocker).toBeNull();
    });

    it("DOES pause on a /login page that exposes a 'Sign in with Google' button", async () => {
        const page = makePage({
            content: "<html><body><a>Sign in with Google</a></body></html>",
        });
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/login",
            page,
        });
        expect(blocker?.detectorId).toBe("auth:oauth_button");
    });

    it("detects a login form (password + submit)", async () => {
        const passwordLocator: FakeLocator = {
            count: async () => 1,
            first() {
                return this;
            },
        };
        const submitLocator: FakeLocator = {
            count: async () => 1,
            first() {
                return this;
            },
        };
        const page = makePage({
            content:
                "<html><body><form><input type='password'/><button type='submit'>Go</button></form></body></html>",
            locators: {
                'input[type="password"]': passwordLocator,
                'button[type="submit"]': submitLocator,
            },
        });
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/dashboard",
            page,
        });
        // No URL pattern match: detector_id should be auth:login_form.
        expect(blocker?.detectorId).toBe("auth:login_form");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // login_redirect — Issue 4 regression coverage
    //
    // The pre-DOM redirect-chain signal must fire even when the destination
    // login page never renders a `<input type="password">` (slow-hydrating
    // Next.js shells, magic-link flows, anti-bot withholding the form).
    // ─────────────────────────────────────────────────────────────────────────

    it("flags a single-hop 302 from /dashboard to /auth/login", async () => {
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://localhost:3000/dashboard",
            page: makePage({}),
            response: makeResponse(200, {
                chain: ["http://localhost:3000/dashboard", "http://localhost:3000/auth/login"],
            }),
        });
        expect(blocker?.detectorId).toBe("auth:login_redirect");
        expect(blocker?.category).toBe("auth_required");
        expect(blocker?.blockerType).toBe("login_redirect");

        const evidence = JSON.parse(blocker?.evidenceJson ?? "{}");
        expect(evidence.originUrl).toBe("http://localhost:3000/dashboard");
        expect(evidence.finalUrl).toBe("http://localhost:3000/auth/login");
        expect(evidence.hopCount).toBe(1);
    });

    it("flags a multi-hop redirect chain that lands on /signin", async () => {
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://app.example.com/projects/42",
            page: makePage({}),
            response: makeResponse(200, {
                chain: [
                    "http://app.example.com/projects/42",
                    "http://app.example.com/auth",
                    "http://app.example.com/signin",
                ],
            }),
        });
        expect(blocker?.detectorId).toBe("auth:login_redirect");
        const evidence = JSON.parse(blocker?.evidenceJson ?? "{}");
        expect(evidence.hopCount).toBe(2);
        expect(evidence.chain).toHaveLength(3);
    });

    it("does NOT flag a same-origin marketing redirect (e.g. /old → /new)", async () => {
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://example.com/old-pricing",
            page: makePage({}),
            response: makeResponse(200, {
                chain: ["http://example.com/old-pricing", "http://example.com/pricing"],
            }),
        });
        expect(blocker).toBeNull();
    });

    it("does NOT flag direct navigation to a login URL with no redirect", async () => {
        // The user navigated *directly* to /login — they may be probing the
        // login page itself, not hitting an auth wall.
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://example.com/login",
            page: makePage({}),
            response: makeResponse(200, {
                chain: ["http://example.com/login"],
            }),
        });
        expect(blocker).toBeNull();
    });

    it("does NOT flag a redirect chain that began at a login URL", async () => {
        // /login → /login?error=… is internal to the auth flow; not an auth wall.
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://example.com/login",
            page: makePage({}),
            response: makeResponse(200, {
                chain: ["http://example.com/login", "http://example.com/login?error=invalid"],
            }),
        });
        expect(blocker).toBeNull();
    });

    it("prefers http_status (401) over login_redirect when both are present", async () => {
        // A redirect chain landed on /auth/login AND the response is 401.
        // The stronger, more specific signal wins.
        const blocker = await detectAuth({
            projectPath: PROJECT_PATH,
            url: "http://example.com/api/me",
            page: makePage({}),
            response: makeResponse(401, {
                chain: ["http://example.com/api/me", "http://example.com/auth/login"],
            }),
        });
        expect(blocker?.detectorId).toBe("auth:http_status");
    });
});

describe("checkLoginRedirectChain", () => {
    it("returns null when there is no response request (browser produced none)", () => {
        const fakeResponse = {
            status: () => 200,
            url: () => "http://example.com/",
            request: () => null,
        } as unknown as import("playwright").Response;
        expect(checkLoginRedirectChain(fakeResponse)).toBeNull();
    });

    it("caps the redirect-chain walk at 20 hops as a runaway-loop guard", () => {
        // Build a 25-hop self-referential chain ending on /login. The walk
        // must terminate without throwing and still report a positive signal.
        const chain = Array.from({ length: 25 }, (_, i) =>
            i === 24 ? "http://example.com/login" : `http://example.com/r${i}`,
        );
        const result = checkLoginRedirectChain(makeResponse(200, { chain }));
        expect(result).not.toBeNull();
        expect(result?.chain.length).toBe(20);
        expect(result?.finalUrl).toBe("http://example.com/login");
    });
});

describe("looksLikeLoginUrl", () => {
    // Crawler uses this to decide whether to emit the residual auth-wall
    // hint when no detector fires (e.g. user pointed `discover` straight
    // at /auth/login on a magic-link flow). Pattern set is intentionally
    // shared with the redirect-chain detector AND the manual-handoff /
    // CLI auth watchers — drift between those call sites was H3 in the
    // discovery audit, so we test the canonical predicate here.
    it.each([
        "http://example.com/login",
        "http://example.com/login/",
        "http://example.com/signin",
        "http://example.com/sign-in",
        "http://example.com/log-in",
        // Underscore variants now match — Rails/Devise apps land on
        // `/users/sign_in`, and pre-fix this fell through to a generic
        // "no pages" error instead of the auth-wall handoff.
        "http://example.com/sign_in",
        "http://example.com/log_in",
        "http://example.com/users/sign_in",
        "http://example.com/auth",
        "http://example.com/auth/login",
        "http://example.com/auth/signin",
        // OAuth *authorize* leg is a wall (the user is being asked to
        // consent / log in); the *callback* leg is excluded below.
        "http://example.com/oauth/authorize",
        "http://example.com/oauth",
        // Account-namespaced login forms (some BCP shells route under
        // /account/login rather than top-level /login).
        "http://example.com/account/login",
        "http://example.com/account/sign_in",
        // SSO landing pages.
        "http://example.com/sso/login",
        "http://example.com/sso",
        "http://example.com/api/auth/signin",
        "http://example.com/authenticate",
    ])("matches login-shaped URL: %s", (url) => {
        expect(looksLikeLoginUrl(url)).toBe(true);
    });

    it.each([
        "http://example.com/",
        "http://example.com/dashboard",
        "http://example.com/projects/42",
        "http://example.com/settings",
        // /logout is the *exit*, not a wall.
        "http://example.com/logout",
        // Hostname containing "login" mustn't trip the predicate when the
        // path is non-login. Pre-anchor fix this matched (regex was
        // applied to the whole URL string).
        "http://login.example.com/dashboard",
        // Query strings that mention "login" are not by themselves a
        // login wall.
        "http://example.com/?return=/login",
        "http://example.com/blog/post-about-login",
    ])("does not match non-login URL: %s", (url) => {
        expect(looksLikeLoginUrl(url)).toBe(false);
    });

    // Exclusions: paths that *look* login-shaped via the inclusion set
    // but are actually success/completion legs of an auth dance.
    // Treating these as walls produces a confusing false positive — the
    // user is mid-OAuth-callback or just clicked a magic link, and the
    // crawl shouldn't re-prompt them to "log in".
    it.each([
        // OAuth/OIDC callback handlers
        "http://example.com/auth/callback",
        "http://example.com/auth/callback?code=abc&state=xyz",
        "http://example.com/oauth/callback",
        "http://example.com/oauth/token",
        "http://example.com/oauth/authorize/callback",
        // Magic-link verification landing pages
        "http://example.com/auth/verify",
        "http://example.com/auth/verify-request",
        // NextAuth error / signout pages — the user already tried to log
        // in, surfacing "auth required" obscures the real error.
        "http://example.com/auth/error",
        "http://example.com/auth/signout",
        "http://example.com/auth/sign-out",
        // SSO callback (Okta, Auth0)
        "http://example.com/sso/callback",
        // Generic /login/callback (some custom flows)
        "http://example.com/login/callback",
    ])("does NOT match auth-completion URL: %s", (url) => {
        expect(looksLikeLoginUrl(url)).toBe(false);
    });
});

describe("looksLikeLogoutUrl", () => {
    // The crawler consults this at the enqueue layer: while a storage
    // state is loaded, navigating one of these would destroy the session
    // the crawl is running on (the auth detector already excludes them
    // from wall-detection, but that never stopped the navigation).
    it.each([
        "http://example.com/logout",
        "http://example.com/logout/",
        "http://example.com/log-out",
        "http://example.com/log_out",
        "http://example.com/signout",
        "http://example.com/sign-out",
        "http://example.com/sign_out",
        "http://example.com/users/sign_out",
        "http://example.com/auth/signout",
        "http://example.com/account/logout?next=/",
    ])("matches logout-shaped URL: %s", (url) => {
        expect(looksLikeLogoutUrl(url)).toBe(true);
    });

    it.each([
        "http://example.com/",
        "http://example.com/login",
        "http://example.com/dashboard",
        // A benign return-URL in the query string is not a logout action —
        // the predicate matches on the pathname only.
        "http://example.com/login?next=/logout",
        "http://example.com/settings?return=/signout",
        // Segment-anchored: a longer segment that merely contains the
        // word must not match.
        "http://example.com/signout-everywhere",
        "http://example.com/logoutism",
    ])("does not match non-logout URL: %s", (url) => {
        expect(looksLikeLogoutUrl(url)).toBe(false);
    });
});
