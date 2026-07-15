/**
 * Unit tests for the pure link / selector helpers used by the discovery
 * crawler. These cover the edge cases that historically produced
 * unparseable selectors (newlines in link text, embedded NULs, embedded
 * quotes) or broke origin checks (URLs with userinfo, IDN hosts,
 * unparseable URLs).
 */

import { describe, expect, it } from "vitest";

import {
    buildLinkSelector,
    escapeSelectorText,
    isLikelyRouteHref,
    mergeBlockedUrlIntoQueue,
    resolveRouteHref,
    safeOrigin,
    stripControlChars,
} from "../link-utils";

describe("stripControlChars", () => {
    it("replaces ASCII control chars with spaces", () => {
        // Build with charCodeAt so the file itself stays printable.
        const input = `a${String.fromCharCode(0x00)}b${String.fromCharCode(0x07)}c${String.fromCharCode(0x1f)}d${String.fromCharCode(0x7f)}e`;
        expect(stripControlChars(input)).toBe("a b c d e");
    });

    it("preserves printable ASCII", () => {
        expect(stripControlChars("hello world!")).toBe("hello world!");
    });

    it("preserves non-ASCII codepoints (emoji, accented, RTL)", () => {
        expect(stripControlChars("café 👋 שלום")).toBe("café 👋 שלום");
    });

    it("leaves SP (0x20) and printable boundary alone", () => {
        expect(stripControlChars("a b")).toBe("a b");
        expect(stripControlChars("~")).toBe("~");
    });
});

describe("escapeSelectorText", () => {
    it("escapes backslashes and double quotes", () => {
        expect(escapeSelectorText('he said "hi" \\ then left')).toBe(
            'he said \\"hi\\" \\\\ then left',
        );
    });

    it("strips control chars before escaping", () => {
        const input = `bad${String.fromCharCode(0x00)}data`;
        expect(escapeSelectorText(input)).toBe("bad data");
    });

    it("is a no-op for plain text", () => {
        expect(escapeSelectorText("just text")).toBe("just text");
    });
});

describe("buildLinkSelector", () => {
    it("prefers data-testid when present", () => {
        expect(buildLinkSelector("/foo", "Home", "nav-home")).toBe('a[data-testid="nav-home"]');
    });

    it("falls back to href when no testid", () => {
        expect(buildLinkSelector("/about", "About us", null)).toBe('a[href="/about"]');
    });

    it("uses :has-text when neither testid nor href is present", () => {
        expect(buildLinkSelector("", "Click me", null)).toBe('a:has-text("Click me")');
    });

    it("collapses whitespace and trims long link text", () => {
        const longText = "  hello\n\nworld  ";
        expect(buildLinkSelector("", longText, null)).toBe('a:has-text("hello world")');
    });

    it("falls back to a[href] when text is too long for has-text", () => {
        const long = "a".repeat(200);
        expect(buildLinkSelector("", long, null)).toBe("a[href]");
    });

    it("escapes embedded quotes in href values", () => {
        // Pathological but real — some CMS-generated hrefs contain quotes.
        expect(buildLinkSelector('/path"weird', "", null)).toBe('a[href="/path\\"weird"]');
    });

    it("does not produce an unparseable selector for control-char text", () => {
        const input = `bad${String.fromCharCode(0x00)}\nlink`;
        const selector = buildLinkSelector("", input, null);
        // The exact form is implementation detail — the contract is
        // that no NUL or raw newline survives into the selector string.
        expect(selector).not.toContain(String.fromCharCode(0x00));
        expect(selector).not.toContain("\n");
    });

    it("returns the safe a[href] fallback when everything is empty", () => {
        expect(buildLinkSelector("", "", null)).toBe("a[href]");
    });

    it("builds non-anchor selectors for SPA buttons with data-testid", () => {
        expect(
            buildLinkSelector("/settings", "Settings", "nav-settings", { tagName: "button" }),
        ).toBe('button[data-testid="nav-settings"]');
    });

    it("uses role+text for role=link without href", () => {
        expect(buildLinkSelector("", "Settings", null, { tagName: "div", role: "link" })).toBe(
            '[role="link"]:has-text("Settings")',
        );
    });
});

