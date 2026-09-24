import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the "changed test is affected by definition" contract against the
 * below-threshold interaction (review finding, ci/run-ci.ts:120-123):
 * an edited spec whose graph evidence falls below the confidence threshold
 * must still appear in affectedTests — never silently skipped.
 */

const getChangedFilesMock = vi.fn();
const getAffectedTestsMock = vi.fn();

vi.mock("../ci/git-diff", () => ({
    GitError: class GitError extends Error {},
    resolveRefs: () => ({
        base: "main",
        baseSha: "a".repeat(40),
        head: "HEAD",
        headSha: "b".repeat(40),
    }),
    getChangedFiles: (...args: unknown[]) => getChangedFilesMock(...args),
    getStagedFiles: () => [],
    filterSourceFiles: (files: Array<{ path: string }>) => files,
}));

vi.mock("../analysis/graph-query", () => ({
    GraphQueryService: class {
        getAffectedTests(...args: unknown[]) {
            return getAffectedTestsMock(...args);
        }
    },
    isLikelyTestPath: (p: string) => /\.spec\.|\.test\./.test(p),
}));

import { directlyChangedTestEntries, runCi } from "../ci/run-ci";

let projectPath: string;

beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-ci-fix-"));
    getChangedFilesMock.mockReset();
    getAffectedTestsMock.mockReset();
    getAffectedTestsMock.mockReturnValue([]);
});

afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
});

describe("directlyChangedTestEntries", () => {
    it("treats a changed spec as affected at confidence 1.0 and drops deletions", () => {
        const entries = directlyChangedTestEntries([
            { path: "e2e/edited.spec.ts", status: "modified" as const },
            { path: "e2e/gone.spec.ts", status: "removed" as const },
            { path: "src/widget.ts", status: "modified" as const },
        ]);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            testFile: "e2e/edited.spec.ts",
            confidence: 1.0,
        });
        expect(entries[0]?.reasons[0]).toMatchObject({ reason: "changed_test" });
    });
});

describe("runCi changed-test vs below-threshold interaction", () => {
    it("still runs an edited spec whose graph evidence is below the threshold", async () => {
        getChangedFilesMock.mockReturnValue([
            { path: "e2e/edited.spec.ts", status: "modified" },
        ]);
        // Weak evidence for the SAME test file — below the default 0.5 threshold.
        getAffectedTestsMock.mockReturnValue([
            {
                testFile: "e2e/edited.spec.ts",
                sourceFile: "src/widget.ts",
                confidence: 0.2,
                reasons: [
                    {
                        reason: "dependency",
                        provenance: "static_ast",
                        confidence: 0.2,
                        sourceFile: "src/widget.ts",
                    },
                ],
            },
        ]);

        const result = await runCi({
            projectPath,
            skipRun: true,
            format: "json",
            outputDir: ".raiken/ci-test",
        });

        const changed = result.impact.affectedTests.find(
            (t) => t.testFile === "e2e/edited.spec.ts",
        );
        expect(changed).toBeDefined();
        expect(changed?.confidence).toBe(1.0);
        expect(changed?.reasons.some((r) => r.reason === "changed_test")).toBe(true);
        // A test that runs is not "skipped below threshold".
        expect(
            result.impact.skippedBelowThreshold.some(
                (s) => s.testFile === "e2e/edited.spec.ts",
            ),
        ).toBe(false);
        expect(result.exitCode).toBe(0);
    });
});
