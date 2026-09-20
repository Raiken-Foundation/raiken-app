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
