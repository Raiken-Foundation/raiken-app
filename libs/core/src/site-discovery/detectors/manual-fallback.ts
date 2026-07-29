/**
 * Manual fallback detector.
 *
 * Catches the "obvious next things" the human-in-the-loop story needs to
 * handle but no other detector covers:
 *
 *   1. **5xx error pages** → category `error_page`. The crawl shouldn't
 *      keep hammering a route the server is choking on, and the user
 *      almost always wants to investigate before continuing.
 *   2. **Captcha iframes** (Cloudflare Turnstile, reCAPTCHA, hCaptcha)
 *      → category `captcha`. The user must solve these in a real
 *      browser; the dashboard's "Open in browser" handoff is the right
 *      escape hatch.
 *   3. **429 responses** → category `rate_limited`. Split out from the
 *      5xx bucket above because the right resolution is "wait, then
 *      retry", not "investigate the app".
 *   4. **Consent/cookie walls** → category `consent_wall`. Known CMP
 *      widgets (OneTrust, Cookiebot, Usercentrics, Quantcast Choice) plus a
 *      generic `role="dialog"` fallback that requires both consent-shaped
 *      copy AND an accept-like button, so a random modal doesn't false-fire.
 *   5. **Geo-blocked pages** → category `geo_blocked`. Text-pattern match
 *      against common "not available in your region" copy.
 *   6. **Full-page interstitials** → category `interstitial`. A
 *      viewport-covering fixed/absolute overlay with no other blocker
 *      category matched and (nearly) no other interactive content reachable
 *      behind it.
 *
 * Order matters: cheaper, more specific checks (HTTP status) run before
 * DOM scrapes, and DOM scrapes are ordered most- to least-specific so a
 * known consent-wall widget is never misreported as a generic interstitial.
 */

import type { Page } from "playwright";

import type { DiscoveryBlocker } from "../types";
import { type BlockerDetector, type BlockerDetectorContext, buildBlocker } from "./types";
import { getVisibleText } from "./util";

const CAPTCHA_IFRAME_SELECTORS = [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha.com"]',
    'iframe[src*="api.arkoselabs.com"]',
];

/**
 * Known consent-management-platform (CMP) widget selectors. Each maps
 * directly to a `provider` name in the emitted evidence so the dashboard
 * can show "OneTrust" rather than a raw selector.
 */
const CONSENT_WALL_SELECTORS: Array<{ selector: string; provider: string }> = [
    { selector: "#onetrust-banner-sdk", provider: "OneTrust" },
    { selector: "#onetrust-consent-sdk", provider: "OneTrust" },
    { selector: ".ot-sdk-container", provider: "OneTrust" },
    { selector: "#CybotCookiebotDialog", provider: "Cookiebot" },
    { selector: "#usercentrics-root", provider: "Usercentrics" },
    { selector: ".qc-cmp2-container", provider: "Quantcast Choice" },
    { selector: ".cc-window", provider: "Cookieconsent" },
    { selector: "#cookie-law-info-bar", provider: "CookieYes" },
    { selector: "#didomi-host", provider: "Didomi" },
    { selector: '[id^="sp_message_container"]', provider: "Sourcepoint" },
];

/** Button text that signals "this dialog is asking me to accept something". */
const CONSENT_ACCEPT_BUTTON_SELECTOR = [
    'button:has-text("accept")',
    'button:has-text("agree")',
    'button:has-text("allow")',
    'button:has-text("got it")',
    'button:has-text("i understand")',
    '[role="button"]:has-text("accept")',
].join(", ");

/** Copy that indicates a dialog is consent/cookie-shaped, not just any modal. */
const CONSENT_COPY_PATTERN = /cookie|consent|gdpr|privacy preference/i;

