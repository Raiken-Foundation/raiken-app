/**
 * Selector grounding must be a gate, not a diary entry — but only for what the
 * capture can actually prove. These cases pin the three-way split:
 * `contradictions` (element exists under another role → block),
 * `unverified` (literal absent from capture → report), and `warnings`
 * (text/CSS → log). Collapsing the first two would refuse most negative-path
 * tests, since a validation error or a modal only exists in a state that was
 * never captured; collapsing the last two would flag every assertion on page
 * copy, which capture never enumerates.
 */
import { describe, expect, it } from "vitest";
import { formatGroundingCorrection, validateSelectorGrounding } from "../agent/grounding";
import { type DOMContext, formatDOMContext } from "../browser/dom-capture";

function summary(overrides: Partial<DOMContext> = {}): string {
    return formatDOMContext({
        url: "http://127.0.0.1:5100/projects",
        title: "Projects",
        accessibilityTree: null,
        timestamp: 0,
        interactiveElements: [],
        formFields: [],
        ...overrides,
    });
}

const DELETE_DIALOG_SUMMARY = summary({
    interactiveElements: [
        {
            tagName: "div",
            role: "alertdialog",
            name: "Delete project",
            suggestedSelectors: [
                "getByTestId('delete-project')",
                "getByRole('alertdialog', { name: 'Delete project' })",
            ],
        },
        {
            tagName: "button",
            role: "button",
            name: "Delete",
            testId: "delete-project-confirm",
            suggestedSelectors: [
                "getByTestId('delete-project-confirm')",
                "getByRole('button', { name: 'Delete' })",
            ],
        },
    ],
});

function testWith(body: string): string {
    return `import { test, expect } from '@playwright/test';

test('deletes a project', async ({ page }) => {
${body}
});
`;
}

describe("validateSelectorGrounding — contradictions block", () => {
    it("flags a dialog/alertdialog role mismatch and suggests the captured role", () => {
        const report = validateSelectorGrounding(
            testWith(
                "    await expect(page.getByRole('dialog', { name: 'Delete project' })).toBeVisible();",
            ),
            [DELETE_DIALOG_SUMMARY],
        );

        expect(report.contradictions).toHaveLength(1);
        expect(report.contradictions[0]).toMatchObject({
            kind: "role_mismatch",
            suggestion: "getByRole('alertdialog', { name: 'Delete project' })",
        });
        expect(report.unverified).toEqual([]);
    });

    it("flags a button/link confusion, the same class of bug on ordinary controls", () => {
        const report = validateSelectorGrounding(
            testWith("    await page.getByRole('link', { name: 'Delete' }).click();"),
            [DELETE_DIALOG_SUMMARY],
        );

        expect(report.contradictions.map((v) => v.kind)).toEqual(["role_mismatch"]);
        expect(report.contradictions[0].suggestion).toBe("getByRole('button', { name: 'Delete' })");
    });

    it("never suggests the trigger button in place of the modal it opens", () => {
        // The fixture names the trigger "Delete workspace" and the modal
        // "Delete workspace?" — pointing a dialog assertion at the button would
        // make the test pass while checking the wrong thing.
        const withTrigger = summary({
            interactiveElements: [
                {
                    tagName: "button",
                    role: "button",
                    name: "Delete workspace",
                    suggestedSelectors: ["getByRole('button', { name: 'Delete workspace' })"],
                },
                {
                    tagName: "div",
                    role: "alertdialog",
                    name: "Delete workspace?",
                    suggestedSelectors: ["getByRole('alertdialog', { name: 'Delete workspace?' })"],
                },
            ],
        });
        const report = validateSelectorGrounding(
            testWith(
                "    await expect(page.getByRole('dialog', { name: 'Delete workspace' })).toBeVisible();",
            ),
            [withTrigger],
        );

        expect(report.contradictions[0].suggestion).toBe(
            "getByRole('alertdialog', { name: 'Delete workspace' })",
        );
    });

    it("accepts the role the capture actually exposed", () => {
        const report = validateSelectorGrounding(
            testWith(
                "    await expect(page.getByRole('alertdialog', { name: 'Delete project' })).toBeVisible();\n" +
                    "    await page.getByRole('button', { name: 'Delete' }).click();",
            ),
            [DELETE_DIALOG_SUMMARY],
        );

        expect(report.ok).toBe(true);
        expect(report.contradictions).toEqual([]);
    });
});

