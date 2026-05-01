/**
 * Pure helpers used by the discovery crawler for link extraction +
 * selector synthesis.
 *
 * Kept out of `crawler.ts` so they can be unit-tested without spinning
 * up Playwright / Crawlee.
 */

/**
 * Strip ASCII control chars (NUL through US, plus DEL) from a string by
 * replacing them with a space.
 *
 * Implemented via a per-codepoint check rather than a regex literal
 * because the `no-control-regex` lint rule (rightly) flags control-char
 * regex classes — and we don't actually need a regex here.
 */
export function stripControlChars(value: string): string {
    let out = "";
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) {
            out += " ";
        } else {
            out += value[i];
        }
    }
    return out;
}

/**
 * Escape a string for use inside a Playwright attribute-selector value
 * or `:has-text("...")` argument. Strips control chars, then escapes
 * the two characters that the selector mini-language treats as syntax:
 * backslash and the surrounding double-quote.
 */
export function escapeSelectorText(value: string): string {
    return stripControlChars(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a Playwright-compatible selector for a discovered link, in
 * priority order:
 *
 *   1. `data-testid` (most stable across UI rewrites).
 *   2. `href` attribute (stable for non-SPA navigation).
 *   3. Visible text (best-effort; clamped to 80 chars and stripped of
 *      whitespace + control chars to avoid producing an unparseable
 *      selector).
 *   4. Fallback to a generic `a[href]` so callers always get *some*
 *      usable selector.
 */
export function buildLinkSelector(
    href: string,
    linkText: string,
    dataTestId: string | null,
): string {
    if (dataTestId) {
        return `a[data-testid="${escapeSelectorText(dataTestId)}"]`;
    }

    if (href) {
        return `a[href="${escapeSelectorText(href)}"]`;
    }

    const trimmed = stripControlChars(linkText).replace(/\s+/g, " ").trim();
    if (trimmed && trimmed.length <= 80) {
        return `a:has-text("${escapeSelectorText(trimmed)}")`;
    }

    return "a[href]";
}

/** Returns the URL's origin, or `null` if the URL is unparseable. */
export function safeOrigin(url: string): string | null {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}
