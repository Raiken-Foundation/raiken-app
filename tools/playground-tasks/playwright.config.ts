import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./tests",
    testMatch: ["**/*.spec.ts"],
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: 1,
    reporter: [["list"], ["html", { open: "never", outputFolder: "test-reports/html" }]],
    preserveOutput: "always",
    use: {
        baseURL: "http://127.0.0.1:5100",
        trace: "retain-on-failure",
        video: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
    webServer: {
        command: "pnpm dev --host 127.0.0.1 --port 5100 --strictPort",
        url: "http://127.0.0.1:5100/auth/login",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
