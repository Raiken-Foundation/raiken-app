import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../url-utils";

describe("normalizeUrl", () => {
    it("strips the fragment", () => {
        expect(normalizeUrl("https://example.com/path#section")).toBe("https://example.com/path");
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
});
