import { expect, test } from "@playwright/test";
import {
    clearFixtureStorage,
    completeMfa,
    dismissCookieConsent,
    dismissWelcomeModal,
    loginAs,
    loginAsAdmin,
} from "./helpers";

test.beforeEach(async ({ page }) => {
    await clearFixtureStorage(page);
});

test("unauthenticated page requests redirect to the login wall", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/auth\/login$/);
    await expect(page.getByTestId("login-form")).toBeVisible();
});

test("invalid credentials return a structured login error", async ({ page }) => {
    await page.goto("/auth/login");
    await dismissCookieConsent(page);

    await page.getByTestId("username-input").fill("admin");
    await page.getByTestId("password-input").fill("wrong-password");
    await page.getByTestId("login-submit").click();

    await expect(page.getByTestId("login-error")).toHaveText("Invalid username or password.");
    await expect(page).toHaveURL(/\/auth\/login$/);
});

test("locked account login is rejected with a clear message", async ({ page }) => {
    await page.goto("/auth/login");
    await dismissCookieConsent(page);

    await loginAs(page, "locked", "password", { dismissCookie: false });

    await expect(page.getByTestId("login-error")).toHaveText(
        "This account is locked. Contact an administrator.",
    );
    await expect(page).toHaveURL(/\/auth\/login$/);
});

test("admin login shows session details, supports navigation, and logout restores the auth wall", async ({
    page,
}) => {
    await loginAsAdmin(page);

    await expect(page.getByTestId("dashboard-page")).toBeVisible();
    await expect(page.getByTestId("user-chip-name")).toHaveText("admin");
    await expect(page.getByTestId("user-chip-role")).toHaveText("admin");

    await page.getByTestId("nav-projects").click();
    await expect(page.getByTestId("projects-page")).toBeVisible();
    await page.getByTestId("projects-search").fill("Orion Launch");
    await page.getByTestId("project-link-orion-launch").click();
    await expect(page.getByTestId("project-detail-page")).toContainText("Orion Launch");

    await page.getByTestId("logout-button").click();
    await expect(page).toHaveURL(/\/auth\/login$/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/auth\/login$/);
});

test("MFA login rejects wrong code then accepts the fixture code", async ({ page }) => {
    await page.goto("/auth/login");
    await dismissCookieConsent(page);
    await loginAs(page, "mfa-admin", "password", { dismissCookie: false });

    await completeMfa(page, "000000");
    await expect(page.getByTestId("mfa-error")).toHaveText("Invalid verification code.");
    await expect(page).toHaveURL(/\/auth\/mfa$/);

    await page.getByTestId("mfa-code-input").fill("123456");
    await page.getByTestId("mfa-submit").click();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId("user-chip-name")).toHaveText("mfa-admin");
});

test("viewer role cannot create projects and sees a permission explanation", async ({ page }) => {
    await loginAs(page, "viewer");
    await expect(page).toHaveURL(/\/dashboard$/);
    await dismissWelcomeModal(page);

    await page.getByTestId("nav-projects").click();
    await expect(page.getByTestId("open-create-project")).toBeDisabled();
    await expect(page.getByTestId("projects-create-denied")).toContainText("viewer");
});

test("cookie consent and welcome modal interruptions behave deterministically", async ({
    page,
}) => {
    await page.goto("/auth/login");
    await expect(page.getByTestId("cookie-consent-banner")).toBeVisible();
    await expect(page.getByTestId("login-form")).toBeVisible();

    await page.getByTestId("cookie-consent-decline").click();
    await expect(page.getByTestId("cookie-consent-banner")).toBeHidden();

    await loginAs(page, "admin", "password", { dismissCookie: false });
    await expect(page.getByTestId("welcome-modal")).toBeVisible();
    await page.getByTestId("welcome-modal-dismiss").click();
    await expect(page.getByTestId("welcome-modal")).toBeHidden();

    await page.getByTestId("nav-dashboard").click();
    await expect(page.getByTestId("welcome-modal")).toHaveCount(0);
});

test("unsaved settings navigation prompts Stay or Discard", async ({ page }) => {
    await loginAsAdmin(page);

    await page.getByTestId("nav-settings").click();
    await page.getByTestId("workspace-name-input").fill("Acme Corp Updated");
    await page.getByTestId("nav-projects").click();

    await expect(page.getByTestId("unsaved-changes-dialog")).toBeVisible();
    await page.getByTestId("unsaved-changes-dialog-cancel").click();
    await expect(page).toHaveURL(/\/settings$/);

    await page.getByTestId("nav-projects").click();
    await expect(page.getByTestId("unsaved-changes-dialog")).toBeVisible();
    await page.getByTestId("unsaved-changes-dialog-confirm").click();
    await expect(page).toHaveURL(/\/projects$/);
});

test("destructive workspace delete requires confirm, reauth, and admin permissions", async ({
    page,
}) => {
    await loginAs(page, "member");
    await expect(page).toHaveURL(/\/dashboard$/);
    await dismissWelcomeModal(page);

    await page.getByTestId("nav-settings").click();
    await expect(page.getByTestId("settings-danger-denied")).toBeVisible();
    await expect(page.getByTestId("delete-workspace")).toHaveCount(0);

    await page.getByTestId("logout-button").click();
    await loginAsAdmin(page);

    await page.getByTestId("nav-settings").click();
    await page.getByTestId("delete-workspace").click();
    await expect(page.getByTestId("delete-workspace-dialog")).toBeVisible();
    await page.getByTestId("delete-workspace-dialog-confirm").click();

    await expect(page.getByTestId("reauth-dialog")).toBeVisible();
    await page.getByTestId("reauth-password-input").fill("wrong-password");
    await page.getByTestId("reauth-submit").click();
    await expect(page.getByTestId("reauth-error")).toHaveText("Incorrect password.");

    await page.getByTestId("reauth-password-input").fill("password");
    await page.getByTestId("reauth-submit").click();
    await expect(page.getByTestId("workspace-delete-success")).toBeVisible();
});

test("expiring session redirects to login with an expired banner", async ({ page }) => {
    await loginAs(page, "expiring");
    await expect(page).toHaveURL(/\/dashboard$/);
    await dismissWelcomeModal(page);

    await expect(page).toHaveURL(/\/auth\/login\?reason=expired$/, { timeout: 5_000 });
    await expect(page.getByTestId("session-expired-banner")).toBeVisible();
});
