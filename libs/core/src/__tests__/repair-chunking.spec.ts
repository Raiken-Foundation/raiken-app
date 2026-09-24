import { describe, expect, it } from "vitest";
import { chunkTestCodeForRepair } from "../testing/interpreter";

const TEN_TEST_SPEC = `import { test, expect } from '@playwright/test';

test.use({ storageState: ".raiken/auth-state.json" });

test.describe('Contract facts', () => {
  test('fact one', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toContainText('one');
  });

  test('fact two', async ({ page }) => {
    await page.goto('/two');
    await expect(page.locator('body')).toContainText('two');
  });

  test('fact three', async ({ page }) => {
    await page.goto('/three');
    await expect(page.locator('body')).toContainText('three');
  });

  test('fact four', async ({ page }) => {
    await page.goto('/four');
    await expect(page.locator('body')).toContainText('four');
  });
});
`;

describe("chunkTestCodeForRepair", () => {
    it("keeps imports, setup, and only the failing test block", () => {
        const failingLine = TEN_TEST_SPEC.split("\n").findIndex((l) => l.includes("fact two")) + 1;
        const chunk = chunkTestCodeForRepair(TEN_TEST_SPEC, [failingLine]);

        expect(chunk).toContain("from '@playwright/test'");
        expect(chunk).toContain("test.use({ storageState");
        expect(chunk).toContain("test.describe('Contract facts'");
        expect(chunk).toContain("fact two");
        expect(chunk).toContain("omitted — other tests");
        expect(chunk).not.toContain("fact one");
        expect(chunk).not.toContain("fact four");
    });

    it("is a verbatim slice — every kept line matches the original file", () => {
        const failingLine = TEN_TEST_SPEC.split("\n").findIndex((l) => l.includes("fact three")) + 1;
        const chunk = chunkTestCodeForRepair(TEN_TEST_SPEC, [failingLine]);
        for (const line of chunk.split("\n")) {
            if (line.startsWith("// …")) continue;
            expect(TEN_TEST_SPEC, `line drifted: ${line}`).toContain(line);
        }
    });

    it("includes every failing block when multiple tests fail", () => {
        const lines = TEN_TEST_SPEC.split("\n");
        const one = lines.findIndex((l) => l.includes("fact one")) + 1;
        const four = lines.findIndex((l) => l.includes("fact four")) + 1;
        const chunk = chunkTestCodeForRepair(TEN_TEST_SPEC, [one, four]);
        expect(chunk).toContain("fact one");
        expect(chunk).toContain("fact four");
        expect(chunk).not.toContain("fact two");
    });

    it("falls back to the full text when no failure line is inside a test", () => {
        const chunk = chunkTestCodeForRepair("import { test } from 'x';\n// no tests\n", [999]);
        expect(chunk).toContain("import { test }");
        expect(chunk).toContain("no tests");
    });

    it("handles nested braces inside the failing block", () => {
        const nested = `import { test, expect } from '@playwright/test';

test('nested', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Go' })).toBeVisible();
  const fn = () => { return { a: 1 }; };
  await page.evaluate(fn);
});
`;
        const chunk = chunkTestCodeForRepair(nested, [4]);
        expect(chunk).toContain("page.evaluate(fn);");
        expect(chunk).toContain("});");
    });
});
