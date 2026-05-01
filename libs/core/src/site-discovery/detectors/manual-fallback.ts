/**
 * Manual fallback detector.
 *
 * Catches the two "obvious next things" the human-in-the-loop story
 * needs to handle but no other detector covers:
 *
 *   1. **5xx error pages** → category `error_page`. The crawl shouldn't
 *      keep hammering a route the server is choking on, and the user
 *      almost always wants to investigate before continuing.
 *   2. **Captcha iframes** (Cloudflare Turnstile, reCAPTCHA, hCaptcha)
 *      → category `captcha`. The user must solve these in a real
 *      browser; the dashboard's "Open in browser" handoff is the right
 *      escape hatch.
 *
 * Other categories called out in the plan (`consent_wall`, `interstitial`,
 * `rate_limited`, `geo_blocked`) get TODO selectors below — adding them
 * is a single line of code each, gated on us seeing real-world examples
 * to calibrate against.
 */

import type { Page } from "playwright";

import type { DiscoveryBlocker } from "../types";
import { type BlockerDetector, type BlockerDetectorContext, buildBlocker } from "./types";

const CAPTCHA_IFRAME_SELECTORS = [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha.com"]',
    'iframe[src*="api.arkoselabs.com"]',
];

// TODO(detector): add consent-wall selectors once we have a couple of
// real-world examples. Common candidates: OneTrust banners,
// `[data-testid="cookie-banner"]`, and `iframe[src*="consensu.org"]`.
//
// TODO(detector): rate-limit detection currently overlaps with
// `error_page`; split out 429 explicitly when we want a different
// resolution flow (e.g. "wait N minutes" rather than "skip URL").

export interface ManualFallbackDetectorOptions {
    /** Override the priority. Defaults to 50 (runs before the auth detector). */
    priority?: number;
}

export function createManualFallbackDetector(
    options: ManualFallbackDetectorOptions = {},
): BlockerDetector {
    return {
        id: "manual-fallback",
        // The detector emits multiple categories depending on what it
        // sees; declare `unknown` here as the "default" advertisement
        // and rely on the per-blocker `category` field for the truth.
        category: "unknown",
        priority: options.priority ?? 50,
        async detect(ctx: BlockerDetectorContext): Promise<DiscoveryBlocker | null> {
            const errorPage = checkServerError(ctx);
            if (errorPage) return errorPage;

            const captcha = await checkCaptchaIframe(ctx);
            if (captcha) return captcha;

            return null;
        },
    };
}

function checkServerError(ctx: BlockerDetectorContext): DiscoveryBlocker | null {
    const response = ctx.response;
    if (!response) return null;
    const status = response.status();
    if (status < 500) return null;
    return buildBlocker({
        ctx,
        detectorId: "manual:error_page",
        category: "error_page",
        severity: "pause",
        evidence: { status, statusText: response.statusText() },
    });
}

async function checkCaptchaIframe(ctx: BlockerDetectorContext): Promise<DiscoveryBlocker | null> {
    const found = await findFirstCaptchaProvider(ctx.page);
    if (!found) return null;
    return buildBlocker({
        ctx,
        detectorId: "manual:captcha_iframe",
        category: "captcha",
        severity: "pause",
        evidence: found,
    });
}

async function findFirstCaptchaProvider(
    page: Page,
): Promise<{ provider: string; selector: string } | null> {
    for (const selector of CAPTCHA_IFRAME_SELECTORS) {
        try {
            const count = await page.locator(selector).count();
            if (count > 0) {
                return { provider: providerOf(selector), selector };
            }
        } catch {
            // Ignore — the iframe might be cross-origin or removed
            // mid-poll. The caller treats null as "no captcha".
        }
    }
    return null;
}

function providerOf(selector: string): string {
    if (selector.includes("cloudflare")) return "Cloudflare Turnstile";
    if (selector.includes("recaptcha")) return "reCAPTCHA";
    if (selector.includes("hcaptcha")) return "hCaptcha";
    if (selector.includes("arkoselabs")) return "Arkose";
    return "Unknown";
}
