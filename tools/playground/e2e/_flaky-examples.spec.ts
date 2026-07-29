// This file is intentionally bad. It exists so `raiken doctor` has obvious
// findings to report against the playground. Do not copy these patterns
// into real tests.

import { expect, test } from "@playwright/test";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.describe("flaky examples (intentional)", () => {
    test.skip("disabled forever", async () => {
        // no-skip-always: this test is permanently skipped
        expect(true).toBe(true);
    });

    test("uses page.waitForTimeout", async ({ page }) => {
        await page.goto("/");
        await page.waitForTimeout(500);
        await expect(page.getByTestId("home-page")).toBeVisible();
    });

    test("hand-rolled sleep", async ({ page }) => {
        await page.goto("/");
        await sleep(250);
        // await page.goto('/dashboard')
        await expect(page.getByTestId("home-page")).toBeVisible();
    });

    test("trivial assertion", async () => {
        // no-trivial-assertion: assertion has no relation to the feature
        expect(true).toBe(true);
    });
});
