import { expect, test } from "@playwright/test";

test("example test - home page loads", async ({ page }) => {
    // Navigate to your application
    await page.goto("/");

    // Example: Check if the page loads successfully
    await expect(page).toHaveTitle(/.*@raiken\/playground-auth.*/i);

    // Add your test steps here:
    // await page.click('button[data-testid="my-button"]');
    // await expect(page.getByText('Success!')).toBeVisible();
});

test("example test - navigation works", async ({ page }) => {
    await page.goto("/");

    // Test navigation or interactions
    // await page.click('a[href="/about"]');
    // await expect(page).toHaveURL(/.*about/);
});
