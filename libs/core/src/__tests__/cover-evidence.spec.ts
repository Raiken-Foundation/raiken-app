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
import { runCover } from "../cover/cover";
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
    });

    it("dry-run scaffold reports needsReview with the TODO count", async () => {
        const result = await runCover({
            projectPath: projectDir,
            target: "add a product to the cart",
            dryRun: true,
        });

        expect(result.needsReview).toBe(true);
        expect(result.reviewReasons.some((reason) => reason.includes("TODO"))).toBe(true);
        expect(result.grounding).toBeUndefined();
        const written = fs.readFileSync(result.outputPath, "utf-8");
        expect(written).toContain("TODO");
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
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
