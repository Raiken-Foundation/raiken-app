/**
 * Single Playwright Chromium bootstrap for core browser flows.
 *
 * Tries the full `playwright` package first (bundles browser binaries),
 * then falls back to `playwright-core` when callers supply their own
 * browser install path.
 */

export function loadPlaywrightChromium(): typeof import("playwright").chromium {
    try {
        return require("playwright").chromium;
    } catch {
        try {
            return require("playwright-core").chromium;
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Playwright is not installed. Install it with \`npx playwright install\`. (${detail})`,
            );
        }
    }
}

/**
 * Best-effort loader for integration specs — returns null when Playwright
 * is unavailable instead of throwing.
 */
export function tryLoadPlaywrightChromium(): typeof import("playwright").chromium | null {
    try {
        return loadPlaywrightChromium();
    } catch {
        return null;
    }
}
