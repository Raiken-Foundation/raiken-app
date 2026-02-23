/**
 * Shared URL utilities for site discovery.
 */

/**
 * Normalize a URL for consistent comparison.
 * Strips query parameters, fragments, and trailing slashes (except root).
 */
export function normalizeUrl(url: string): string {
    try {
        const parsed = new URL(url);
        let normalized = `${parsed.origin}${parsed.pathname}`;
        if (normalized.endsWith("/") && normalized !== `${parsed.origin}/`) {
            normalized = normalized.slice(0, -1);
        }
        return normalized;
    } catch {
        return url;
    }
}
