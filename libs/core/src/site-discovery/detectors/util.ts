/**
 * Shared helpers for blocker detectors. Kept dependency-free (just
 * Playwright) so any detector can import from here without pulling in
 * another detector's module.
 */

import type { Page } from "playwright";

/**
 * Best-effort visible text of the page. Uses `document.body.innerText` (what
 * a user actually sees, so hidden banners/scripts/JSON blobs don't trip a
 * false positive) and falls back to raw HTML when `evaluate` is unavailable
 * or throws (e.g. a test double without a real execution context).
 */
export async function getVisibleText(page: Page): Promise<string> {
    try {
        const text = await page.evaluate(() => document.body?.innerText ?? "");
        if (typeof text === "string" && text.trim().length > 0) return text;
    } catch {
        // evaluate not available (e.g. test mock) or execution context gone.
    }
    try {
        return await page.content();
    } catch {
        return "";
    }
}

/**
 * True if a locator resolves to at least one element that is actually
 * visible. Swallows errors (detached elements, cross-origin iframes,
 * mid-navigation frames) and reports `false` rather than throwing, since a
 * detector abstaining is always safer than one that crashes the pipeline.
 */
export async function isVisible(locator: {
    count: () => Promise<number>;
    first: () => { isVisible: () => Promise<boolean> };
}): Promise<boolean> {
    try {
        if ((await locator.count()) === 0) return false;
        return await locator.first().isVisible();
    } catch {
        return false;
    }
}
