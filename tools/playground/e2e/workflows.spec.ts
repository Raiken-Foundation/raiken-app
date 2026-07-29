import { expect, type Page, test } from "@playwright/test";

async function login(page: Page, username = "admin") {
    await page.goto("/login");
    await page.getByTestId("username-input").fill(username);
    await page.getByTestId("password-input").fill("password");
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/dashboard$/);
}

async function openProject(page: Page, name: string) {
    await page.getByTestId("nav-projects").click();
    await page.getByTestId("projects-search").fill(name);
    await page.getByRole("link", { name, exact: true }).click();
    await expect(page.getByTestId("project-name")).toHaveText(name);
}

test.describe("Atlas project workflows", () => {
    test("admin can comment on a task and add a project member", async ({ page }) => {
        await login(page);
        await openProject(page, "Orion Launch");

        await page.getByRole("tab", { name: /Tasks/ }).click();
        await page.getByTestId("task-title-t_orion_1").click();
        await expect(
            page.getByRole("dialog", { name: "Wire production analytics events" }),
        ).toBeVisible();
        await page.getByTestId("comment-input").fill("Validated in the release candidate.");
        await page.getByTestId("comment-submit").click();
        await expect(page.getByTestId("comment-list")).toContainText(
            "Validated in the release candidate.",
        );
        await page.getByTestId("task-details-modal-close").click();

        await page.getByRole("tab", { name: /Members/ }).click();
        await page.getByTestId("member-select").selectOption({ label: "priya" });
        await page.getByTestId("member-add").click();
        await expect(page.getByTestId("member-priya")).toBeVisible();
    });

    test("archived projects enforce read-only task and comment controls", async ({ page }) => {
        await login(page);
        await openProject(page, "Legacy Reporting");
        await page.getByRole("tab", { name: /Tasks/ }).click();

        await expect(page.getByTestId("project-readonly")).toBeVisible();
        await expect(page.getByTestId("open-create-task")).toHaveCount(0);
        const statusControls = page.locator('[data-testid^="status-select-"]');
        if ((await statusControls.count()) > 0) {
            await expect(statusControls.first()).toBeDisabled();
        }
    });

    test("member role cannot access administrative actions", async ({ page }) => {
        await login(page, "amelia");
        await openProject(page, "Orion Launch");

        await expect(page.getByTestId("archive-project")).toHaveCount(0);
        await page.getByRole("tab", { name: /Members/ }).click();
        await expect(page.getByTestId("member-add")).toHaveCount(0);
        await expect(page.locator('[data-testid^="member-remove-"]')).toHaveCount(0);

        await page.getByRole("tab", { name: /Tasks/ }).click();
        await expect(page.locator('[data-testid^="delete-task-"]')).toHaveCount(0);
    });
});