describe("validateSelectorGrounding — unverified is reported, not blocked", () => {
    it("reports a test id that appears nowhere in the capture", () => {
        const report = validateSelectorGrounding(
            testWith("    await expect(page.getByTestId('login-error')).toBeVisible();"),
            [DELETE_DIALOG_SUMMARY],
        );

        expect(report.contradictions).toEqual([]);
        expect(report.unverified.map((v) => v.kind)).toEqual(["unknown_test_id"]);
    });

    it("reports an accessible name that appears nowhere in the capture", () => {
        const report = validateSelectorGrounding(
            testWith("    await page.getByRole('button', { name: 'Purge everything' }).click();"),
            [DELETE_DIALOG_SUMMARY],
        );

        expect(report.contradictions).toEqual([]);
        expect(report.unverified.map((v) => v.kind)).toEqual(["unknown_name"]);
    });

    it("reports a modal role that was never captured at all", () => {
        const report = validateSelectorGrounding(
            testWith("    await expect(page.getByRole('dialog')).toBeVisible();"),
            [
                summary({
                    interactiveElements: [
                        {
                            tagName: "button",
                            role: "button",
                            name: "Delete",
                            suggestedSelectors: ["getByRole('button', { name: 'Delete' })"],
                        },
                    ],
                }),
            ],
        );

        expect(report.contradictions).toEqual([]);
        expect(report.unverified.map((v) => v.kind)).toEqual(["unknown_role"]);
    });
});

describe("validateSelectorGrounding — deliberate false negatives", () => {
    it("ignores roles the capture never enumerates, so assertions on page structure survive", () => {
        const report = validateSelectorGrounding(
            testWith(
                "    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();\n" +
                    "    await expect(page.getByRole('alert')).toContainText('Deleted');\n" +
                    "    await page.getByRole('row', { name: 'Apollo' }).getByRole('button', { name: 'Delete' }).click();",
            ),
            [DELETE_DIALOG_SUMMARY],
        );

        expect(report.contradictions).toEqual([]);
        expect(report.unverified).toEqual([]);
    });

    it("keeps unseen text and CSS advisory", () => {
        const report = validateSelectorGrounding(
            testWith(
                "    await expect(page.getByText('Project deleted successfully')).toBeVisible();\n" +
                    "    await expect(page.locator('.toast-success')).toBeVisible();",
            ),
            [DELETE_DIALOG_SUMMARY],
        );

        expect(report.contradictions).toEqual([]);
        expect(report.unverified).toEqual([]);
        expect(report.warnings.map((w) => w.kind)).toEqual(["unknown_text", "unknown_css"]);
    });

    it("is unenforceable when no structured elements were captured", () => {
        const report = validateSelectorGrounding(
            testWith("    await page.getByRole('button', { name: 'Anything' }).click();"),
            ["Page: Projects — some prose with no captured element list"],
        );

        expect(report.enforceable).toBe(false);
        expect(report.contradictions).toEqual([]);
        expect(report.unverified).toEqual([]);
    });

    it("matches Playwright's default substring, case-insensitive name semantics", () => {
        const report = validateSelectorGrounding(
            testWith("    await page.getByRole('button', { name: 'delete' }).click();"),
            [DELETE_DIALOG_SUMMARY],
        );

        expect(report.ok).toBe(true);
    });

    it("does not choke on parentheses or apostrophes inside a locator argument", () => {
        const report = validateSelectorGrounding(
            testWith("    await page.getByText('Delete (permanent)').click();"),
            [DELETE_DIALOG_SUMMARY],
        );

        expect(report.contradictions).toEqual([]);
        expect(report.warnings.map((w) => w.locator)).toEqual(["getByText('Delete (permanent)')"]);
    });
});

describe("formatGroundingCorrection", () => {
    it("names the offending locator and the grounded replacement", () => {
        const report = validateSelectorGrounding(
            testWith(
                "    await expect(page.getByRole('dialog', { name: 'Delete project' })).toBeVisible();",
            ),
            [DELETE_DIALOG_SUMMARY],
        );
        const correction = formatGroundingCorrection(report);

        expect(correction).toContain("getByRole('dialog', { name: 'Delete project' })");
        expect(correction).toContain("Use getByRole('alertdialog', { name: 'Delete project' })");
    });

    it("separates provably wrong locators from unconfirmed ones", () => {
        const report = validateSelectorGrounding(
            testWith(
                "    await expect(page.getByRole('dialog', { name: 'Delete project' })).toBeVisible();\n" +
                    "    await expect(page.getByTestId('login-error')).toBeVisible();",
            ),
            [DELETE_DIALOG_SUMMARY],
        );
        const correction = formatGroundingCorrection(report);

        expect(correction).toContain("provably wrong");
        expect(correction).toContain("match nothing in the captured DOM");
        expect(correction).toContain("getByTestId('login-error')");
    });
});
