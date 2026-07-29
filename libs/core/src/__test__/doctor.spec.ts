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

    // -------------------------------------------------------------------------
    // Issue 7: Doctor doesn't flag brittle CSS selectors
    // -------------------------------------------------------------------------
    // The user's repro covered three flake patterns the linter missed:
    //   1. CSS-in-JS hashed classes (MUI, Emotion, styled-components, jsx)
    //   2. Long > chains (#__next > div > div > div > p)
    //   3. Positional selectors (:nth-child / :nth-of-type)
    // The tests below pin both directions: the patterns trigger the right
    // rule, and semantic queries (getByRole / getByTestId / getByText /
    // getByLabel) never trigger any of them.
    describe("selector-quality rules (Issue 7)", () => {
        it("flags MUI / Emotion CSS-in-JS hashes inside page.click", async () => {
            // Verbatim repro from the bug report.
            writeSpec(
                "css-in-js.spec.ts",
                `import { test } from '@playwright/test';
test('mui hash', async ({ page }) => {
    await page.click('div.MuiBox-root.css-1abc2de > button:nth-child(3)');
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            const finding = report.findings.find((f) => f.rule === "no-css-in-js-hash");

            expect(finding).toBeDefined();
            expect(finding?.severity).toBe("warning");
            expect(finding?.snippet).toContain("MuiBox-root");
        });

        it("flags styled-components (sc-) and styled-jsx (jsx-) hashes", async () => {
            writeSpec(
                "sc-jsx.spec.ts",
                `import { test } from '@playwright/test';
test('sc', async ({ page }) => {
    await page.locator('button.sc-jSUZER').click();
});
test('jsx', async ({ page }) => {
    await page.locator('div.jsx-1234567890');
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            const ids = report.findings.filter((f) => f.rule === "no-css-in-js-hash");
            expect(ids.length).toBe(2);
        });

        it("flags 3+ deep > chains (the #__next > div > div > div > p case)", async () => {
            // Verbatim repro from the bug report.
            writeSpec(
                "deep-chain.spec.ts",
                `import { test } from '@playwright/test';
test('chain', async ({ page }) => {
    const para = page.locator('#__next > div > div > div > p');
    await para.click();
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            const finding = report.findings.find((f) => f.rule === "no-deep-descendant-chain");

            expect(finding).toBeDefined();
            expect(finding?.severity).toBe("warning");
            expect(finding?.snippet).toContain("#__next");
        });

        it("does NOT flag a 1-level > chain (#root > main)", async () => {
            // Pragmatic single-level chains are common and survive most
            // refactors; the rule only fires at 3+ to avoid noise.
            writeSpec(
                "shallow-chain.spec.ts",
                `import { test } from '@playwright/test';
test('shallow', async ({ page }) => {
    await page.locator('#root > main').waitFor();
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            expect(
                report.findings.find((f) => f.rule === "no-deep-descendant-chain"),
            ).toBeUndefined();
        });

        it("flags :nth-child / :nth-of-type as info-level brittleness", async () => {
            writeSpec(
                "nth.spec.ts",
                `import { test } from '@playwright/test';
test('nth', async ({ page }) => {
    await page.locator('.row:nth-child(2)').click();
    await page.locator('.list :nth-of-type(3)').click();
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            const findings = report.findings.filter((f) => f.rule === "prefer-role-selectors");

            expect(findings.length).toBe(2);
            expect(findings[0]?.severity).toBe("info");
        });

        it("does NOT flag any selector rule on getByRole / getByTestId / getByLabel", async () => {
            // Semantic queries are the recommended replacement. The rules
            // must never trigger on them, even if the test-id string itself
            // looks brittle (e.g. "css-cta-1") — the API call is the anchor,
            // not the string content.
            writeSpec(
                "semantic.spec.ts",
                `import { test } from '@playwright/test';
test('semantic', async ({ page }) => {
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByTestId('css-cta-1').click();
    await page.getByLabel('Email').fill('a@b.com');
    await page.getByText('Welcome').waitFor();
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            const triggered = report.findings.filter((f) =>
                ["no-css-in-js-hash", "no-deep-descendant-chain", "prefer-role-selectors"].includes(
                    f.rule,
                ),
            );
            expect(triggered).toEqual([]);
        });

        it("does NOT flag a stable BEM-style selector", async () => {
            writeSpec(
                "bem.spec.ts",
                `import { test } from '@playwright/test';
test('bem', async ({ page }) => {
    await page.locator('.product-card__buy-button').click();
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            const triggered = report.findings.filter((f) =>
                ["no-css-in-js-hash", "no-deep-descendant-chain", "prefer-role-selectors"].includes(
                    f.rule,
                ),
            );
            expect(triggered).toEqual([]);
        });

        it("emits exactly one finding when a selector violates multiple rules", async () => {
            // The user's repro selector is brittle on TWO axes: CSS-in-JS
            // hash AND :nth-child. The scanner emits one finding per line
            // (most-specific rule wins) so we don't drown the user in
            // redundant signals about the same selector.
            writeSpec(
                "multi.spec.ts",
                `import { test } from '@playwright/test';
test('multi', async ({ page }) => {
    await page.click('div.MuiBox-root.css-1abc2de > button:nth-child(3)');
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            const onLineWithSelector = report.findings.filter(
                (f) => f.file === "e2e/multi.spec.ts" && f.snippet.includes("MuiBox-root"),
            );
            expect(onLineWithSelector.length).toBe(1);
            // Highest-priority rule wins (warning > info, ordered by specificity).
            expect(onLineWithSelector[0]?.rule).toBe("no-css-in-js-hash");
        });
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

    describe("auth-precondition rules", () => {
        /** Make the storageState path real so only the rule under test fires. */
        function writeAuthState(relPath = ".raiken/auth-state.json") {
            const abs = path.join(projectPath, relPath);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(
                abs,
                '{"cookies":[{"name":"session","value":"active","expires":-1}],"origins":[]}',
                "utf-8",
            );
        }

        // The reported regression: Raiken generated exactly this spec for an
        // MFA prompt and `raiken doctor` reported no issue.
        it("flags a saved session combined with a login flow", async () => {
            writeAuthState();
            writeSpec(
                "mfa.spec.ts",
                `import { test, expect } from '@playwright/test';

test.use({ storageState: '.raiken/auth-state.json' });

test('signs in with MFA', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Password').fill('secret');
    await expect(page.getByText('Enter your code')).toBeVisible();
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            const finding = report.findings.find((f) => f.rule === "auth-state-with-login-flow");

            expect(finding).toBeDefined();
            expect(finding?.severity).toBe("error");
            // Reported on the storageState line — the line to delete.
            expect(finding?.line).toBe(3);
            expect(finding?.message).toContain("navigates to the login page");
        });

        it("reports the offending spec only once", async () => {
            writeAuthState();
            writeSpec(
                "login.spec.ts",
                `import { test } from '@playwright/test';
test.use({ storageState: '.raiken/auth-state.json' });
test('signs in', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Password').fill('secret');
    await page.getByRole('button', { name: 'Sign in' }).click();
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            expect(
                report.findings.filter((f) => f.rule === "auth-state-with-login-flow"),
            ).toHaveLength(1);
        });

        // Playwright's documented way to run one spec signed out despite a
        // globally authenticated project. Flagging it would be backwards.
        it("does NOT flag an empty storageState object with a login flow", async () => {
            writeSpec(
                "logged-out.spec.ts",
                `import { test } from '@playwright/test';
test.use({ storageState: { cookies: [], origins: [] } });
test('signs in', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Password').fill('secret');
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            expect(report.findings.find((f) => f.rule === "auth-state-with-login-flow")).toBe(
                undefined,
            );
        });

        // "Sign out, then sign back in" is a real flow that needs both.
        it("does NOT flag a re-login after an explicit sign-out", async () => {
            writeAuthState();
            writeSpec(
                "relogin.spec.ts",
                `import { test } from '@playwright/test';
test.use({ storageState: '.raiken/auth-state.json' });
test('signs back in', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.goto('/login');
    await page.getByLabel('Password').fill('secret');
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            expect(report.findings.find((f) => f.rule === "auth-state-with-login-flow")).toBe(
                undefined,
            );
        });

        // Found against the live fixture: an authenticated spec that confirms
        // a destructive action by re-entering its password. A password field
        // is normal inside an authenticated app, so it must not be evidence of
        // a login flow — this rule is error severity and would fail CI.
        it("does NOT flag a reauthentication prompt inside an authenticated flow", async () => {
            writeAuthState();
            writeSpec(
                "delete-workspace.spec.ts",
                `import { test, expect } from '@playwright/test';
test.use({ storageState: '.raiken/auth-state.json' });
test('deletes the workspace', async ({ page }) => {
    await page.goto('/settings');
    await page.getByTestId('delete-workspace').click();
    await page.getByRole('button', { name: /confirm|delete/i }).click();
    const password = page.getByLabel(/password/i);
    await password.fill('password123');
    await page.getByRole('button', { name: /confirm|authenticate/i }).click();
    await expect(page.getByText(/deleted/i)).toBeVisible();
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            expect(report.findings.find((f) => f.rule === "auth-state-with-login-flow")).toBe(
                undefined,
            );
        });

        it("does NOT flag an authenticated spec that never touches a login form", async () => {
            writeAuthState();
            writeSpec(
                "projects.spec.ts",
                `import { test, expect } from '@playwright/test';
test.use({ storageState: '.raiken/auth-state.json' });
test('lists projects', async ({ page }) => {
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            expect(report.findings.find((f) => f.rule === "auth-state-with-login-flow")).toBe(
                undefined,
            );
        });

        it("flags a storageState path that does not exist", async () => {
            writeSpec(
                "missing.spec.ts",
                `import { test } from '@playwright/test';
test.use({ storageState: '.raiken/auth-state.json' });
test('lists projects', async ({ page }) => {
    await page.goto('/projects');
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            const finding = report.findings.find((f) => f.rule === "missing-auth-state-file");

            expect(finding).toBeDefined();
            expect(finding?.severity).toBe("warning");
            expect(finding?.message).toContain(".raiken/auth-state.json");
        });

        it("flags malformed, empty, and expired storage state files", async () => {
            writeSpec(
                "state.spec.ts",
                `import { test } from '@playwright/test';
test.use({ storageState: '.raiken/auth-state.json' });
test('lists projects', async ({ page }) => {
    await page.goto('/projects');
});
`,
            );
            const statePath = path.join(projectPath, ".raiken", "auth-state.json");
            fs.mkdirSync(path.dirname(statePath), { recursive: true });

            fs.writeFileSync(statePath, "{ bad");
            let report = await scanTests({ projectPath, testDirectory: "e2e" });
            expect(report.findings.some((f) => f.rule === "malformed-auth-state-file")).toBe(true);

            fs.writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
            report = await scanTests({ projectPath, testDirectory: "e2e" });
            expect(report.findings.some((f) => f.rule === "empty-auth-state-file")).toBe(true);

            fs.writeFileSync(
                statePath,
                JSON.stringify({
                    cookies: [
                        {
                            name: "session",
                            value: "stale",
                            expires: Math.floor(Date.now() / 1000) - 60,
                        },
                    ],
                    origins: [],
                }),
            );
            report = await scanTests({ projectPath, testDirectory: "e2e" });
            expect(report.findings.some((f) => f.rule === "expired-auth-state-file")).toBe(true);
        });

        it("does NOT guess about an interpolated storageState path", async () => {
            writeSpec(
                "env.spec.ts",
                `import { test } from '@playwright/test';
test.use({ storageState: \`\${process.env.STATE_DIR}/auth.json\` });
test('lists projects', async ({ page }) => {
    await page.goto('/projects');
});
`,
            );

            const report = await scanTests({ projectPath, testDirectory: "e2e" });
            expect(report.findings.find((f) => f.rule === "missing-auth-state-file")).toBe(
                undefined,
            );
        });
    });
});
