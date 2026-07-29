import type { BrowserContext, Page } from "@playwright/test";

export default async function customLogin({
    page,
    credentials,
}: {
    page: Page;
    context: BrowserContext;
    credentials?: { username?: string; password?: string };
}) {
    const username = credentials?.username;
    const password = credentials?.password;
    if (!username || !password) {
        throw new Error("Configured auth username and password environment variables are required");
    }

    await page.getByTestId("username-input").fill(username);
    await page.getByTestId("password-input").fill(password);
    await page.getByTestId("login-submit").click();
    await page.waitForURL("**/dashboard");
}
