/**
 * Deterministic post-processing for generated Playwright specs.
 *
 * Shared by the agent generation path and `raiken cover` so both apply the
 * same auth / URL normalizations instead of drifting.
 */

/**
 * Insert `test.use({ storageState })` after the import block when the draft
 * does not already reference a storage state. Idempotent.
 */
export function injectStorageState(code: string, relPath: string): string {
    if (!code.trim()) return code;
    if (/storageState/.test(code)) return code;
    const lines = code.split("\n");
    let lastImport = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*import\b.*\bfrom\b.*['"].*['"];?\s*$/.test(lines[i] ?? "")) lastImport = i;
    }
    const useLine = `test.use({ storageState: ${JSON.stringify(relPath)} });`;
    if (lastImport >= 0) {
        lines.splice(lastImport + 1, 0, "", useLine);
        return lines.join("\n");
    }
    return `${useLine}\n\n${code}`;
}

/**
 * The directory portion of a baseURL's path, normalized to start and end with
 * `/`. Returns null when the baseURL is origin-only (the common case), which
 * is the signal that no path rewriting is needed.
 *
 * `https://host/examples/vue/dist/` → `/examples/vue/dist/`
 * `https://host/app`               → `/`            (no trailing slash: the
 *                                                    last segment is a file/
 *                                                    route, not a directory)
 * `https://host`                   → null
 */
export function baseUrlPathPrefix(baseURL: string | null): string | null {
    if (!baseURL) return null;
    let pathname: string;
    try {
        pathname = new URL(baseURL).pathname;
    } catch {
        return null;
    }
    // Playwright resolves relative paths with `new URL(path, baseURL)`, which
    // discards everything after the last `/`. Mirror that exactly.
    const prefix = pathname.slice(0, pathname.lastIndexOf("/") + 1);
    if (!prefix || prefix === "/") return null;
    return prefix;
}

/**
 * Re-root `page.goto('/path')` calls under a baseURL that is served from a
 * sub-path.
 *
 * Playwright resolves a root-absolute path against the baseURL's ORIGIN, not
 * its directory: with `baseURL: 'https://host/examples/vue/dist/'`, a
 * `page.goto('/')` lands on `https://host/` — a different app entirely. Every
 * generated locator then times out against a page the test never reached, and
 * the failure reads as "the app is broken" rather than "the URL was wrong".
 *
 * Framework-agnostic: applies to any app mounted under a path (a Vite `base`,
 * a Next.js `basePath`, an Angular `deploy-url`, a docs site under `/docs`).
 * A no-op for origin-only baseURLs, which is most projects.
 */
export function resolveGotoPathsAgainstBaseUrl(code: string, baseURL: string | null): string {
    const prefix = baseUrlPathPrefix(baseURL);
    if (!prefix || !code.includes("goto")) return code;
    return code.replace(
        /\b(page\.goto\(\s*)(['"`])(\/[^'"`\s]*)\2/g,
        (full, call: string, quote: string, target: string) => {
            if (target.startsWith(prefix)) return full;
            const rerooted = `${prefix}${target.slice(1)}`;
            return `${call}${quote}${rerooted}${quote}`;
        },
    );
}

/**
 * Rewrite absolute `page.goto('http://host/path')` calls to relative `/path`
 * when the origin matches the project's Playwright baseURL. Leaves cross-origin
 * navigations alone (those are usually the bug repair should flag).
 */
export function rewriteAbsoluteGotosToRelative(code: string, baseURL: string | null): string {
    if (!baseURL || !code.includes("goto")) return code;
    let origin: string;
    try {
        origin = new URL(baseURL).origin;
    } catch {
        return code;
    }
    return code.replace(
        /\b(page\.goto\(\s*)(['"`])(https?:\/\/[^'"`\s]+)\2/g,
        (full, prefix: string, quote: string, url: string) => {
            try {
                const parsed = new URL(url);
                if (parsed.origin !== origin) return full;
                const relative = `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
                return `${prefix}${quote}${relative}${quote}`;
            } catch {
                return full;
            }
        },
    );
}
