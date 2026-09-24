/**
 * A scenario draft that carries no assertions at all passes on any app —
 * including a broken one. That vacuous green is the "test matches the code"
 * anti-pattern, so the assessment must treat it as grounding-driven and let
 * cover stamp the @raiken-unverified marker, which `raiken test` refuses.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessGeneratedDraft } from "../cover/assess-draft";
import type { CoverEvidence } from "../cover/evidence";

function evidenceFixture(): CoverEvidence {
    return {
        baseURL: "http://127.0.0.1:5180",
        pages: [{ url: "http://127.0.0.1:5180/", title: "Home" }],
        snapshots: ["Page: http://127.0.0.1:5180/\n- button 'New task'"],
        sourceSelectors: [],
        knownSelectors: [],
        authLogin: null,
        hasStorageState: false,
        hasAuthenticatedKnowledge: false,
        flows: [],
    };
}

const VACUOUS_DRAFT = `import { test } from '@playwright/test';

test('add a task', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New task' }).click();
  // TODO: fill the form
  // TODO: assert the task appears
});
`;

const ASSERTING_DRAFT = `import { test, expect } from '@playwright/test';

test('add a task', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New task' }).click();
  await expect(page.getByRole('button', { name: 'New task' })).toBeVisible();
});
`;

describe("vacuous draft gate", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-vacuous-"));
    });

    afterEach(() => {
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it("treats an assertion-less draft as grounding-driven so the marker gets stamped", async () => {
        const assessed = await assessGeneratedDraft({
            body: VACUOUS_DRAFT,
            projectPath: projectDir,
            outputPath: path.join(projectDir, "e2e", "add-task.spec.ts"),
            evidence: evidenceFixture(),
            description: "add a task on the tasks page",
        });
        expect(assessed.groundingDriven).toBe(true);
        expect(assessed.needsReview).toBe(true);
        expect(
            assessed.reviewReasons.some((reason) => reason.includes("no matching assertion")),
        ).toBe(true);
    });

    it("does not flag a draft that asserts the scenario as grounding-driven for vacuity", async () => {
        const assessed = await assessGeneratedDraft({
            body: ASSERTING_DRAFT,
            projectPath: projectDir,
            outputPath: path.join(projectDir, "e2e", "add-task.spec.ts"),
            evidence: evidenceFixture(),
            description: "add a task on the tasks page",
        });
        expect(assessed.groundingDriven).toBe(false);
    });
});