const GEO_BLOCKED_PATTERNS: RegExp[] = [
    /not available in your (region|country|area)/i,
    /(content|service|page) is not available in your (country|region|location)/i,
    /due to (legal|licensing) restrictions.*(country|region)/i,
    /(do not|don't) have access to this content from your (location|region|country)/i,
    /geo.?blocked/i,
    /geographic(al)? restrictions? (apply|prevent)/i,
    /(is|content is) restricted in your (country|region)/i,
    /this (video|content|page) is not available in your area/i,
];

/**
 * Selectors that would indicate real page content is still reachable OUTSIDE
 * an overlay. Used to distinguish a genuine full-page interstitial (nothing
 * else usable) from an app that merely has a fixed header/cookie bar
 * alongside normal content. Includes links: a link-only page (docs sites)
 * is perfectly usable content.
 */
const INTERACTIVE_CONTENT_SELECTOR =
    'main, article, [role="main"], nav, form, table, a[href], button:not([disabled])';

/**
 * Structural content INSIDE the overlay that marks it as the app shell
 * rather than an interstitial. SPAs commonly render everything into a
 * `#root { position: absolute; inset: 0 }` wrapper — full-viewport by
 * design, but rich with navigation/content, unlike an age gate or paywall
 * splash which contains at most a couple of buttons and links.
 */
const APP_SHELL_CONTENT_SELECTOR = 'main, article, [role="main"], nav, table';
const APP_SHELL_LINK_THRESHOLD = 5;

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
            const rateLimited = checkRateLimited(ctx);
            if (rateLimited) return rateLimited;

            const errorPage = checkServerError(ctx);
            if (errorPage) return errorPage;

            const captcha = await checkCaptchaIframe(ctx);
            if (captcha) return captcha;

            const consentWall = await checkConsentWall(ctx);
            if (consentWall) return consentWall;

            const geoBlocked = await checkGeoBlocked(ctx);
            if (geoBlocked) return geoBlocked;

            const interstitial = await checkInterstitial(ctx);
            if (interstitial) return interstitial;

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

/**
 * HTTP 429 ("Too Many Requests"). Kept separate from `checkServerError`
 * (which only fires on >= 500) because the right resolution here is "wait
 * and retry", surfaced via the `Retry-After` header when the server sends
 * one, rather than "investigate the app".
 */
function checkRateLimited(ctx: BlockerDetectorContext): DiscoveryBlocker | null {
    const response = ctx.response;
    if (!response) return null;
    if (response.status() !== 429) return null;
    let retryAfter: string | null = null;
    try {
        retryAfter = response.headers()["retry-after"] ?? null;
    } catch {
        // Header lookup can fail on a torn-down response; not fatal.
    }
    return buildBlocker({
        ctx,
        detectorId: "manual:rate_limited",
        category: "rate_limited",
        severity: "pause",
        evidence: { status: 429, statusText: response.statusText(), retryAfter },
    });
}

/**
 * Consent/cookie walls: known CMP widgets first (specific, low false-positive
 * risk), then a generic `role="dialog"`/`role="alertdialog"` fallback that
 * requires BOTH consent-shaped copy and an accept-like button so an
 * unrelated modal (e.g. "confirm delete") never misfires.
 */
async function checkConsentWall(ctx: BlockerDetectorContext): Promise<DiscoveryBlocker | null> {
    const { page } = ctx;

    for (const { selector, provider } of CONSENT_WALL_SELECTORS) {
        try {
            const locator = page.locator(selector).first();
            if ((await locator.count()) === 0) continue;
            if (!(await locator.isVisible().catch(() => false))) continue;
            if (!(await isBlockingConsentElement(page, selector, 0))) continue;
            return buildBlocker({
                ctx,
                detectorId: "manual:consent_wall",
                category: "consent_wall",
                severity: "pause",
                evidence: { selector, provider },
            });
        } catch {}
    }

    const generic = await checkGenericConsentDialog(page);
    if (generic) {
        return buildBlocker({
            ctx,
            detectorId: "manual:consent_wall_generic",
            category: "consent_wall",
            severity: "pause",
            evidence: generic,
        });
    }
    return null;
}

async function checkGenericConsentDialog(
    page: Page,
): Promise<{ selector: string; text: string } | null> {
    for (const selector of ['[role="dialog"]', '[role="alertdialog"]']) {
        try {
            const locator = page.locator(selector);
            const count = await locator.count();
            for (let i = 0; i < Math.min(count, 5); i++) {
                const el = locator.nth(i);
                if (!(await el.isVisible().catch(() => false))) continue;
                const text = ((await el.textContent()) || "").trim();
                if (!CONSENT_COPY_PATTERN.test(text)) continue;
                const hasAcceptButton = await el
                    .locator(CONSENT_ACCEPT_BUTTON_SELECTOR)
                    .count()
                    .catch(() => 0);
                if (hasAcceptButton === 0) continue;
                if (!(await isBlockingConsentElement(page, selector, i))) continue;
                return { selector, text: text.slice(0, 200) };
            }
        } catch {}
    }
    return null;
}

/**
 * Consent copy alone is not a wall. Verify that the candidate actually
 * prevents interaction with usable page content outside itself. This keeps a
 * bottom cookie banner from masking a login form while still detecting modal
 * overlays whose backdrop intercepts the rest of the page.
 */
async function isBlockingConsentElement(
    page: Page,
    selector: string,
    index: number,
): Promise<boolean> {
    try {
        return await page.evaluate(
            ({ candidateSelector, candidateIndex, contentSelector }) => {
                const consentCandidates = Array.from(
                    document.querySelectorAll(candidateSelector),
                ) as HTMLElement[];
                const consentCandidate = consentCandidates[candidateIndex];
                if (!consentCandidate) return false;

                const isRendered = (element: Element): boolean => {
                    const style = window.getComputedStyle(element);
                    const rect = element.getBoundingClientRect();
                    return (
                        style.display !== "none" &&
                        style.visibility !== "hidden" &&
                        rect.width > 0 &&
                        rect.height > 0
                    );
                };

                const viewportArea = window.innerWidth * window.innerHeight;
                const candidateRect = consentCandidate.getBoundingClientRect();
                const candidateArea =
                    Math.max(0, candidateRect.width) * Math.max(0, candidateRect.height);
                if (viewportArea > 0 && candidateArea / viewportArea >= 0.85) return true;

                for (const element of Array.from(document.querySelectorAll(contentSelector))) {
                    if (consentCandidate.contains(element) || !isRendered(element)) continue;
                    const rect = element.getBoundingClientRect();
                    const x = Math.min(
                        Math.max(rect.left + rect.width / 2, 0),
                        Math.max(window.innerWidth - 1, 0),
                    );
                    const y = Math.min(
                        Math.max(rect.top + rect.height / 2, 0),
                        Math.max(window.innerHeight - 1, 0),
                    );
                    const hit = document.elementFromPoint(x, y);
                    if (hit && (hit === element || element.contains(hit))) return false;
                }

                return true;
            },
            {
                candidateSelector: selector,
                candidateIndex: index,
                contentSelector: INTERACTIVE_CONTENT_SELECTOR,
            },
        );
    } catch {
        return false;
    }
}

/**
 * Text-pattern match for common "not available in your region" copy.
 * Deliberately not gated on HTTP status — geo-blocking is frequently served
 * as a normal 200 with a client-rendered notice rather than a distinct
 * status code — but the status is still recorded in evidence when present.
 */
async function checkGeoBlocked(ctx: BlockerDetectorContext): Promise<DiscoveryBlocker | null> {
    try {
        const text = await getVisibleText(ctx.page);
        for (const pattern of GEO_BLOCKED_PATTERNS) {
            const match = text.match(pattern);
            if (match) {
                return buildBlocker({
                    ctx,
                    detectorId: "manual:geo_blocked",
                    category: "geo_blocked",
                    severity: "pause",
                    evidence: { status: ctx.response?.status(), matchedText: match[0] },
                });
            }
        }
    } catch {
        // getVisibleText already fails open; nothing else to do here.
    }
    return null;
}

/**
 * Generic full-page interstitial: a fixed/absolute overlay that covers (most
 * of) the viewport with no other blocker category matched. Requires BOTH a
 * viewport-covering overlay AND the absence of reachable interactive content
 * outside it, so a normal page with a large hero image or a small toast
 * doesn't misfire.
 */
async function checkInterstitial(ctx: BlockerDetectorContext): Promise<DiscoveryBlocker | null> {
    const { page } = ctx;
    try {
        const overlay = await findViewportCoveringOverlay(page);
        if (!overlay) return null;

        // Content still reachable outside the overlay → not blocking.
        if (overlay.reachableOutside > 0) return null;

        // Everything lives inside a full-viewport wrapper AND that wrapper is
        // content-rich → it's the app shell (SPA `#root { position:absolute;
        // inset:0 }`), not an interstitial.
        if (overlay.looksLikeAppShell) return null;

        return buildBlocker({
            ctx,
            detectorId: "manual:interstitial",
            category: "interstitial",
            severity: "pause",
            evidence: { selector: overlay.selector, coveragePct: overlay.coveragePct },
        });
    } catch {
        return null;
    }
}

/**
 * Scan direct children of `<body>` for one that visually covers (almost) the
 * whole viewport via `position: fixed|absolute`, and classify what's inside
 * vs. outside it. Runs as a single `evaluate()` round-trip rather than
 * per-element Playwright calls — the inside/outside split has to happen in
 * the page context anyway (`el.contains`).
 */
async function findViewportCoveringOverlay(page: Page): Promise<{
    selector: string;
    coveragePct: number;
    reachableOutside: number;
    looksLikeAppShell: boolean;
} | null> {
    return page.evaluate(
        ({ contentSelector, shellSelector, shellLinkThreshold }) => {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            if (vw === 0 || vh === 0) return null;
            const viewportArea = vw * vh;
            const MIN_COVERAGE = 0.85;

            const isRendered = (el: Element): boolean => {
                const s = window.getComputedStyle(el);
                return s.display !== "none" && s.visibility !== "hidden";
            };

            const candidates = Array.from(document.body.children) as HTMLElement[];
            for (const el of candidates) {
                const style = window.getComputedStyle(el);
                if (style.position !== "fixed" && style.position !== "absolute") continue;
                if (style.display === "none" || style.visibility === "hidden") continue;
                const rect = el.getBoundingClientRect();
                const area = Math.max(0, rect.width) * Math.max(0, rect.height);
                const coveragePct = area / viewportArea;
                if (coveragePct < MIN_COVERAGE) continue;

                let reachableOutside = 0;
                for (const content of Array.from(document.querySelectorAll(contentSelector))) {
                    if (el.contains(content) || !isRendered(content)) continue;
                    reachableOutside++;
                }

                const structuralInside = Array.from(el.querySelectorAll(shellSelector)).filter(
                    isRendered,
                ).length;
                const linksInside = Array.from(el.querySelectorAll("a[href]")).filter(
                    isRendered,
                ).length;
                const looksLikeAppShell = structuralInside > 0 || linksInside >= shellLinkThreshold;

                const idPart = el.id ? `#${el.id}` : "";
                const classPart = el.className
                    ? `.${String(el.className).trim().split(/\s+/).slice(0, 2).join(".")}`
                    : "";
                return {
                    selector: `${el.tagName.toLowerCase()}${idPart}${classPart}`,
                    coveragePct: Math.round(coveragePct * 100) / 100,
                    reachableOutside,
                    looksLikeAppShell,
                };
            }
            return null;
        },
        {
            contentSelector: INTERACTIVE_CONTENT_SELECTOR,
            shellSelector: APP_SHELL_CONTENT_SELECTOR,
            shellLinkThreshold: APP_SHELL_LINK_THRESHOLD,
        },
    );
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
