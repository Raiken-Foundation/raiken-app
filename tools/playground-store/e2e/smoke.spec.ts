import { expect, test } from "@playwright/test";

test.describe("Bazaar smoke", () => {
    test("add to cart, coupon, checkout, order confirmed", async ({ page }) => {
        await page.goto("/");
        await expect(page.getByTestId("catalog-page")).toBeVisible();
        await page.getByTestId("product-nova-headphones").click();
        await page.getByTestId("add-to-cart").click();
        await expect(page.getByTestId("cart-count")).toHaveText("1");

        await page.getByTestId("nav-cart").click();
        await page.getByTestId("coupon-input").fill("WELCOME10");
        await page.getByTestId("coupon-apply").click();
        await expect(page.getByTestId("discount")).toContainText("$12.90");

        await page.getByTestId("checkout-link").click();
        await page.getByTestId("shipping-name").fill("Ada Admin");
        await page.getByTestId("shipping-address").fill("1 Market St");
        await page.getByTestId("shipping-zip").fill("10001");
        await page.getByTestId("shipping-next").click();
        await page.getByTestId("card-number").fill("4111111111111111");
        await page.getByTestId("card-expiry").fill("12/27");
        await page.getByTestId("payment-next").click();
        await expect(page.getByTestId("review-total")).toContainText("$116.10");
        await page.getByTestId("place-order").click();

        await expect(page.getByTestId("confirmation-title")).toContainText("BZ-1000");
        await page.getByTestId("view-orders").click();
        await expect(page.getByTestId("orders-list")).toContainText("BZ-1000");
    });

    test("checkout validation rejects an empty shipping form", async ({ page }) => {
        await page.goto("/product/pulse-mouse");
        await page.getByTestId("add-to-cart").click();
        await page.getByTestId("nav-cart").click();
        await page.getByTestId("checkout-link").click();
        await page.getByTestId("shipping-next").click();
        await expect(page.getByTestId("form-error")).toContainText("Name is required.");
    });

    test("out-of-stock product cannot be added", async ({ page }) => {
        await page.goto("/product/boom-speaker");
        await expect(page.getByTestId("sold-out-note")).toBeVisible();
        await expect(page.getByTestId("add-to-cart")).toHaveCount(0);
    });
});
