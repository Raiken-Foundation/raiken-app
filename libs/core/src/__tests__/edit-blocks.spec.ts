import { describe, expect, it } from "vitest";
import {
    applyEditBlocks,
    type EditBlock,
    parseEditBlocks,
    stripEditMarkers,
} from "../testing/edit-blocks";

describe("parseEditBlocks", () => {
    it("parses a single well-formed block", () => {
        const text = [
            "<<<<<<< SEARCH",
            "const a = 1;",
            "=======",
            "const a = 2;",
            ">>>>>>> REPLACE",
        ].join("\n");
        const blocks = parseEditBlocks(text);
        expect(blocks).toEqual<EditBlock[]>([{ search: "const a = 1;", replace: "const a = 2;" }]);
    });

    it("parses multiple blocks and ignores surrounding prose/fences", () => {
        const text = [
            "Here are the edits:",
            "```",
            "<<<<<<< SEARCH",
            "foo();",
            "=======",
            "bar();",
            ">>>>>>> REPLACE",
            "```",
            "and another",
            "<<<<<<< SEARCH",
            "old",
            "=======",
            "new",
            ">>>>>>> REPLACE",
        ].join("\n");
        const blocks = parseEditBlocks(text);
        expect(blocks).toHaveLength(2);
        expect(blocks[1]).toEqual({ search: "old", replace: "new" });
    });

    it("supports multi-line search and replace", () => {
        const text = [
            "<<<<<<< SEARCH",
            "line1",
            "line2",
            "=======",
            "line1",
            "line2-changed",
            "line3-added",
            ">>>>>>> REPLACE",
        ].join("\n");
        const blocks = parseEditBlocks(text);
        expect(blocks[0].search).toBe("line1\nline2");
        expect(blocks[0].replace).toBe("line1\nline2-changed\nline3-added");
    });

    it("returns [] when there are no blocks (full-file output)", () => {
        expect(parseEditBlocks("import { test } from '@playwright/test';")).toEqual([]);
        expect(parseEditBlocks("")).toEqual([]);
    });

    it("supports an empty replace (deletion)", () => {
        const text = ["<<<<<<< SEARCH", "remove me", "=======", ">>>>>>> REPLACE"].join("\n");
        const blocks = parseEditBlocks(text);
        expect(blocks[0]).toEqual({ search: "remove me", replace: "" });
    });
});

describe("applyEditBlocks", () => {
    const original = [
        "import { test } from '@playwright/test';",
        "",
        "const url = '/login';",
        "",
    ].join("\n");

    it("applies an exact-match block", () => {
        const result = applyEditBlocks(original, [
            { search: "const url = '/login';", replace: "const url = '/signin';" },
        ]);
        expect(result.appliedCount).toBe(1);
        expect(result.failedBlocks).toHaveLength(0);
        expect(result.content).toContain("const url = '/signin';");
        expect(result.content).not.toContain("/login");
    });

    it("matches despite trailing-whitespace differences", () => {
        const withTrailing = "const url = '/login';   ";
        const result = applyEditBlocks(`x\n${withTrailing}\ny`, [
            { search: "const url = '/login';", replace: "const url = '/signin';" },
        ]);
        expect(result.appliedCount).toBe(1);
        expect(result.content).toContain("const url = '/signin';");
    });

    it("applies multiple blocks sequentially", () => {
        const src = ["a();", "b();", "c();"].join("\n");
        const result = applyEditBlocks(src, [
            { search: "a();", replace: "A();" },
            { search: "c();", replace: "C();" },
        ]);
        expect(result.appliedCount).toBe(2);
        expect(result.content).toBe(["A();", "b();", "C();"].join("\n"));
    });

    it("reports blocks that cannot be matched and leaves content intact for them", () => {
        const result = applyEditBlocks(original, [
            { search: "const url = '/login';", replace: "const url = '/signin';" },
            { search: "this text is not present", replace: "whatever" },
        ]);
        expect(result.appliedCount).toBe(1);
        expect(result.failedBlocks).toHaveLength(1);
        expect(result.failedBlocks[0].search).toBe("this text is not present");
        expect(result.content).toContain("/signin");
    });

    it("handles deletion via empty replace", () => {
        const src = ["keep();", "await page.waitForTimeout(1000);", "keep2();"].join("\n");
        const result = applyEditBlocks(src, [
            { search: "await page.waitForTimeout(1000);\n", replace: "" },
        ]);
        // The exact search includes the trailing newline so the whole line is removed.
        expect(result.content).toContain("keep();");
        expect(result.content).toContain("keep2();");
        expect(result.content).not.toContain("waitForTimeout");
    });
});

describe("stripEditMarkers", () => {
    it("removes stray markers left by a malformed/unterminated block", () => {
        const text = [
            "<<<<<<< SEARCH",
            "import { test, expect } from '@playwright/test';",
            "=======",
            "test('login', async ({ page }) => {});",
        ].join("\n");
        expect(stripEditMarkers(text)).toBe(
            [
                "import { test, expect } from '@playwright/test';",
                "test('login', async ({ page }) => {});",
            ].join("\n"),
        );
    });

    it("leaves text without any block markers untouched (coincidental divider)", () => {
        const text = ["// =======", "const banner = '=======';"].join("\n");
        expect(stripEditMarkers(text)).toBe(text);
    });
});
