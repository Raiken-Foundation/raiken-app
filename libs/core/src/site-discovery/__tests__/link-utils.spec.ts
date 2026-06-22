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
