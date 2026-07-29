import { expect, type Page } from "@playwright/test";

export async function dismissCookieConsent(page: Page) {
    const banner = page.getByTestId("cookie-consent-banner");
    if (await banner.isVisible().catch(() => false)) {
        await page.getByTestId("cookie-consent-accept").click();
        await expect(banner).toBeHidden();
    }
}

export async function loginAs(
    page: Page,
    username: string,
    password = "password",
    options: { dismissCookie?: boolean } = {},
) {
    const { dismissCookie = true } = options;

    await page.goto("/auth/login");
    if (dismissCookie) await dismissCookieConsent(page);

    await page.getByTestId("username-input").fill(username);
    await page.getByTestId("password-input").fill(password);
    await page.getByTestId("login-submit").click();
}

export async function dismissWelcomeModal(page: Page) {
    const modal = page.getByTestId("welcome-modal");
    try {
        await modal.waitFor({ state: "visible", timeout: 5000 });
        await page.getByTestId("welcome-modal-dismiss").click();
        await expect(modal).toBeHidden();
    } catch {
        // Welcome modal already dismissed or not shown for this session.
    }
}

export async function loginAsAdmin(page: Page) {
    await loginAs(page, "admin");
    await expect(page).toHaveURL(/\/dashboard$/);
    await dismissWelcomeModal(page);
}

export async function completeMfa(page: Page, code: string) {
    await expect(page).toHaveURL(/\/auth\/mfa$/);
    await page.getByTestId("mfa-code-input").fill(code);
    await page.getByTestId("mfa-submit").click();
}

export async function clearFixtureStorage(page: Page) {
    await page.goto("/auth/login");
    await page.evaluate(() => {
        localStorage.removeItem("playground-auth-cookie-consent");
        sessionStorage.removeItem("playground-auth-welcome-dismissed");
    });
}
