import { describe, expect, it } from "vitest";
import { cleanGeneratedTestCode, hardenNavigationWaits } from "../utils";

describe("cleanGeneratedTestCode", () => {
    it("strips a single fenced block and its language tag", () => {
        const raw = "```ts\nimport { test } from '@playwright/test';\n```";
        expect(cleanGeneratedTestCode(raw)).toBe("import { test } from '@playwright/test';\n");
    });

    it("returns trimmed content with a trailing newline when there is no fence", () => {
        expect(cleanGeneratedTestCode("  const a = 1;  ")).toBe("const a = 1;\n");
    });

    it("picks the largest test-like block when prose contains multiple fences", () => {
        const raw = [
            "Here is a quick illustration:",
            "```ts",
            "const x = 1;",
            "```",
            "And here is the full test:",
            "```ts",
            "import { test, expect } from '@playwright/test';",
            "test('does a thing', async ({ page }) => {",
            "  await page.goto('/');",
            "  await expect(page).toHaveTitle(/Home/);",
            "});",
            "```",
        ].join("\n");

        const cleaned = cleanGeneratedTestCode(raw);
        expect(cleaned).toContain("import { test, expect }");
        expect(cleaned).toContain("does a thing");
        // The small non-test snippet must not be what we kept.
        expect(cleaned.startsWith("const x = 1;")).toBe(false);
    });

    it("handles a dangling opening fence without a close", () => {
        const raw = "```ts\nimport { test } from '@playwright/test';";
        expect(cleanGeneratedTestCode(raw)).toBe("import { test } from '@playwright/test';\n");
    });

    it("normalizes CRLF and strips trailing whitespace per line", () => {
        const raw = "line1  \r\nline2\t\r\n";
        expect(cleanGeneratedTestCode(raw)).toBe("line1\nline2\n");
    });

    it("hardens navigation waits when cleaning", () => {
        const raw =
            "```ts\nawait page.goto('/overview');\nawait page.waitForLoadState('networkidle');\n```";
        const cleaned = cleanGeneratedTestCode(raw);
        expect(cleaned).toContain(`page.goto('/overview', { waitUntil: "domcontentloaded" })`);
        expect(cleaned).toContain(`waitForLoadState("domcontentloaded")`);
        expect(cleaned).not.toContain("networkidle");
    });
});

describe("hardenNavigationWaits", () => {
    it("adds domcontentloaded to bare string gotos", () => {
        expect(hardenNavigationWaits(`await page.goto("/x");`)).toBe(
            `await page.goto("/x", { waitUntil: "domcontentloaded" });`,
        );
        expect(hardenNavigationWaits(`page.goto('/y')`)).toBe(
            `page.goto('/y', { waitUntil: "domcontentloaded" })`,
        );
    });

    it("leaves gotos that already pass options untouched", () => {
        const src = `page.goto("/x", { waitUntil: "commit" })`;
        expect(hardenNavigationWaits(src)).toBe(src);
    });

    it("downgrades networkidle in both wait styles", () => {
        expect(hardenNavigationWaits(`page.waitForLoadState("networkidle")`)).toBe(
            `page.waitForLoadState("domcontentloaded")`,
        );
        expect(hardenNavigationWaits(`page.goto("/x", { waitUntil: 'networkidle' })`)).toContain(
            `waitUntil: "domcontentloaded"`,
        );
    });

    it("does not touch non-networkidle load states", () => {
        const src = `await page.waitForLoadState("domcontentloaded")`;
        expect(hardenNavigationWaits(src)).toBe(src);
    });
});
