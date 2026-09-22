import { describe, expect, it } from "vitest";
import { fragmentAwareResolvedUrl, normalizeUrl } from "../url-utils";

describe("fragmentAwareResolvedUrl", () => {
    it("prefers the response URL for non-fragment requests", () => {
        expect(
            fragmentAwareResolvedUrl("http://x/a", "http://x/b", "http://x/b#/routed"),
        ).toBe("http://x/b");
    });

    it("uses the live page URL (with fragment) for hash-route requests", () => {
        expect(
            fragmentAwareResolvedUrl(
                "http://x/#/stats",
                "http://x/",
                "http://x/#/stats",
            ),
        ).toBe("http://x/#/stats");
    });

    it("reflects a client-side hash redirect in the page URL", () => {
        expect(
            fragmentAwareResolvedUrl(
                "http://x/#/stats",
                "http://x/",
                "http://x/#/login",
            ),
        ).toBe("http://x/#/login");
    });

    it("falls back to the response URL when the app cleared the hash", () => {
        expect(fragmentAwareResolvedUrl("http://x/#/stats", "http://x/", "http://x/")).toBe(
            "http://x/",
        );
    });

    it("falls back to the request URL when both fallbacks are null", () => {
        expect(fragmentAwareResolvedUrl("http://x/#/stats", null, null)).toBe("http://x/#/stats");
    });
});

describe("normalizeUrl", () => {
    it("strips the fragment", () => {
        expect(normalizeUrl("https://example.com/path#section")).toBe("https://example.com/path");
    });

    it("keeps hash routes distinct when preserveHashRoutes is set", () => {
        const base = normalizeUrl("https://example.com/app", { preserveHashRoutes: true });
        const stats = normalizeUrl("https://example.com/app#/stats", { preserveHashRoutes: true });
        const notes = normalizeUrl("https://example.com/app#/notes", { preserveHashRoutes: true });
        expect(stats).toBe("https://example.com/app#/stats");
        expect(notes).toBe("https://example.com/app#/notes");
        expect(base).not.toBe(stats);
        expect(stats).not.toBe(notes);
    });

    it("still strips fragments by default even when the fragment looks like a route", () => {
        expect(normalizeUrl("https://example.com/app#/stats")).toBe("https://example.com/app");
    });

    it("keeps hash routes distinct from the bare root page", () => {
        expect(normalizeUrl("https://example.com/#/login", { preserveHashRoutes: true })).toBe(
            "https://example.com/#/login",
        );
        expect(normalizeUrl("https://example.com/", { preserveHashRoutes: true })).toBe(
            "https://example.com/",
        );
    });

    it("keeps both query and hash when both preserve options are set", () => {
        expect(
            normalizeUrl("https://example.com/x?b=2&a=1#/tab", {
                preserveQueryParams: true,
                preserveHashRoutes: true,
            }),
        ).toBe("https://example.com/x?a=1&b=2#/tab");
    });

    it("strips query params by default", () => {
        expect(normalizeUrl("https://example.com/search?q=hello&page=2")).toBe(
            "https://example.com/search",
        );
    });

    it("removes a trailing slash except on the root", () => {
        expect(normalizeUrl("https://example.com/path/")).toBe("https://example.com/path");
        expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
    });

    it("collapses query-only differences to the same identity by default", () => {
        expect(normalizeUrl("https://example.com/x?a=1")).toBe(
            normalizeUrl("https://example.com/x?a=2"),
        );
    });

    it("keeps query params (sorted) when preserveQueryParams is set", () => {
        expect(normalizeUrl("https://example.com/x?b=2&a=1", { preserveQueryParams: true })).toBe(
            "https://example.com/x?a=1&b=2",
        );
    });

    it("treats different query values as distinct when preserving", () => {
        const one = normalizeUrl("https://example.com/x?id=1", { preserveQueryParams: true });
        const two = normalizeUrl("https://example.com/x?id=2", { preserveQueryParams: true });
        expect(one).not.toBe(two);
    });

    it("returns the raw string for an unparsable URL", () => {
        expect(normalizeUrl("not a url")).toBe("not a url");
    });

    it("collapses index.html onto the directory URL", () => {
        expect(normalizeUrl("https://example.com/index.html")).toBe("https://example.com/");
        expect(normalizeUrl("https://example.com/docs/index.html")).toBe(
            "https://example.com/docs",
        );
        expect(normalizeUrl("https://example.com/docs/index.htm")).toBe("https://example.com/docs");
    });

    it("keeps distinct pages distinct (suffix match only)", () => {
        expect(normalizeUrl("https://example.com/index.htmlify")).toBe(
            "https://example.com/index.htmlify",
        );
        expect(normalizeUrl("https://example.com/my-index.html/page")).toBe(
            "https://example.com/my-index.html/page",
        );
    });

    it("still strips the query after collapsing the index file", () => {
        expect(normalizeUrl("https://example.com/index.html?a=1")).toBe("https://example.com/");
    });
});
