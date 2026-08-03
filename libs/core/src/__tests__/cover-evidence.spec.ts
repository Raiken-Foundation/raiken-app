/**
 * `raiken cover` must be honest about what it produced. The scaffold and any
 * TODO-bearing draft are not runnable, so the result has to say "needs review"
 * instead of unconditional success — the CLI keys its exit message on this.
 * Evidence gathering must also degrade to empty (never throw) in a project
 * with no discovery knowledge and no code graph.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessTodoMarkers, containsUnverifiedMarker, runCover } from "../cover/cover";
import { gatherCoverEvidence } from "../cover/evidence";

describe("cover honesty + evidence", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-cover-evidence-"));
    });

    afterEach(() => {
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it("gatherCoverEvidence returns empty evidence in a bare project", async () => {
        const evidence = await gatherCoverEvidence(projectDir, "checkout applies a coupon");
        expect(evidence.baseURL).toBeNull();
        expect(evidence.pages).toEqual([]);
        expect(evidence.snapshots).toEqual([]);
        expect(evidence.sourceSelectors).toEqual([]);
        expect(evidence.knownSelectors).toEqual([]);
        expect(evidence.authLogin).toBeNull();
        expect(evidence.hasStorageState).toBe(false);
    });

    it("flags cold auth scenarios for review when no login knowledge exists", async () => {
        const result = await runCover({
            projectPath: projectDir,
            target: "sign in with username and password then see the dashboard",
            dryRun: true,
            allowUngrounded: true,
        });
        expect(result.needsReview).toBe(true);
        expect(result.reviewReasons.some((reason) => reason.includes("raiken discover"))).toBe(
            true,
        );
    });

    it("dry-run scaffold reports needsReview with the TODO count", async () => {
        const result = await runCover({
            projectPath: projectDir,
            target: "add a product to the cart",
            dryRun: true,
            allowUngrounded: true,
        });

        expect(result.needsReview).toBe(true);
        expect(result.reviewReasons.some((reason) => reason.includes("TODO"))).toBe(true);
        const written = fs.readFileSync(result.outputPath, "utf-8");
        expect(written).toContain("TODO");
    });

    it("comment-only TODOs are notes; string-literal TODOs are blockers", () => {
        const commentsOnly = `test("add to cart", async ({ page }) => {
  await page.getByTestId("add-to-cart").click();
  // TODO: optionally assert free-shipping badge once shipping tiers land
  await expect(page.getByTestId("cart-link")).toContainText("1");
});`;
        expect(assessTodoMarkers(commentsOnly)).toEqual({ placeholders: 0, notes: 1 });

        const withPlaceholder = `await page.goto("TODO: Define product page URL");`;
        expect(assessTodoMarkers(withPlaceholder)).toEqual({ placeholders: 1, notes: 0 });
    });

    it("refuses to overwrite an existing spec unless force is set", async () => {
        const out = path.join(projectDir, "e2e", "existing.spec.ts");
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, "test('real tests', () => {});\n");

        await expect(
            runCover({
                projectPath: projectDir,
                target: "add a product to the cart",
                outputPath: "e2e/existing.spec.ts",
                dryRun: true,
                allowUngrounded: true,
            }),
        ).rejects.toThrow(/Refusing to overwrite/);
        // The existing test survived untouched.
        expect(fs.readFileSync(out, "utf-8")).toBe("test('real tests', () => {});\n");

        const forced = await runCover({
            projectPath: projectDir,
            target: "add a product to the cart",
            outputPath: "e2e/existing.spec.ts",
            dryRun: true,
            allowUngrounded: true,
            force: true,
        });
        expect(forced.outputPath).toBe(out);
        expect(fs.readFileSync(out, "utf-8")).toContain("TODO");
    });
});

describe("cover @raiken-unverified marker", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-cover-unverified-"));
    });

    afterEach(() => {
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it("stamps the marker when the review is grounding-driven (auth, no knowledge)", async () => {
        const result = await runCover({
            projectPath: projectDir,
            target: "sign in with username and password then see the dashboard",
            dryRun: true,
            allowUngrounded: true,
        });
        const written = fs.readFileSync(result.outputPath, "utf-8");
        expect(written).toContain("@raiken-unverified");
        expect(result.needsReview).toBe(true);
        expect(result.reviewReasons.some((reason) => reason.includes("@raiken-unverified"))).toBe(
            true,
        );
    });

    it("does not stamp a scaffold whose review is TODO-driven", async () => {
        const result = await runCover({
            projectPath: projectDir,
            target: "add a product to the cart",
            dryRun: true,
            allowUngrounded: true,
        });
        const written = fs.readFileSync(result.outputPath, "utf-8");
        expect(written).not.toContain("@raiken-unverified");
        expect(result.needsReview).toBe(true);
    });

    it("parses the marker", () => {
        expect(containsUnverifiedMarker("// @raiken-unverified — draft\nimport { test }")).toBe(
            true,
        );
        expect(containsUnverifiedMarker("import { test } from '@playwright/test'")).toBe(false);
    });
});

describe("cover --fix-config", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-cover-fixconfig-"));
    });

    afterEach(() => {
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it("widens testMatch BEFORE steering, so the draft is not refused onto the collected file", async () => {
        const configPath = path.join(projectDir, "playwright.config.ts");
        fs.writeFileSync(
            configPath,
            `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  testMatch: ["workflows.spec.ts"],
});
`,
        );
        const e2e = path.join(projectDir, "e2e");
        fs.mkdirSync(e2e, { recursive: true });
        // The narrow testMatch collects exactly this file — without the fix,
        // steering lands the draft here and step 6 refuses to overwrite it
        // while telling the user to pass --fix-config (which they did).
        fs.writeFileSync(path.join(e2e, "workflows.spec.ts"), "test('real', () => {});\n");

        const result = await runCover({
            projectPath: projectDir,
            target: "add a product to the cart",
            dryRun: true,
            allowUngrounded: true,
            fixConfig: true,
        });

        expect(fs.readFileSync(configPath, "utf-8")).toContain('testMatch: ["**/*.spec.ts"]');
        expect(path.basename(result.outputPath)).not.toBe("workflows.spec.ts");
        expect(fs.existsSync(result.outputPath)).toBe(true);
        // The real test survived untouched.
        expect(fs.readFileSync(path.join(e2e, "workflows.spec.ts"), "utf-8")).toBe(
            "test('real', () => {});\n",
        );
        expect(result.reviewReasons.some((reason) => reason.includes("testMatch"))).toBe(true);
    });

    it("without --fix-config the steered-file refusal keeps happening", async () => {
        const configPath = path.join(projectDir, "playwright.config.ts");
        fs.writeFileSync(
            configPath,
            `export default defineConfig({
  testDir: "e2e",
  testMatch: ["workflows.spec.ts"],
});
`,
        );
        const e2e = path.join(projectDir, "e2e");
        fs.mkdirSync(e2e, { recursive: true });
        fs.writeFileSync(path.join(e2e, "workflows.spec.ts"), "test('real', () => {});\n");

        await expect(
            runCover({
                projectPath: projectDir,
                target: "add a product to the cart",
                dryRun: true,
                allowUngrounded: true,
            }),
        ).rejects.toThrow(/Refusing to overwrite/);
    });
});

