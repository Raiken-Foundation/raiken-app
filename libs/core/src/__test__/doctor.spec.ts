import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanTests } from "../doctor/scan";

/**
 * Doctor scan unit tests. We exercise the rules against synthesized test
 * files inside a tmp dir so the scanner walks a real filesystem.
 */
describe("raiken doctor: scanTests", () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-doctor-"));
        fs.mkdirSync(path.join(projectPath, "e2e"), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    function writeSpec(name: string, contents: string) {
        fs.writeFileSync(path.join(projectPath, "e2e", name), contents, "utf-8");
    }

    it("detects fixed-sleep anti-patterns", async () => {
        writeSpec(
            "a.spec.ts",
            `import { test, expect } from '@playwright/test';
test('flaky', async ({ page }) => {
    await page.waitForTimeout(1000);
    await page.goto('/');
    setTimeout(() => {}, 500);
    expect(true).toBe(true);
});
`,
        );

        const report = await scanTests({ projectPath, testDirectory: "e2e" });
        const ids = report.findings.map((f) => f.rule);

        expect(ids).toContain("no-wait-for-timeout");
        expect(ids).toContain("no-set-timeout");
        expect(ids).toContain("no-trivial-assertion");
        expect(report.summary.error).toBeGreaterThanOrEqual(2);
    });

    it(".only is flagged; conditional test.skip(condition, 'reason') is NOT flagged", async () => {
        writeSpec(
            "b.spec.ts",
            `import { test, expect } from '@playwright/test';

test.only('focused', async () => {});

test('cond', async ({ browserName }) => {
    test.skip(browserName === 'webkit', 'not supported on webkit');
    expect(1).toBe(1);
});
`,
        );

        const report = await scanTests({ projectPath, testDirectory: "e2e" });
        const ids = report.findings.map((f) => f.rule);

        expect(ids).toContain("no-only");
        // Conditional feature-gate form must NOT trigger the permanent-skip rule.
        expect(ids).not.toContain("no-skip-always");
    });

    it("flags permanent test.skip('name', fn)", async () => {
        writeSpec(
            "c.spec.ts",
            `import { test } from '@playwright/test';
test.skip('disabled', async () => {});
`,
        );

        const report = await scanTests({ projectPath, testDirectory: "e2e" });
        const ids = report.findings.map((f) => f.rule);
        expect(ids).toContain("no-skip-always");
    });

    it("skips block-comment lines", async () => {
        writeSpec(
            "d.spec.ts",
            `/*
 * await page.waitForTimeout(1000)
 */
import { test } from '@playwright/test';
test('ok', async () => {});
`,
        );

        const report = await scanTests({ projectPath, testDirectory: "e2e" });
        expect(report.findings.length).toBe(0);
    });

    it("returns empty findings when test dir doesn't exist", async () => {
        const report = await scanTests({
            projectPath,
            testDirectory: "does-not-exist",
        });
        expect(report.findings).toEqual([]);
        expect(report.scannedFiles).toBe(0);
    });

    describe("project-level checks", () => {
        function writePlaywrightConfig(baseURL: string | null) {
            const useBlock = baseURL ? `use: { baseURL: '${baseURL}' },` : "";
            fs.writeFileSync(
                path.join(projectPath, "playwright.config.ts"),
                `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './e2e', ${useBlock} });\n`,
                "utf-8",
            );
        }

        function writeViteConfig(port: number) {
            fs.writeFileSync(
                path.join(projectPath, "vite.config.ts"),
                `export default { server: { port: ${port} } };\n`,
                "utf-8",
            );
        }

        it("flags baseurl-port-mismatch when ports disagree", async () => {
            writePlaywrightConfig("http://localhost:5180");
            writeViteConfig(3000);
            writeSpec(
                "x.spec.ts",
                `import { test } from '@playwright/test';\ntest('ok', async () => {});\n`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            const finding = report.findings.find((f) => f.rule === "baseurl-port-mismatch");

            expect(finding).toBeDefined();
            expect(finding?.severity).toBe("warning");
            expect(finding?.message).toContain("port 5180");
            expect(finding?.message).toContain("port 3000");
            expect(finding?.file).toBe("playwright.config.ts");
        });

        it("does NOT flag baseurl-port-mismatch when ports agree", async () => {
            writePlaywrightConfig("http://localhost:3000");
            writeViteConfig(3000);
            writeSpec(
                "x.spec.ts",
                `import { test } from '@playwright/test';\ntest('ok', async () => {});\n`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            expect(report.findings.find((f) => f.rule === "baseurl-port-mismatch")).toBeUndefined();
        });

        it("does NOT flag mismatch for non-localhost baseURL", async () => {
            writePlaywrightConfig("https://staging.example.com");
            writeViteConfig(3000);
            writeSpec(
                "x.spec.ts",
                `import { test } from '@playwright/test';\ntest('ok', async () => {});\n`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            expect(report.findings.find((f) => f.rule === "baseurl-port-mismatch")).toBeUndefined();
        });

        it("flags hardcoded localhost URLs in tests when baseURL is set", async () => {
            writePlaywrightConfig("http://localhost:3000");
            writeViteConfig(3000);
            writeSpec(
                "y.spec.ts",
                `import { test, expect } from '@playwright/test';\ntest('hardcodes', async ({ page }) => {\n  await page.goto('http://localhost:3000/dashboard');\n  await expect(page).toHaveURL('http://localhost:3000/login');\n});\n`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            const localhostFindings = report.findings.filter(
                (f) => f.rule === "hardcoded-localhost",
            );

            expect(localhostFindings.length).toBeGreaterThanOrEqual(2);
            for (const f of localhostFindings) {
                expect(f.severity).toBe("info");
                expect(f.file).toBe("e2e/y.spec.ts");
            }
        });

        it("does NOT flag hardcoded localhost when no baseURL is configured", async () => {
            // No playwright config at all → no baseURL → rule is disabled.
            writeSpec(
                "z.spec.ts",
                `import { test } from '@playwright/test';\ntest('hardcodes', async ({ page }) => {\n  await page.goto('http://localhost:3000/dashboard');\n});\n`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            expect(report.findings.find((f) => f.rule === "hardcoded-localhost")).toBeUndefined();
        });
    });
});
