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
    changedAssertedValues,
    containsParentTraversal,
    describeAssertionValueMismatch,
    describeDroppedScenarioExpectation,
    describeParentTraversal,
    describeRegressedSelector,
    describeTimeoutFocus,
    extractProvenAbsentLocators,
    extractProvenPresentSelectors,
    extractValueMismatch,
    missingScenarioExpectations,
    scenarioExpectedTokens,
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

    it("matches brace-expansion, char-class, and extglob patterns Playwright accepts", () => {
        // Review finding: these shapes previously failed translation and
        // hard-blocked every draft ("will not be collected") even though
        // Playwright itself collects the file.
        expect(matchesPlaywrightTestPattern("e2e/foo.spec.ts", "**/*.{spec,test}.ts")).toBe(true);
        expect(matchesPlaywrightTestPattern("e2e/foo.test.ts", "**/*.{spec,test}.ts")).toBe(true);
        expect(matchesPlaywrightTestPattern("e2e/foo.spec.js", "**/*.spec.[jt]s")).toBe(true);
        expect(matchesPlaywrightTestPattern("e2e/foo.test.js", "**/*.spec.[jt]s")).toBe(false);
        expect(matchesPlaywrightTestPattern("e2e/foo.spec.ts", "**/*.@(spec|test).ts")).toBe(true);
        expect(matchesPlaywrightTestPattern("e2e/foo.steps.ts", "**/*.@(spec|test).ts")).toBe(
            false,
        );
        // Negated class and class ranges keep glob semantics.
        expect(matchesPlaywrightTestPattern("e2e/foo.spec.ts", "**/*.[!s]pec.ts")).toBe(false);
        expect(matchesPlaywrightTestPattern("e2e/foo.apec.ts", "**/*.[a-c]pec.ts")).toBe(true);
        // Escaped regex metacharacters in filenames stay literal.
        expect(matchesPlaywrightTestPattern("e2e/foo+bar.spec.ts", "**/*.spec.ts")).toBe(true);
        expect(matchesPlaywrightTestPattern("e2e/foo(1).spec.ts", "**/*.spec.ts")).toBe(true);
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

describe("proven-present locators", () => {
    const strictMode = `Error: locator.click: Error: strict mode violation: page.getByTestId("stat-active") resolved to 2 elements:
    1) <div data-testid="stat-active">…</div>
    2) <div data-testid="stat-active">…</div>
`;

    it("extracts selectors the run proved present (strict-mode violations)", () => {
        const selectors = extractProvenPresentSelectors(strictMode);
        expect(selectors).toHaveLength(1);
        expect(selectors[0]).toEqual({
            locator: 'page.getByTestId("stat-active")',
            value: "stat-active",
        });
    });

    it("carries the unambiguous aka alternatives Playwright prints", () => {
        const selectors = extractProvenPresentSelectors(
            `Error: strict mode violation: getByText('Onboarding flow redesign') resolved to 2 elements:
    1) <p class="muted" data-testid="project-description">Onboarding flow redesign</p> aka getByTestId('project-description')
    2) <p>Onboarding flow redesign</p> aka getByTestId('overview-panel').getByText('Onboarding flow redesign')
`,
        );
        expect(selectors[0]).toMatchObject({
            value: "Onboarding flow redesign",
            alternatives: [
                "getByTestId('project-description')",
                "getByTestId('overview-panel').getByText('Onboarding flow redesign')",
            ],
        });
    });

    it("treats zero matches as absence, not presence", () => {
        expect(
            extractProvenPresentSelectors(
                "Error: element(s) not found\n  - waiting for getByRole('heading')",
            ),
        ).toEqual([]);
        expect(extractProvenPresentSelectors("resolved to 0 elements")).toEqual([]);
    });

    it("ignores single-match reports (no strict-mode ambiguity)", () => {
        expect(
            extractProvenPresentSelectors(
                "strict mode violation: getByRole('link') resolved to 1 element",
            ),
        ).toEqual([]);
    });

    it("extracts role-based locators too", () => {
        const role = `Error: locator.click: Error: strict mode violation: page.getByRole('link', { name: 'Projects' }) resolved to 3 elements:
    1) <a href="/projects">Projects</a>
    2) <a href="/projects">Projects</a>
    3) <a href="/projects">Projects</a>
`;
        const selectors = extractProvenPresentSelectors(role);
        expect(selectors[0]?.value).toBe("link");
    });

    it("survives ANSI colour codes around the locator", () => {
        const coloured = strictMode.replace(
            "resolved to 2 elements",
            "\u001b[2mresolved to 2 elements\u001b[22m",
        );
        expect(extractProvenPresentSelectors(coloured)).toEqual(
            extractProvenPresentSelectors(strictMode),
        );
    });

    it("deduplicates repeated violations of the same selector", () => {
        expect(extractProvenPresentSelectors(`${strictMode}\n${strictMode}`)).toHaveLength(1);
    });

    it("escalation guidance names the proven selectors and the fix direction", () => {
        const guidance = describeRegressedSelector([
            { locator: 'getByTestId("stat-active")', value: "stat-active" },
        ]);
        expect(guidance).toContain("stat-active");
        expect(guidance).toContain("strict-mode ambiguity");
        expect(guidance).toContain(".first()");
    });
});

describe("parent-traversal rejection", () => {
    it("detects locator('..') and xpath ancestor climbs", () => {
        expect(
            containsParentTraversal("const c = task.locator('..').getByRole('combobox');"),
        ).toEqual(["locator('..')"]);
        expect(
            containsParentTraversal(
                "await page.locator('xpath=ancestor::*[contains(@class, \"task\")]//select')",
            ),
        ).toHaveLength(1);
        expect(containsParentTraversal("await row.getByRole('combobox')")).toEqual([]);
    });

    it("escalation names the container-first remedy", () => {
        const guidance = describeParentTraversal(["locator('..')"]);
        expect(guidance).toContain("never stable");
        expect(guidance).toContain("task-row");
    });
});

describe("scenario expectation guards (false-green prevention)", () => {
    const scenario = "verify the price is exactly $59.00 and the cart badge shows 1";

    it("extracts dollar amounts, numbers, and quoted phrases from a scenario", () => {
        const tokens = scenarioExpectedTokens(scenario);
        expect(tokens).toContain("$59.00");
        expect(tokens).toContain("1");
    });

    it("reports expectations a draft does not assert", () => {
        const asserting =
            "await expect(price).toHaveText('$59.00'); await expect(badge).toHaveText('1');";
        expect(missingScenarioExpectations(asserting, scenario)).toEqual([]);
        const missing = missingScenarioExpectations(
            "await expect(price).toHaveText('$49.00');",
            scenario,
        );
        expect(missing).toContain("$59.00");
        expect(missing).toContain("1");
    });

    it("escalation names the values and the app-may-be-broken direction", () => {
        const guidance = describeDroppedScenarioExpectation(["$59.00"]);
        expect(guidance).toContain("$59.00");
        expect(guidance).toContain("false green");
    });
});

describe("changedAssertedValues", () => {
    it("flags a value changed inside a value matcher", () => {
        const original = "await expect(page.getByTestId('product-price')).toHaveText('$59.00');";
        const weakened = "await expect(page.getByTestId('product-price')).toHaveText('$49.00');";
        expect(changedAssertedValues(original, weakened)).toEqual(["$59.00"]);
    });

    it("ignores selector changes (getByTestId is not an assertion value)", () => {
        const original = "await expect(page.getByTestId('search-input')).toBeVisible();";
        const fixed = "await expect(page.getByTestId('catalog-search')).toBeVisible();";
        expect(changedAssertedValues(original, fixed)).toEqual([]);
    });

    it("ignores wait and navigation changes", () => {
        const original =
            "await page.goto('/products/pulse-ergonomic-mouse'); await expect(x).toHaveText('A');";
        const fixed = "await page.goto('/product/pulse-mouse'); await expect(x).toHaveText('A');";
        expect(changedAssertedValues(original, fixed)).toEqual([]);
    });

    it("flags numeric and count changes", () => {
        expect(
            changedAssertedValues("expect(rows).toHaveCount(5)", "expect(rows).toHaveCount(4)"),
        ).toEqual(["5"]);
    });

    it("ignores a value that stays identical", () => {
        const original = "await expect(x).toHaveText('$59.00');";
        const fixed = "await expect(x).toHaveText('$59.00');";
        expect(changedAssertedValues(original, fixed)).toEqual([]);
    });
});

describe("extractValueMismatch", () => {
    const priceFailure = `Error: expect(locator).toHaveText(expected) failed

Locator:  getByTestId('product-detail-page').getByTestId('product-price')
Expected: "$59.00"
Received: "$49.00"
`;

    it("extracts Expected/Received from an assertion-value failure", () => {
        expect(extractValueMismatch(priceFailure)).toEqual({
            expected: "$59.00",
            received: "$49.00",
        });
    });

    it("returns null when the expected and received values are equal", () => {
        expect(extractValueMismatch('Expected: "$59.00"\nReceived: "$59.00"')).toBeNull();
    });

    it("returns null for non-value failures (locator/timeout)", () => {
        expect(
            extractValueMismatch("Locator: getByRole('heading')\nError: element(s) not found"),
        ).toBeNull();
        expect(extractValueMismatch("Test timeout of 30000ms exceeded.")).toBeNull();
    });

    it("survives ANSI colour codes around the values", () => {
        const coloured = [
            'Expected: \u001b[32m"$59.00"\u001b[39m',
            'Received: \u001b[31m"$49.00"\u001b[39m',
        ].join("\n");
        expect(extractValueMismatch(coloured)).toEqual({
            expected: "$59.00",
            received: "$49.00",
        });
    });

    it("describes the mismatch as an app-side bug, not a test bug", () => {
        const guidance = describeAssertionValueMismatch({
            expected: "$59.00",
            received: "$49.00",
        });
        expect(guidance).toContain("$59.00");
        expect(guidance).toContain("$49.00");
        expect(guidance).toContain("application-side behavior mismatch");
        expect(guidance).toContain("--allow-weaken");
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
