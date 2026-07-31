/**
 * Convert a single exclude pattern into a matcher function.
 *
 *   - Patterns without "*" → legacy substring match (backward-compatible).
 *   - Patterns with "*"    → glob: "*" matches any chars except "/", "**"
 *                              matches any chars including "/".
 *
 * Bad regex compilation falls back to substring so a malformed entry can never
 * crash the crawl.
 */
export function compileExcludeMatcher(pattern: string): (url: string) => boolean {
    if (!pattern) {
        return () => false;
    }
    if (!pattern.includes("*")) {
        return (url) => url.includes(pattern);
    }
    try {
        const DOUBLESTAR_SENTINEL = "__RAIKEN_GLOBSTAR__";
        const re = pattern
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\*\*/g, DOUBLESTAR_SENTINEL)
            .replace(/\*/g, "[^/]*")
            .replace(new RegExp(DOUBLESTAR_SENTINEL, "g"), ".*");
        const compiled = new RegExp(re);
        return (url) => compiled.test(url);
    } catch {
        return (url) => url.includes(pattern);
    }
}

export function shouldExcludeUrl(url: string, matchers: Array<(url: string) => boolean>): boolean {
    for (const matcher of matchers) {
        if (matcher(url)) return true;
    }
    return false;
}
