import { expect, type Page, test } from "@playwright/test";

/**
 * Orbit workflows — the collected spec for the playground's narrow testMatch.
 * Exercises the flows a real QA engineer would: sign-in, dashboard stats,
 * project search/filter/pagination, task creation + status moves, comments,
 * and viewer RBAC.
 */

async function login(page: Page, username = "admin") {
    await page.goto("/login");
    await page.getByTestId("username-input").fill(username);
    await page.getByTestId("password-input").fill("password");
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/dashboard$/);
}

test.describe("Orbit project suite", () => {
    test("admin signs in and sees the dashboard stats", async ({ page }) => {
        await login(page);

        await expect(page.getByTestId("stat-grid")).toBeVisible();
        await expect(page.getByTestId("stat-projects")).toContainText("12");
        await expect(page.getByTestId("stat-active")).toContainText("9");
        await expect(page.getByTestId("stat-open")).toContainText("18");
        await expect(page.getByTestId("stat-stale")).toContainText("6");
        await expect(page.getByTestId("recent-projects")).toBeVisible();
        await expect(page.getByTestId("recent-activity")).toBeVisible();
    });

    test("search and status filters narrow the project list", async ({ page }) => {
        await login(page);
        await page.goto("/projects");

        // Search is debounced — type and wait for the filtered grid.
        await page.getByTestId("projects-search").fill("atlas");
        await expect(page.getByTestId("project-atlas")).toBeVisible();
        await expect(page.getByTestId("project-orion")).toHaveCount(0);

        // Clear the query, filter by archived — the grid shows only Nova.
        await page.getByTestId("projects-search").fill("");
        await page.getByTestId("filter-archived").click();
        await expect(page.getByTestId("project-nova")).toBeVisible();
        await expect(page.getByTestId("project-atlas")).toHaveCount(0);

        // Status filter plus search can yield an empty state with a reset.
        await page.getByTestId("projects-search").fill("atlas");
        await expect(page.getByTestId("empty-state")).toBeVisible();
        await page.getByTestId("clear-filters").click();
        await expect(page.getByTestId("project-atlas")).toBeVisible();
    });

    test("pagination walks the full project list", async ({ page }) => {
        await login(page);
        await page.goto("/projects");

        await expect(page.getByTestId("pagination-info")).toContainText("Page 1 of 3");
        await page.getByRole("button", { name: "Next" }).click();
        await expect(page.getByTestId("pagination-info")).toContainText("Page 2 of 3");
        await page.getByRole("button", { name: "Previous" }).click();
        await expect(page.getByTestId("pagination-info")).toContainText("Page 1 of 3");
    });

    test("member creates a task and moves it through review", async ({ page }) => {
        await login(page, "priya");
        await page.goto("/projects/atlas");
        await page.getByRole("tab", { name: /Tasks/ }).click();

        await page.getByTestId("create-task").click();
        await page.getByTestId("task-title-input").fill("Archive expired contracts");
        await page.getByTestId("task-description-input").fill("Legal review before year end.");
        await page.getByTestId("task-priority-input").selectOption("high");
        await page.getByTestId("task-assignee-input").selectOption({ label: "Jamal Carter" });
        await page.getByTestId("create-task-submit").click();

        const taskRow = page.getByTestId("task-row-archive-expired-contracts");
        await expect(taskRow).toBeVisible();
        await expect(taskRow).toContainText("Legal review before year end.");

        // Move the new task to In progress via its status select.
        await taskRow.locator('[data-testid^="status-"]').selectOption("in_progress");
        await expect(taskRow).toContainText("In progress");
        await expect(page.getByTestId("toast-stack")).toContainText("In progress");
    });

    test("comments land on a task and appear in the detail modal", async ({ page }) => {
        await login(page, "priya");
        await page.goto("/projects/orion");
        await page.getByRole("tab", { name: /Tasks/ }).click();

        await page.getByTestId("task-offline-draft-queue").click();
        await page.getByTestId("comment-input").fill("The draft queue needs a sync test.");
        await page.getByTestId("comment-submit").click();
        await expect(page.getByTestId("comment-section")).toContainText(
            "The draft queue needs a sync test.",
        );
    });

    test("viewer can read projects but cannot edit anything", async ({ page }) => {
        await login(page, "kai");
        await page.goto("/projects/atlas");
        await page.getByRole("tab", { name: /Tasks/ }).click();

        // Read access works: the seeded task list renders.
        await expect(page.getByTestId("task-backfill-customer-records")).toBeVisible();
        // Write surface is gone: no create button, no status selects.
        await expect(page.getByTestId("create-task")).toHaveCount(0);
        await expect(page.locator('[data-testid^="status-"]')).toHaveCount(0);

        // Opening a task shows no controls inside the modal either.
        await page.getByTestId("task-backfill-customer-records").click();
        await expect(page.getByTestId("task-detail-status")).toHaveCount(0);
        await expect(page.getByTestId("comment-input")).toHaveCount(0);
    });

    test("admin archives a project behind the confirmation dialog", async ({ page }) => {
        await login(page);
        await page.goto("/projects/europa");

        await page.getByTestId("archive-project").click();
        await expect(page.getByRole("dialog", { name: "Archive Europa?" })).toBeVisible();
        await page.getByTestId("confirm-dialog-confirm").click();

        await expect(page.getByTestId("toast-stack")).toContainText("Archived Europa");
        await expect(page.getByTestId("archive-project")).toHaveCount(0);
    });
});
