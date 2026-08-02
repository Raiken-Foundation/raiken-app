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

    it("stays quiet once a session exists", async () => {
        const assessed = await assessGeneratedDraft({
            body: DRAFT,
            projectPath: projectDir,
            outputPath: path.join(projectDir, "e2e", "login.spec.ts"),
            evidence: evidenceFixture({ hasStorageState: true }),
            description: "login as admin and see the dashboard",
        });
        expect(assessed.reviewReasons.some((reason) => reason.includes("signed-out"))).toBe(false);
    });
});
