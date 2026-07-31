import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { formatDOMContext } from "../browser/dom-capture";
import { executeRepairAttempt, extractRepairCode } from "../testing/repair-attempt";

const DOM_SUMMARY = formatDOMContext({
    url: "http://127.0.0.1:5100/projects",
    title: "Projects",
    accessibilityTree: null,
    timestamp: 0,
    formFields: [],
    interactiveElements: [
        {
            tagName: "div",
            role: "alertdialog",
            name: "Delete project",
            suggestedSelectors: ["getByRole('alertdialog', { name: 'Delete project' })"],
        },
        {
            tagName: "button",
            role: "button",
            name: "Confirm",
            suggestedSelectors: ["getByRole('button', { name: 'Confirm' })"],
        },
    ],
});

const FAILING_TEST = `import { test, expect } from "@playwright/test";

test("deletes a project", async ({ page }) => {
    await expect(page.getByRole("dialog", { name: "Delete project" })).toBeVisible();
});
`;

function failure() {
    return [
        {
            testFile: "e2e/a.spec.ts",
            testName: "deletes a project",
            status: "failed" as const,
            duration: 1,
            error: { message: "locator resolved to 0 elements" },
        },
    ];
}

/** A minimal but complete spec, used where the content itself is incidental. */
const VALID_TEST = 'import { test } from "@playwright/test";\n\ntest("a", async () => {});';

describe("extractRepairCode", () => {
    it("extracts a complete fenced TypeScript repair", () => {
        expect(extractRepairCode(`\`\`\`typescript\n${VALID_TEST}\n\`\`\``)).toBe(VALID_TEST);
    });

    // The regression: this exact shape overwrote a spec with markup and
    // reported success, because the old extractor only looked for `test(`
    // somewhere in the blob — and Babel's always-on JSX plugin parses the
    // tags themselves without complaint.
    it("rejects XML-like tool-call markup even when it mentions test(", () => {
        const toolTags = [
            "<function_calls>",
            '<invoke name="saveFile">',
            '<parameter name="content">test("a", async () => {});</parameter>',
            "</invoke>",
            "</function_calls>",
        ].join("\n");
        expect(extractRepairCode(toolTags)).toBeNull();
        expect(extractRepairCode(`\`\`\`typescript\n${toolTags}\n\`\`\``)).toBeNull();
    });

    it("rejects a fenced block that parses but contains no test", () => {
        expect(
            extractRepairCode('```typescript\nimport { test } from "@playwright/test";\n```'),
        ).toBeNull();
    });

    it("rejects a truncated fix", () => {
        expect(extractRepairCode('```typescript\ntest("a", async ({ page }) => {\n```')).toBeNull();
    });
});

describe("executeRepairAttempt", () => {
    it("reports why an unusable response was discarded", async () => {
        const model = {
            invoke: vi
                .fn()
                .mockResolvedValue(new AIMessage({ content: '<invoke name="saveFile">' })),
        };
        const result = await executeRepairAttempt(
            { model: model as never },
            {
                projectPath: process.cwd(),
                testDraft: VALID_TEST,
                testRunResult: failure(),
                repairAttempts: 0,
            },
        );
        expect(result.fixedCode).toBeUndefined();
        expect(result.summary).toContain("tool-call markup");
    });

    it("stops when the model returns unchanged code", async () => {
        const model = {
            invoke: vi
                .fn()
                .mockResolvedValue(
                    new AIMessage({ content: `\`\`\`typescript\n${VALID_TEST}\n\`\`\`` }),
                ),
        };
        const result = await executeRepairAttempt(
            { model: model as never },
            {
                projectPath: process.cwd(),
                testDraft: VALID_TEST,
                testRunResult: [
                    {
                        testFile: "e2e/a.spec.ts",
                        testName: "a",
                        status: "failed",
                        duration: 1,
                        error: { message: "expected true" },
                    },
                ],
                repairAttempts: 0,
            },
        );
        expect(result).toMatchObject({ repairAttempts: 1, noProgress: true });
    });

    it("names the ungrounded locator in the prompt so the model replaces it instead of waiting on it", async () => {
        const model = {
            invoke: vi.fn().mockResolvedValue(
                new AIMessage({
                    content: `\`\`\`typescript\nimport { test, expect } from "@playwright/test";\n\ntest("deletes a project", async ({ page }) => {\n    await expect(page.getByRole("alertdialog", { name: "Delete project" })).toBeVisible();\n});\n\`\`\``,
                }),
            ),
        };

        const result = await executeRepairAttempt(
            { model: model as never },
            {
                projectPath: process.cwd(),
                testDraft: FAILING_TEST,
                testRunResult: failure(),
                repairAttempts: 0,
                domSummary: DOM_SUMMARY,
            },
        );

        const prompt = String(model.invoke.mock.calls[0][0][0].content);
        expect(prompt).toContain("Ungrounded selectors");
        expect(prompt).toContain('getByRole("dialog", { name: "Delete project" })');
        expect(prompt).toContain("Use getByRole('alertdialog', { name: 'Delete project' })");
        expect(result.fixedCode).toContain("alertdialog");
    });

    it("rejects a fix that trades the failing locator for another the DOM contradicts", async () => {
        const model = {
            invoke: vi.fn().mockResolvedValue(
                new AIMessage({
                    content: `\`\`\`typescript\nimport { test, expect } from "@playwright/test";\n\ntest("deletes a project", async ({ page }) => {\n    await page.getByRole("link", { name: "Confirm" }).click();\n});\n\`\`\``,
                }),
            ),
        };

        const result = await executeRepairAttempt(
            { model: model as never },
            {
                projectPath: process.cwd(),
                testDraft: FAILING_TEST,
                testRunResult: failure(),
                repairAttempts: 0,
                domSummary: DOM_SUMMARY,
            },
        );

        expect(result.fixedCode).toBeUndefined();
        expect(result.summary).toMatch(/contradict the captured DOM/i);
        expect(result.groundingViolations?.map((v) => v.kind)).toEqual(["role_mismatch"]);
    });
});
