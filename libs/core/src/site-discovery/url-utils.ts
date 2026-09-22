/**
 * Shared URL utilities for site discovery.
 */

export interface NormalizeUrlOptions {
    /**
     * Keep the query string (sorted for stable comparison) instead of dropping
     * it. Use for apps that render distinct content per query value.
     */
    preserveQueryParams?: boolean;
    /**
     * Keep `#/route`-style fragments in the normalized URL so hash-routed SPA
     * views are distinct crawlable pages. Off by default: fragments are
     * normally same-document anchors, not navigation targets.
     */
    preserveHashRoutes?: boolean;
}

/**
 * `…/index.html` / `…/index.htm` collapse onto their directory URL. Static
 * servers answer the same document at both spellings; treating them as
 * distinct URLs duplicated kb page rows and inflated page/link stats.
 */
const INDEX_FILE_SUFFIX = /\/index\.html?$/i;

/**
 * Normalize a URL for consistent comparison.
 * Strips fragments, index-file suffixes, and trailing slashes (except root).
 * Query parameters are stripped by default; pass `preserveQueryParams` to
 * keep them (sorted).
 */
/**
 * Pick the URL a hash-route navigation actually landed on.
 *
 * `response.url()` never carries a fragment (fragments are client-side), so a
 * request to `/#/stats` would otherwise collapse onto `/` and dedupe against
 * the root page — overwriting its snapshot with the routed view. The live
 * page URL reflects the final hash, including client-side redirects; fall
 * back to the response URL when the app cleared the hash.
 */
export function fragmentAwareResolvedUrl(
    requestedUrl: string,
    responseUrl: string | null,
    pageUrl: string | null,
): string {
    if (!requestedUrl.includes("#")) return responseUrl ?? requestedUrl;
    if (pageUrl && pageUrl.includes("#")) return pageUrl;
    return responseUrl ?? requestedUrl;
}

export function normalizeUrl(url: string, options: NormalizeUrlOptions = {}): string {
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname.replace(INDEX_FILE_SUFFIX, "/");
        let normalized = `${parsed.origin}${pathname}`;
        if (normalized.endsWith("/") && normalized !== `${parsed.origin}/`) {
            normalized = normalized.slice(0, -1);
        }
        if (options.preserveQueryParams && parsed.search) {
            // Sort params so `?a=1&b=2` and `?b=2&a=1` compare equal.
            const params = new URLSearchParams(parsed.search);
            params.sort();
            const query = params.toString();
            if (query) normalized += `?${query}`;
        }
        if (options.preserveHashRoutes && parsed.hash) {
            normalized += parsed.hash;
        }
        return normalized;
    } catch {
        return url;
    }
}