describe("isLikelyRouteHref / resolveRouteHref", () => {
    it("accepts root-relative and absolute URLs", () => {
        expect(isLikelyRouteHref("/settings")).toBe(true);
        expect(isLikelyRouteHref("https://app.example.com/x")).toBe(true);
        expect(isLikelyRouteHref("./relative")).toBe(true);
    });

    it("accepts bare document filenames used by static documentation sites", () => {
        expect(isLikelyRouteHref("ch01-00-getting-started.html")).toBe(true);
        expect(isLikelyRouteHref("index.html?edition=2024")).toBe(true);
        expect(isLikelyRouteHref("guide.xhtml")).toBe(true);
    });

    it("rejects actions and fragments", () => {
        expect(isLikelyRouteHref("submit")).toBe(false);
        expect(isLikelyRouteHref("styles.css")).toBe(false);
        expect(isLikelyRouteHref("#section")).toBe(false);
        expect(isLikelyRouteHref("mailto:a@b.c")).toBe(false);
        expect(isLikelyRouteHref("")).toBe(false);
    });

    it("picks the first route-like attribute", () => {
        expect(resolveRouteHref({ href: "#", "data-to": "/team" })).toBe("/team");
        expect(resolveRouteHref({ "data-path": "/billing", href: null })).toBe("/billing");
        expect(resolveRouteHref({ href: "submit" })).toBeNull();
    });
});

describe("mergeBlockedUrlIntoQueue", () => {
    const normalize = (url: string) => url.replace(/\/$/, "") || "/";

    it("prepends blockedAtUrl when missing from the snapshot", () => {
        const merged = mergeBlockedUrlIntoQueue(
            [{ url: "https://app/a", uniqueKey: "https://app/a" }],
            "https://app/login",
            normalize,
        );
        expect(merged[0]?.url).toBe("https://app/login");
        expect(merged).toHaveLength(2);
    });

    it("does not duplicate an already-queued blocked URL", () => {
        const merged = mergeBlockedUrlIntoQueue(
            [{ url: "https://app/login", uniqueKey: "https://app/login" }],
            "https://app/login",
            normalize,
        );
        expect(merged).toHaveLength(1);
    });

    it("returns only the blocked URL when the queue snapshot is empty", () => {
        const merged = mergeBlockedUrlIntoQueue([], "https://app/blocked", normalize);
        expect(merged).toEqual([
            {
                url: "https://app/blocked",
                uniqueKey: "https://app/blocked",
                userData: { depth: 0, resumeBlocked: true },
            },
        ]);
    });

    it("leaves the queue unchanged when blockedAtUrl is null", () => {
        const merged = mergeBlockedUrlIntoQueue(
            [{ url: "https://app/a", uniqueKey: "https://app/a" }],
            null,
            normalize,
        );
        expect(merged).toHaveLength(1);
        expect(merged[0]?.url).toBe("https://app/a");
    });
});

describe("safeOrigin", () => {
    it("returns the origin for a well-formed URL", () => {
        expect(safeOrigin("https://example.com/path?x=1#y")).toBe("https://example.com");
    });

    it("includes a non-default port in the origin", () => {
        expect(safeOrigin("http://localhost:7101/api")).toBe("http://localhost:7101");
    });

    it("treats https default 443 as part of the standard origin", () => {
        // URL parsing canonicalizes :443 out of the origin string.
        expect(safeOrigin("https://example.com:443/x")).toBe("https://example.com");
    });

    it("returns null for unparseable input", () => {
        expect(safeOrigin("not a url")).toBeNull();
        expect(safeOrigin("")).toBeNull();
    });

    it("is robust against userinfo in the URL", () => {
        // Origin should not include credentials.
        expect(safeOrigin("https://user:pass@example.com/x")).toBe("https://example.com");
    });
});
