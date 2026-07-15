/**
 * Pure helpers used by the discovery crawler for link extraction +
 * selector synthesis.
 *
 * Kept out of `crawler.ts` so they can be unit-tested without spinning
 * up Playwright / Crawlee.
 */

/**
 * Attribute names that commonly hold a client-side route on SPA elements
 * that are not plain `<a href>`. Keep in sync with the `page.evaluate`
 * body in `SiteDiscovery.extractLinks`.
 */
export const ROUTE_ATTRS = ["href", "data-href", "data-url", "data-to", "data-path", "to"] as const;

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
 * True when a candidate attribute value looks like a navigable route
 * rather than an action label (`submit`, `true`, empty, etc.).
 */
export function isLikelyRouteHref(value: string): boolean {
    const v = value.trim();
    if (!v) return false;
    if (
        v.startsWith("#") ||
        v.startsWith("mailto:") ||
        v.startsWith("tel:") ||
        v.startsWith("javascript:") ||
        v.startsWith("data:")
    ) {
        return false;
    }
    // Absolute / protocol-relative / root-relative / relative path.
    if (
        /^(https?:)?\/\//i.test(v) ||
        v.startsWith("/") ||
        v.startsWith("./") ||
        v.startsWith("../")
    ) {
        return true;
    }
    // Document sites commonly use a bare filename relative to the current
    // directory (`chapter-01.html`). It has no slash, but is unambiguously a
    // navigation target rather than an action label such as `submit`.
    const pathWithoutQuery = v.split(/[?#]/, 1)[0] ?? v;
    if (/^[A-Za-z0-9._~-]+\.(?:html?|xhtml|php|aspx?|jsp)$/i.test(pathWithoutQuery)) {
        return true;
    }
    // Bare multi-segment path used by some routers (`users/1`).
    if (/^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]*)*$/.test(v) && v.includes("/")) {
        return true;
    }
    return false;
}

/**
 * Pick the first route-like attribute from a map of element attributes.
 */
export function resolveRouteHref(
    attrs: Partial<Record<(typeof ROUTE_ATTRS)[number], string | null | undefined>>,
): string | null {
    for (const name of ROUTE_ATTRS) {
        const raw = attrs[name];
        if (typeof raw === "string" && isLikelyRouteHref(raw)) {
            return raw.trim();
        }
    }
    return null;
}

/**
 * Build a Playwright-compatible selector for a discovered link, in
 * priority order:
 *
 *   1. `data-testid` (most stable across UI rewrites).
 *   2. Route attribute (`href` / `data-to` / …) on the real tag.
 *   3. Visible text (best-effort; clamped to 80 chars).
 *   4. Fallback to a generic navigable selector.
 */
export function buildLinkSelector(
    href: string,
    linkText: string,
    dataTestId: string | null,
    extras: { tagName?: string | null; role?: string | null } = {},
): string {
    const tag = (extras.tagName || "a").toLowerCase();
    const role = extras.role?.toLowerCase() || null;

    if (dataTestId) {
        return `${tag}[data-testid="${escapeSelectorText(dataTestId)}"]`;
    }

    if (href) {
        const escaped = escapeSelectorText(href);
        // Prefer the attribute that actually held the route when it wasn't href.
        if (tag === "a") {
            return `a[href="${escaped}"]`;
        }
        return `${tag}[data-href="${escaped}"], ${tag}[data-to="${escaped}"], ${tag}[data-path="${escaped}"]`;
    }

    const trimmed = stripControlChars(linkText).replace(/\s+/g, " ").trim();
    if (trimmed && trimmed.length <= 80) {
        const textSel = `${tag}:has-text("${escapeSelectorText(trimmed)}")`;
        if (role) {
            return `[role="${escapeSelectorText(role)}"]:has-text("${escapeSelectorText(trimmed)}")`;
        }
        return textSel;
    }

    if (role) return `[role="${escapeSelectorText(role)}"]`;
    return tag === "a" ? "a[href]" : tag;
}

/**
 * Merge a blocked/resume URL into a persisted queue snapshot so resume
 * always retries the pause point even when it was marked handled mid-pause.
 */
export function mergeBlockedUrlIntoQueue(
    queue: Array<{ url: string; uniqueKey?: string; userData?: Record<string, unknown> }>,
    blockedAtUrl: string | null | undefined,
    normalize: (url: string) => string,
): Array<{ url: string; uniqueKey: string; userData?: Record<string, unknown> }> {
    const out = queue
        .filter((item) => Boolean(item?.url))
        .map((item) => ({
            url: item.url,
            uniqueKey: item.uniqueKey ?? normalize(item.url),
            userData: item.userData,
        }));

    if (!blockedAtUrl) return out;

    const key = normalize(blockedAtUrl);
    if (out.some((item) => item.uniqueKey === key || normalize(item.url) === key)) {
        return out;
    }

    out.unshift({
        url: blockedAtUrl,
        uniqueKey: key,
        userData: { depth: 0, resumeBlocked: true },
    });
    return out;
}

/** Returns the URL's origin, or `null` if the URL is unparseable. */
export function safeOrigin(url: string): string | null {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}
