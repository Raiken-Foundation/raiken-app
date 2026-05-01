/**
 * Auth detector.
 *
 * Recognises five auth-required signals: 401/403 responses, login forms
 * (password + submit), OAuth-only landing pages, explicit auth error copy
 * ("please log in", etc.), and login-shaped URLs paired with a form.
 *
 * The detection priority is ordered from least-to-most ambiguous, and
 * URL patterns are deliberately *not* a standalone signal: routes like
 * `/account/settings`, `/auth/callback`, or `/sso/landing` legitimately
 * appear on authenticated apps. A blocker is only emitted when there is
 * concrete evidence the page is gating on auth.
 */

import type { Page, Response } from "playwright";

import type { AuthBlocker, AuthBlockerType, DiscoveryBlocker } from "../types";
import { type BlockerDetector, type BlockerDetectorContext, buildBlocker } from "./types";

const LOGIN_URL_PATTERNS: RegExp[] = [
    /\/login\/?/i,
    /\/signin\/?/i,
    /\/sign-in\/?/i,
    /\/auth\/?/i,
    /\/authenticate\/?/i,
    /\/log-in\/?/i,
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

const AUTH_ERROR_PATTERNS: RegExp[] = [
    /access denied/i,
    /unauthorized/i,
    /please log in/i,
    /please sign in/i,
    /authentication required/i,
    /you must be logged in/i,
    /login required/i,
    /forbidden/i,
    /you don't have permission/i,
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

    // Strong signal: page is rendering an actual login form.
    const loginForm = await checkLoginForm(page);
    if (loginForm) {
        const matchedUrlPattern = checkUrlPatterns(url);
        return makeAuthBlocker(ctx, matchedUrlPattern ? "url_pattern" : "login_form", {
            ...loginForm,
            matchedUrlPattern,
        });
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
    return LOGIN_URL_PATTERNS.some((pattern) => pattern.test(url));
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
        const content = await page.content();
        for (const pattern of AUTH_ERROR_PATTERNS) {
            const match = content.match(pattern);
            if (match) return { message: match[0] };
        }

        for (const selector of ERROR_SELECTORS) {
            const element = page.locator(selector).first();
            if ((await element.count()) > 0) {
                const text = await element.textContent();
                if (text) {
                    for (const pattern of AUTH_ERROR_PATTERNS) {
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
