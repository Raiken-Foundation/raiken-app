/**
 * `raiken init` project detection — Playwright config sync (ux-11).
 *
 * Pre-fix, `detectProject` always guessed `testDir` from the project's
 * framework (e.g. "tests" for a generic React app) even when a real
 * `playwright.config.ts` already existed with a different `testDir`. That
 * mismatch propagated straight into `raiken.config.json`'s
 * `testDirectory`, which the agent uses for every test save/read — so a
 * project that already had Playwright set up could end up with Raiken
 * looking in the wrong directory for tests it just wrote.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProject } from "../project-detector";

async function writePackageJson(dir: string, contents: Record<string, unknown>): Promise<void> {
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(contents, null, 2));
}

describe("detectProject — Playwright config sync", () => {
    let projectPath: string;

    beforeEach(async () => {
        projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "raiken-detect-"));
    });

    afterEach(async () => {
        await fs.rm(projectPath, { recursive: true, force: true });
    });

    it("falls back to the per-framework default testDir with no existing config", async () => {
        await writePackageJson(projectPath, { name: "app", dependencies: { react: "^18.0.0" } });
        const info = await detectProject(projectPath);
        expect(info.testDir).toBe("tests");
        expect(info.hasPlaywright).toBe(false);
        expect(info.hasPlaywrightPackage).toBe(false);
        expect(info.existingPlaywrightConfig).toBeNull();
    });

    it("uses the real testDir from an existing playwright.config.ts over the framework default", async () => {
        await writePackageJson(projectPath, { name: "app", dependencies: { react: "^18.0.0" } });
        await fs.writeFile(
            path.join(projectPath, "playwright.config.ts"),
            `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'https://staging.example.com' },
});
`,
        );
        const info = await detectProject(projectPath);
        expect(info.testDir).toBe("tests/e2e");
        expect(info.hasPlaywright).toBe(true);
        expect(info.existingPlaywrightConfig).toEqual({
            testDir: "tests/e2e",
            baseURL: "https://staging.example.com",
        });
    });

    it("distinguishes 'config exists' from 'package installed'", async () => {
        // Config committed to the repo, but node_modules never got the
        // package (e.g. fresh clone, no install yet).
        await writePackageJson(projectPath, { name: "app", dependencies: { react: "^18.0.0" } });
        await fs.writeFile(
            path.join(projectPath, "playwright.config.ts"),
            `export default { testDir: './e2e' };`,
        );
        const info = await detectProject(projectPath);
        expect(info.hasPlaywright).toBe(true);
        expect(info.hasPlaywrightPackage).toBe(false);
    });

    it("reports hasPlaywrightPackage true when @playwright/test is a dependency", async () => {
        await writePackageJson(projectPath, {
            name: "app",
            devDependencies: { "@playwright/test": "^1.40.0" },
        });
        const info = await detectProject(projectPath);
        expect(info.hasPlaywrightPackage).toBe(true);
        expect(info.hasPlaywright).toBe(true);
        // No config file to scrape a custom testDir from.
        expect(info.existingPlaywrightConfig).toBeNull();
    });

    it("normalizes a leading './' and trailing '/' on the scraped testDir", async () => {
        await writePackageJson(projectPath, { name: "app" });
        await fs.writeFile(
            path.join(projectPath, "playwright.config.js"),
            `module.exports = { testDir: './e2e-tests/' };`,
        );
        const info = await detectProject(projectPath);
        expect(info.testDir).toBe("e2e-tests");
    });

    it("returns an empty object (not null) when the config exists but has no testDir/baseURL", async () => {
        await writePackageJson(projectPath, { name: "app" });
        await fs.writeFile(
            path.join(projectPath, "playwright.config.ts"),
            `export default { fullyParallel: true };`,
        );
        const info = await detectProject(projectPath);
        expect(info.existingPlaywrightConfig).toEqual({});
        // Falls back to the framework default since nothing was scraped.
        expect(info.testDir).toBe("tests");
    });
});
