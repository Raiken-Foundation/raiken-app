/**
 * An auth scenario drafted from a signed-out crawl can only guess at what
 * happens after sign-in. The gate must say so — and say which two commands
 * close the gap — rather than surfacing it as an unexplained ungrounded
 * locator.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessGeneratedDraft, describeSignedOutKnowledgeGap } from "../cover/assess-draft";
import type { CoverEvidence } from "../cover/evidence";

function evidenceFixture(overrides: Partial<CoverEvidence> = {}): CoverEvidence {
    return {
        baseURL: "http://127.0.0.1:5180",
        pages: [
            { url: "http://127.0.0.1:5180/", title: "Home" },
            { url: "http://127.0.0.1:5180/login", title: "Sign in" },
        ],
        snapshots: ["Page: http://127.0.0.1:5180/login\n- textbox 'Username'"],
        sourceSelectors: [],
        knownSelectors: [],
        authLogin: null,
        hasStorageState: false,
        hasAuthenticatedKnowledge: false,
        flows: [],
        ...overrides,
    };
}

const DRAFT = `import { test, expect } from '@playwright/test';

test('admin sees the dashboard', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
`;

describe("signed-out knowledge gap", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-authgap-"));
    });

    afterEach(() => {
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    it("names the auth and discover commands that capture pages behind the login", () => {
        const message = describeSignedOutKnowledgeGap(evidenceFixture());
        expect(message).toContain("raiken auth --url http://127.0.0.1:5180/login");
        expect(message).toContain("raiken discover http://127.0.0.1:5180");
    });

    it("flags an auth draft when the login page is known but no session is saved", async () => {
        const assessed = await assessGeneratedDraft({
            body: DRAFT,
            projectPath: projectDir,
            outputPath: path.join(projectDir, "e2e", "login.spec.ts"),
            evidence: evidenceFixture(),
            description: "login as admin and see the dashboard",
        });
        expect(assessed.needsReview).toBe(true);
        expect(assessed.reviewReasons.some((reason) => reason.includes("signed-out"))).toBe(true);
    });

    /**
     * Saving a session adds no knowledge on its own. Treating the file as
     * proof silenced this warning while the draft carried on inventing
     * post-login UI — a worse failure than the one it was meant to catch,
     * because nothing on screen said anything was missing.
     */
    it("keeps warning when a session was saved but nothing was crawled with it", async () => {
        const assessed = await assessGeneratedDraft({
            body: DRAFT,
            projectPath: projectDir,
            outputPath: path.join(projectDir, "e2e", "login.spec.ts"),
            evidence: evidenceFixture({ hasStorageState: true }),
            description: "login as admin and see the dashboard",
        });
        expect(assessed.reviewReasons.some((reason) => reason.includes("signed-out"))).toBe(true);
    });

    it("asks only for discover when the session is already saved", () => {
        const message = describeSignedOutKnowledgeGap(evidenceFixture({ hasStorageState: true }));
        expect(message).toContain("raiken discover http://127.0.0.1:5180");
        expect(message).not.toContain("raiken auth");
    });

    it("stays quiet once pages behind the login are captured", async () => {
        const assessed = await assessGeneratedDraft({
            body: DRAFT,
            projectPath: projectDir,
            outputPath: path.join(projectDir, "e2e", "login.spec.ts"),
            evidence: evidenceFixture({ hasStorageState: true, hasAuthenticatedKnowledge: true }),
            description: "login as admin and see the dashboard",
        });
        expect(assessed.reviewReasons.some((reason) => reason.includes("signed-out"))).toBe(false);
    });
});
