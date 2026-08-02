import { describe, expect, it } from "vitest";
import {
    assessIntentCoverage,
    extractAcs,
    extractIntentCriteria,
    significantTokens,
    splitScenarioClauses,
} from "../cover/intent-coverage";

describe("extractAcs", () => {
    it("prefers AC-prefixed lines", () => {
        expect(
            extractAcs(`
        AC1: User can log in with email
        AC2: User sees a welcome banner
        - [ ] Stray checkbox
      `),
        ).toEqual(["User can log in with email", "User sees a welcome banner"]);
    });
});

describe("intent criteria splitting", () => {
    it("splits free text on then", () => {
        expect(
            splitScenarioClauses("sign in with email then see the dashboard"),
        ).toEqual(["sign in with email", "see the dashboard"]);
    });

    it("uses AC lines when present", () => {
        const criteria = extractIntentCriteria(`
      AC-1: Add a product to the cart
      AC-2: Proceed to checkout
    `);
        expect(criteria.map((c) => c.text)).toEqual([
            "Add a product to the cart",
            "Proceed to checkout",
        ]);
        expect(criteria[0]?.tokens).toContain("product");
        expect(criteria[0]?.tokens).toContain("cart");
    });

    it("drops stopwords from tokens", () => {
        expect(significantTokens("the user can see the welcome banner")).toEqual([
            "welcome",
            "banner",
        ]);
    });
});

describe("assessIntentCoverage", () => {
    const coveredDraft = `import { test, expect } from '@playwright/test';
test('cart', async ({ page }) => {
  await page.goto('/product/1');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByTestId('cart-link')).toContainText('1');
  await page.getByRole('link', { name: 'Checkout' }).click();
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
});
`;

    it("passes when assertions cover each AC", () => {
        const result = assessIntentCoverage(
            `AC-1: Add a product to the cart
AC-2: Proceed to checkout`,
            coveredDraft,
        );
        expect(result.uncovered).toEqual([]);
        expect(result.reasons).toEqual([]);
    });

    it("flags a missing outcome assertion", () => {
        const draft = `import { test, expect } from '@playwright/test';
test('login', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('a@b.com');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
});
`;
        const result = assessIntentCoverage(
            "sign in with email then see the welcome banner",
            draft,
        );
        expect(result.uncovered.length).toBeGreaterThan(0);
        expect(result.reasons.some((r) => /welcome banner/i.test(r))).toBe(true);
    });

    it("flags a draft with no assertions at all", () => {
        const draft = `import { test } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Go' }).click();
});
`;
        const result = assessIntentCoverage("click Go then see success message", draft);
        expect(result.uncovered.length).toBe(result.criteria.length);
        expect(result.reasons.length).toBeGreaterThan(0);
    });
});
