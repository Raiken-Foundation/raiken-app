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
import { assessTodoMarkers, runCover } from "../cover/cover";
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
        expect(
            result.reviewReasons.some((reason) => reason.includes("raiken discover")),
        ).toBe(true);
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
