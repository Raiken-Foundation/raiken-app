import type { Page } from "playwright";

export type ExtractedLink = {
    href: string;
    text: string;
    role: string | null;
    dataTestId: string | null;
    tagName: string | null;
};

/**
 * Pull all candidate navigation elements from the page in a single
 * `evaluate()` call. Avoids the N+1 round-trips of iterating Locators
 * (each `getAttribute` is a CDP message), and avoids stale-element
 * handle errors when the SPA mutates the DOM mid-extraction.
 */
export async function extractLinksFromPage(page: Page): Promise<ExtractedLink[]> {
    try {
        return await page.evaluate(() => {
            const ROUTE_ATTRS = [
                "href",
                "data-href",
                "data-url",
                "data-to",
                "data-path",
                "to",
            ] as const;
            const MAX = 250;

            const isLikelyRoute = (value: string): boolean => {
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
                if (
                    /^(https?:)?\/\//i.test(v) ||
                    v.startsWith("/") ||
                    v.startsWith("./") ||
                    v.startsWith("../")
                ) {
                    return true;
                }
                const pathWithoutQuery = v.split(/[?#]/, 1)[0] ?? v;
                if (/^[A-Za-z0-9._~-]+\.(?:html?|xhtml|php|aspx?|jsp)$/i.test(pathWithoutQuery)) {
                    return true;
                }
                return /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]*)*$/.test(v) && v.includes("/");
            };

            const resolveHref = (el: Element): string => {
                for (const name of ROUTE_ATTRS) {
                    const raw = el.getAttribute(name);
                    if (raw && isLikelyRoute(raw)) return raw.trim();
                }
                return "";
            };

            const isVisible = (el: HTMLElement): boolean => {
                const style = window.getComputedStyle(el);
                if (style.display === "none" || style.visibility === "hidden") return false;
                if (style.opacity === "0") return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };

            const selectors = [
                "a[href]",
                "a[to]",
                "[data-href]",
                "[data-url]",
                "[data-to]",
                "[data-path]",
                '[role="link"]',
                "nav button[data-href], nav button[data-url], nav button[data-to], nav button[data-path]",
                'nav [role="button"][data-href], nav [role="button"][data-to], nav [role="button"][data-path]',
                'nav [role="tab"][data-href], nav [role="tab"][data-to], nav [role="tab"][data-path]',
                'nav [role="menuitem"][data-href], nav [role="menuitem"][data-to], nav [role="menuitem"][data-path]',
            ];

            const out: Array<{
                href: string;
                text: string;
                role: string | null;
                dataTestId: string | null;
                tagName: string | null;
            }> = [];
            const seen = new Set<Element>();
            const seenHrefs = new Set<string>();

            // Pierce shadow DOM (Lit/Stencil/Material web components): a
            // plain document query misses every link inside a shadow root,
            // silently dropping whole route subtrees (review finding).
            // Collect the document plus all OPEN shadow roots once, then run
            // each selector against every root — still a single evaluate
            // call with no CDP round-trips.
            const roots: ParentNode[] = [document];
            const pending: ParentNode[] = [document];
            while (pending.length > 0) {
                const root = pending.pop() as ParentNode;
                for (const el of Array.from(root.querySelectorAll("*"))) {
                    const shadow = (el as Element).shadowRoot;
                    if (shadow) {
                        roots.push(shadow);
                        pending.push(shadow);
                    }
                }
            }

            for (const sel of selectors) {
                if (out.length >= MAX) break;
                for (const root of roots) {
                    if (out.length >= MAX) break;
                    const nodes = root.querySelectorAll(sel);
                    for (const node of Array.from(nodes)) {
                        if (out.length >= MAX) break;
                        if (seen.has(node)) continue;
                        seen.add(node);
                        const el = node as HTMLElement;
                        if (!isVisible(el)) continue;
                        const href = resolveHref(el);
                        if (!href) continue;
                        if (seenHrefs.has(href)) continue;
                        seenHrefs.add(href);
                        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
                        out.push({
                            href,
                            text: text.slice(0, 200),
                            role: el.getAttribute("role"),
                            dataTestId: el.getAttribute("data-testid"),
                            tagName: el.tagName ? el.tagName.toLowerCase() : null,
                        });
                    }
                }
            }
            return out;
        });
    } catch {
        return [];
    }
}
