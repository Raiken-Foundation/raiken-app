/**
 * Auth Command
 *
 * Manual authentication flow for saving browser state.
 */

import chalk from "chalk";
import ora from "ora";
import * as path from "node:path";
import * as fs from "node:fs";
import * as readline from "node:readline";

interface AuthOptions {
    url?: string;
}

export async function authCommand(options: AuthOptions): Promise<void> {
    const projectPath = process.cwd();
    const raikenDir = path.join(projectPath, ".raiken");
    const authStatePath = path.join(raikenDir, "auth-state.json");

    try {
        // Ensure .raiken directory exists
        if (!fs.existsSync(raikenDir)) {
            fs.mkdirSync(raikenDir, { recursive: true });
        }

        console.log(chalk.cyan("\n🔐 Starting authentication flow...\n"));

        // Get URL from options or prompt
        let url = options.url;

        if (!url) {
            console.log(
                chalk.dim("No URL provided. Opening browser to navigate manually.")
            );
            console.log();
            url = "about:blank";
        }

        const spinner = ora({
            text: "Launching browser...",
            spinner: "dots",
        }).start();

        // Dynamically import playwright (available via @raiken/core dependency)
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        let chromium: any;
        try {
            // Use require() to avoid TS module resolution at build time
            const pw = require("playwright");
            chromium = pw.chromium;
        } catch {
            try {
                const pw = require("playwright-core");
                chromium = pw.chromium;
            } catch {
                console.error(
                    chalk.red("❌ Playwright is not installed. Run: npx playwright install")
                );
                process.exit(1);
            }
        }

        // Launch browser in non-headless mode
        const browser = await chromium.launch({
            headless: false,
            args: ["--start-maximized"],
        });

        const context = await browser.newContext({
            viewport: null,
        });

        const page = await context.newPage();

        spinner.succeed(chalk.green("Browser launched"));
        console.log();

        // Navigate to URL
        if (url !== "about:blank") {
            console.log(chalk.dim(`Navigating to ${url}...`));
            await page.goto(url, { waitUntil: "domcontentloaded" });
            console.log();
        }

        // Wait for user to complete login
        console.log(chalk.yellow("📝 Please log in to your application."));
        console.log(chalk.dim("   The browser will remain open for you to:"));
        console.log(chalk.dim("   1. Navigate to the login page (if not already there)"));
        console.log(chalk.dim("   2. Complete the login process"));
        console.log(chalk.dim("   3. Verify you're logged in"));
        console.log();

        await waitForUserConfirmation();

        // Extract storage state
        spinner.start("Saving authentication state...");

        const storageState = await context.storageState();

        // Save to file
        fs.writeFileSync(authStatePath, JSON.stringify(storageState, null, 2));

        try {
            const { CodeGraphDB, SiteKnowledgeDB } = await import("@raiken/core");
            const db = new CodeGraphDB(projectPath);
            const siteDb = new SiteKnowledgeDB(db.getRawDatabase(), projectPath);
            const blockers = siteDb.getUnresolvedBlockers();
            for (const blocker of blockers) {
                if (blocker.id) {
                    siteDb.markBlockerResolved(blocker.id, authStatePath);
                }
            }
            if (blockers.length > 0) {
                console.log(
                    chalk.green(
                        `✓ Resolved ${blockers.length} auth blocker${blockers.length === 1 ? "" : "s"}`
                    )
                );
            }
            db.close();
        } catch {
            // Ignore DB errors during auth flow
        }

        spinner.succeed(chalk.green("Authentication state saved!"));
        console.log();
        console.log(chalk.dim(`   Saved to: ${authStatePath}`));
        console.log();

        // Show summary
        const cookieCount = storageState.cookies.length;
        const originCount = storageState.origins.length;

        console.log(chalk.cyan("📊 Summary:"));
        console.log(chalk.dim(`   Cookies saved:        ${cookieCount}`));
        console.log(chalk.dim(`   Storage origins:      ${originCount}`));
        console.log();

        // Close browser
        await browser.close();

        console.log(
            chalk.green(
                "✅ Authentication complete! You can now run 'raiken discover' to crawl protected routes."
            )
        );
        console.log();
    } catch (error) {
        console.error(
            chalk.red("\n❌ Authentication failed:"),
            (error as Error).message
        );
        process.exit(1);
    }
}

/**
 * Wait for user to press Enter.
 */
async function waitForUserConfirmation(): Promise<void> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(
            chalk.white("Press Enter when you've completed the login... "),
            () => {
                rl.close();
                console.log();
                resolve();
            }
        );
    });
}
