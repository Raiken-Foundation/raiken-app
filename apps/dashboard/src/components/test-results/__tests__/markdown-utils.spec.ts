import { describe, expect, it } from "vitest";
import { safeMarkdownHref } from "../model/markdown-utils";

describe("safeMarkdownHref", () => {
    it("allows http and https links", () => {
        expect(safeMarkdownHref("https://example.com/docs")).toBe("https://example.com/docs");
    });

    it("rejects javascript and data URLs", () => {
        expect(safeMarkdownHref("javascript:alert(1)")).toBeNull();
        expect(safeMarkdownHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    });

    it("preserves relative hrefs when parsed against the local base", () => {
        expect(safeMarkdownHref("/docs/guide")).toBe("/docs/guide");
    });
});
