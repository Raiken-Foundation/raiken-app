/**
 * Gates that keep `raiken cover` / repair honest: invalid drafts, Playwright
 * config fit, auth injection, relative gotos.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCover } from "../cover/cover";
import {
    assessAssertionPolarity,
    assessDraftStructure,
    assessPlaywrightFit,
    describeTestMatchRemedy,
    isRestrictiveTestMatch,
    matchesPlaywrightTestPattern,
    suggestCollectedOutputPath,
} from "../cover/draft-quality";
import {
    applyRepairSetupFixes,
    describeTimeoutFocus,
    extractProvenAbsentLocators,
    stillAssertsAbsentLocators,
} from "../cover/repair-setup";
import {
    baseUrlPathPrefix,
    injectStorageState,
    resolveGotoPathsAgainstBaseUrl,
    rewriteAbsoluteGotosToRelative,
} from "../testing/spec-normalize";

describe("draft structure gate", () => {
    it("rejects truncated mid-statement drafts", () => {
        const truncated = `import { test, expect } from '@playwright/test';
test('x', async ({ page }) => {
  await expect(page.getByRole('dialog')).toBeVisible();
  await welcome
`;
        const result = assessDraftStructure(truncated);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/does not parse|invalid/i);
    });

    it("accepts a minimal valid spec", () => {
        const ok = `import { test, expect } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hi' })).toBeVisible();
});
`;
        expect(assessDraftStructure(ok)).toEqual({ ok: true });
    });
});

describe("playwright testMatch fit", () => {
    it("matches basename and glob patterns", () => {
        expect(matchesPlaywrightTestPattern("e2e/workflows.spec.ts", "workflows.spec.ts")).toBe(
            true,
        );
        expect(matchesPlaywrightTestPattern("e2e/cover-foo.spec.ts", "workflows.spec.ts")).toBe(
            false,
        );
        expect(matchesPlaywrightTestPattern("e2e/cover-foo.spec.ts", "**/*.spec.ts")).toBe(true);
    });

    it("flags output that playwright will not collect", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-fit-"));
        try {
            fs.writeFileSync(
                path.join(dir, "playwright.config.ts"),
                `export default { testDir: './e2e', testMatch: ['workflows.spec.ts'] };\n`,
            );
            const fit = await assessPlaywrightFit(dir, path.join(dir, "e2e/cover-scn-foo.spec.ts"));
            expect(fit.collectedByConfig).toBe(false);
            expect(fit.reason).toMatch(/testMatch/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("names the command that fixes a testMatch miss", () => {
        const remedy = describeTestMatchRemedy(["workflows.spec.ts"]);
        expect(remedy).toContain("raiken doctor --fix");
        expect(remedy).toContain("workflows.spec.ts");

        // No unambiguous basename to rename to — only the widen path applies.
        expect(describeTestMatchRemedy(["**/smoke/*.spec.ts"])).not.toMatch(/save the spec as/);
    });
});

describe("proven-absent locators", () => {
    const notFound = `Error: expect(locator).toBeVisible() failed

Locator: getByRole('heading', { name: 'Activity feed' })
Expected: visible
Call log:
  - waiting for getByRole('heading', { name: 'Activity feed' })
Error: element(s) not found
`;

    it("only treats a locator as absent when the run proved zero matches", () => {
        expect(extractProvenAbsentLocators(notFound).join()).toContain("Activity feed");
        // Playwright colours its call log; the escapes must not end up inside
        // the locator, or nothing will ever match it again.
        const coloured = notFound.replace(
            /waiting for (.*)$/m,
            "waiting for \u001b[2m$1\u001b[22m",
        );
        expect(extractProvenAbsentLocators(coloured)).toEqual(
            extractProvenAbsentLocators(notFound),
        );
        expect(
            extractProvenAbsentLocators(
                "Test timeout of 30000ms exceeded.\n  - waiting for getByRole('button')",
            ),
        ).toEqual([]);
    });

    it("catches a fix that re-asserts the same element with extra options", () => {
        const absent = extractProvenAbsentLocators(notFound);
        const qualified = `await expect(page.getByRole('heading', { name: 'Activity feed', level: 3 })).toBeVisible();`;
        expect(stillAssertsAbsentLocators(qualified, absent)).toHaveLength(1);

        const replaced = `await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();`;
        expect(stillAssertsAbsentLocators(replaced, absent)).toEqual([]);
    });
});

describe("spec normalize", () => {
    it("injects storageState once after imports", () => {
        const code = `import { test, expect } from '@playwright/test';

test('x', async ({ page }) => {
  await page.goto('/dashboard');
});
`;
        const out = injectStorageState(code, ".raiken/auth-state.json");
        expect(out).toContain('test.use({ storageState: ".raiken/auth-state.json" });');
        expect(injectStorageState(out, ".raiken/auth-state.json")).toBe(out);
    });

    it("rewrites absolute gotos against the project baseURL", () => {
        const code = `await page.goto('http://localhost:3000/about');
await page.goto("https://example.com/login");`;
        const out = rewriteAbsoluteGotosToRelative(code, "http://localhost:3000");
        expect(out).toContain("page.goto('/about')");
        expect(out).toContain("https://example.com/login");
    });
});

describe("sub-path baseURL navigation", () => {
    it("reads the directory prefix of a baseURL", () => {
        expect(baseUrlPathPrefix("https://todomvc.com/examples/vue/dist/")).toBe(
            "/examples/vue/dist/",
        );
        expect(baseUrlPathPrefix("http://localhost:3000")).toBeNull();
        expect(baseUrlPathPrefix("http://localhost:3000/")).toBeNull();
        expect(baseUrlPathPrefix(null)).toBeNull();
    });

    it("re-roots root-absolute gotos under the baseURL path", () => {
        const code = `await page.goto('/');\nawait page.goto("/about");`;
        const out = resolveGotoPathsAgainstBaseUrl(code, "https://todomvc.com/examples/vue/dist/");
        expect(out).toContain("page.goto('/examples/vue/dist/')");
        expect(out).toContain('page.goto("/examples/vue/dist/about")');
    });

    it("leaves paths that already carry the prefix, and origin-only baseURLs, alone", () => {
        const prefixed = `await page.goto('/examples/vue/dist/active');`;
        expect(
            resolveGotoPathsAgainstBaseUrl(prefixed, "https://todomvc.com/examples/vue/dist/"),
        ).toBe(prefixed);

        const rootBased = `await page.goto('/projects');`;
        expect(resolveGotoPathsAgainstBaseUrl(rootBased, "http://localhost:3000")).toBe(rootBased);
    });

    it("re-roots through the repair setup pass", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-reroot-"));
        const code = `import { test } from '@playwright/test';\ntest('x', async ({ page }) => { await page.goto('/'); });`;
        const result = applyRepairSetupFixes(code, dir, {
            baseURL: "https://todomvc.com/examples/vue/dist/",
            knownOrigins: new Set(["https://todomvc.com"]),
            failureText: "Test timeout of 30000ms exceeded.",
        });
        expect(result.code).toContain("page.goto('/examples/vue/dist/')");
        expect(result.fixes.some((f) => f.includes("re-rooted"))).toBe(true);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe("assertion polarity gate", () => {
    it("flags a draft whose assertions only check for absence", () => {
        const inverted = `import { test, expect } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Welcome')).not.toBeVisible();
});
`;
        const result = assessAssertionPolarity(inverted);
        expect(result.allNegative).toBe(true);
        expect(result.reason).toMatch(/absence/);
    });

    it("accepts a negative assertion paired with a positive one", () => {
        const mixed = `import { test, expect } from '@playwright/test';
test('x', async ({ page }) => {
  await expect(page.getByText('Alpha')).toHaveCount(0);
  await expect(page.getByText('Beta')).toBeVisible();
});
`;
        expect(assessAssertionPolarity(mixed).allNegative).toBe(false);
    });
});

describe("timeout repair focus", () => {
    it("names the pending locator and both explanations", () => {
        const failure = `Error: locator.fill: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByRole('textbox', { name: 'What needs to be done?' })
`;
        const focus = describeTimeoutFocus(failure);
        expect(focus).toContain("What needs to be done?");
        expect(focus).toMatch(/locator is wrong/i);
        expect(focus).toMatch(/never reached the page/i);
    });

    it("stays out of the way for ordinary assertion failures", () => {
        expect(describeTimeoutFocus("expect(received).toBe(expected)")).toBeNull();
    });
});

describe("repair setup fixes", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-setup-"));
        fs.mkdirSync(path.join(projectDir, ".raiken"), { recursive: true });
        fs.writeFileSync(
            path.join(projectDir, ".raiken", "auth-state.json"),
            JSON.stringify({
                cookies: [
                    {
                        name: "session",
                        value: "1",
                        domain: "127.0.0.1",
                        path: "/",
                        expires: Date.now() / 1000 + 3600,
                        httpOnly: true,
                        secure: false,
                        sameSite: "Lax",
                    },
                ],
                origins: [],
            }),
        );
    });

    afterEach(() => {
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it("injects storageState when the failure looks like an auth wall", () => {
        const code = `import { test, expect } from '@playwright/test';
test('dash', async ({ page }) => { await page.goto('/dashboard'); });
`;
        const result = applyRepairSetupFixes(code, projectDir, {
            baseURL: "http://127.0.0.1:5100",
            knownOrigins: new Set(["http://127.0.0.1:5100"]),
            failureText: "redirected to /auth/login",
        });
        expect(result.code).toContain("storageState");
        expect(result.fixes.some((f) => f.includes("storageState"))).toBe(true);
    });
});

describe("cover runCover hard gates", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-cover-gate-"));
    });

    afterEach(() => {
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it("marks dry-run scaffold needsReview and blocked=false (parses)", async () => {
        const result = await runCover({
            projectPath: projectDir,
            target: "add a product to the cart",
            dryRun: true,
            allowUngrounded: true,
        });
        expect(result.needsReview).toBe(true);
        expect(result.blocked).toBe(false);
        expect(result.reviewReasons.some((r) => r.includes("TODO"))).toBe(true);
    });

    it("steers default output onto a single basename testMatch", async () => {
        fs.writeFileSync(
            path.join(projectDir, "playwright.config.ts"),
            `export default { testDir: './e2e', testMatch: ['workflows.spec.ts'] };\n`,
        );
        const result = await runCover({
            projectPath: projectDir,
            target: "simple about page heading",
            dryRun: true,
            allowUngrounded: true,
        });
        expect(result.blocked).toBe(false);
        expect(result.outputPath).toContain("workflows.spec.ts");
        expect(result.reviewReasons.some((r) => r.includes("testMatch"))).toBe(true);
    });

    it("still blocks an explicit --output that testMatch will not collect", async () => {
        fs.writeFileSync(
            path.join(projectDir, "playwright.config.ts"),
            `export default { testDir: './e2e', testMatch: ['workflows.spec.ts'] };\n`,
        );
        const result = await runCover({
            projectPath: projectDir,
            target: "simple about page heading",
            outputPath: "e2e/cover-scn-foo.spec.ts",
            dryRun: true,
            allowUngrounded: true,
        });
        expect(result.blocked).toBe(true);
        expect(result.needsReview).toBe(true);
        expect(result.reviewReasons.some((r) => r.includes("testMatch"))).toBe(true);
    });

    it("detects restrictive testMatch patterns", () => {
        expect(isRestrictiveTestMatch(["workflows.spec.ts"])).toBe(true);
        expect(isRestrictiveTestMatch(["**/*.spec.ts"])).toBe(false);
        expect(isRestrictiveTestMatch(null)).toBe(false);
    });

    it("suggestCollectedOutputPath returns the basename when unambiguous", async () => {
        fs.writeFileSync(
            path.join(projectDir, "playwright.config.ts"),
            `export default { testDir: './e2e', testMatch: ['workflows.spec.ts'] };\n`,
        );
        const suggested = await suggestCollectedOutputPath(
            projectDir,
            path.join(projectDir, "e2e/cover-foo.spec.ts"),
        );
        expect(suggested?.basename).toBe("workflows.spec.ts");
    });
});