describe("repair evidence + origin lint primitives", () => {
    it("extractOrigins pulls unique origins out of test code and logs", async () => {
        const { extractOrigins } = await import("../cover/evidence");
        const origins = extractOrigins(
            [
                "await page.goto('http://localhost:5199/product/p1');",
                'await page.goto("http://localhost:5199/cart");',
                "// hallucinated: https://example.com/products/123",
                "not a url",
            ].join("\n"),
        );
        expect(origins).toEqual(new Set(["http://localhost:5199", "https://example.com"]));
    });

    it("gatherRepairEvidence degrades to empty in a bare project", async () => {
        const { gatherRepairEvidence } = await import("../cover/evidence");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-repair-evidence-"));
        try {
            const evidence = await gatherRepairEvidence(dir, "page.goto('/cart')");
            expect(evidence.snapshots).toEqual([]);
            expect(evidence.sourceSelectors).toEqual([]);
            expect(evidence.knownOrigins.size).toBe(0);
            expect(evidence.baseURL).toBeNull();
            expect(evidence.authLogin).toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rankPagesByScenario boosts login URLs for auth scenarios and URL mentions", async () => {
        const { rankPagesByScenario } = await import("../cover/evidence");
        const pages = [
            { url: "http://app.local/about", title: "About" },
            { url: "http://app.local/login", title: "Sign in" },
            { url: "http://app.local/dashboard", title: "Dashboard" },
        ];
        const authRanked = rankPagesByScenario(pages, "sign in as amelia", { preferLogin: true });
        expect(authRanked[0]?.url).toContain("/login");

        const failureRanked = rankPagesByScenario(
            pages,
            "Timeout waiting for getByLabel('Email')\npage.goto('/login')",
            { preferUrlMentions: true },
        );
        expect(failureRanked[0]?.url).toContain("/login");
    });

    it("readAuthLoginEvidence parses the agent preference", async () => {
        const { AgentMemory } = await import("../agent/memory");
        const { readAuthLoginEvidence, hasAuthGrounding } = await import("../cover/evidence");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-auth-login-ev-"));
        try {
            AgentMemory.getInstance(dir).setPreference(
                "auth_login",
                JSON.stringify({
                    url: "http://app.local/login",
                    fields: [{ label: "Username", type: "text", selector: "#u" }],
                    submit: "getByRole('button', { name: 'Sign in' })",
                }),
            );
            const auth = readAuthLoginEvidence(dir);
            expect(auth?.fields[0]?.label).toBe("Username");
            expect(
                hasAuthGrounding({ authLogin: auth, snapshots: [], hasStorageState: false }),
            ).toBe(true);
        } finally {
            AgentMemory.clearInstances();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
