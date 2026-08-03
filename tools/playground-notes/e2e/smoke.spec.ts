import { expect, test } from "@playwright/test";

test.describe("Scrawl smoke", () => {
    test("seeded notes list, search, and tag filter", async ({ page }) => {
        await page.goto("/");
        await expect(page.getByTestId("notes-page")).toBeVisible();
        await expect(page.getByTestId("notes-list")).toContainText("Welcome to Scrawl");
        await expect(page.getByTestId("notes-list")).toContainText("Roadmap notes");

        await page.getByTestId("notes-search").fill("roadmap");
        await expect(page.getByTestId("note-card-roadmap-notes")).toBeVisible();
        await expect(page.getByTestId("note-card-welcome-to-scrawl")).toHaveCount(0);

        await page.getByTestId("notes-search").fill("");
        await page.getByTestId("filter-personal").click();
        await expect(page.getByTestId("note-card-welcome-to-scrawl")).toBeVisible();
        await expect(page.getByTestId("note-card-roadmap-notes")).toHaveCount(0);
    });

    test("create a note and see it on the list", async ({ page }) => {
        await page.goto("/new");
        await page.getByTestId("title-input").fill("Sprint review");
        await page.getByTestId("body-input").fill("Ship the search fix, demo the new filter.");
        await page.getByTestId("tag-select").selectOption("work");
        await page.getByTestId("create-note").click();

        await expect(page).toHaveURL(/\/note\/sprint-review$/);
        await expect(page.getByTestId("note-title")).toHaveText("Sprint review");

        await page.getByTestId("nav-notes").click();
        await expect(page.getByTestId("note-card-sprint-review")).toBeVisible();
    });

    test("new note form rejects an empty title", async ({ page }) => {
        await page.goto("/new");
        await page.getByTestId("create-note").click();
        await expect(page.getByTestId("field-title-input").getByTestId("form-error")).toContainText(
            "Title is required.",
        );
        await expect(page).toHaveURL(/\/new$/);
    });

    test("pinning a note moves it ahead of unpinned notes", async ({ page }) => {
        await page.goto("/note/meeting-agenda");
        await page.getByTestId("pin-note").click();

        await page.getByTestId("nav-notes").click();
        const cards = page.getByTestId("notes-list").locator("[data-testid^='note-card-']");
        await expect(cards.first()).toHaveAttribute("data-testid", "note-card-meeting-agenda");
    });

    test("deleting a note removes it from the list", async ({ page }) => {
        await page.goto("/note/grocery-list");
        await page.getByTestId("delete-note").click();
        await page.getByTestId("delete-note").click();

        await expect(page).toHaveURL(/\/$/);
        await expect(page.getByTestId("note-card-grocery-list")).toHaveCount(0);
    });

    test("editing a note persists the new body", async ({ page }) => {
        await page.goto("/note/research-links");
        await page.getByTestId("edit-note").click();
        await page
            .getByTestId("body-input")
            .fill("A running list of papers on retrieval evaluation.");
        await page.getByTestId("save-note").click();

        await expect(page).toHaveURL(/\/note\/research-links$/);
        await expect(page.getByTestId("note-body")).toContainText(
            "A running list of papers on retrieval evaluation.",
        );
    });

    test("login form validates missing credentials", async ({ page }) => {
        await page.goto("/login");
        await page.getByTestId("login-submit").click();
        await expect(page.getByTestId("login-error")).toContainText(
            "Both username and password are required.",
        );
    });

    test("unknown note slug shows the not-found state", async ({ page }) => {
        await page.goto("/note/does-not-exist");
        await expect(page.getByTestId("empty-state")).toContainText("Note not found");
    });
});
