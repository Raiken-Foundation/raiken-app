import { describe, expect, it } from "vitest";
import { buildFieldSelector, buildSelectors, classifySelector } from "../selector-utils";

describe("selector-utils golden parity", () => {
    it("classifies selector kinds consistently", () => {
        expect(classifySelector("getByTestId('login')")).toBe("data-testid");
        expect(classifySelector('[data-testid="x"]')).toBe("data-testid");
        expect(classifySelector("getByRole('button', { name: 'Go' })")).toBe("role");
        expect(classifySelector('role=button[name="Go"]')).toBe("role");
        expect(classifySelector("getByText('Submit')")).toBe("text");
        expect(classifySelector("text=Submit")).toBe("text");
        expect(classifySelector("#login")).toBe("css");
        expect(classifySelector("input[name='email']")).toBe("css");
        expect(classifySelector("//button")).toBe("xpath");
        expect(classifySelector("unknown-format")).toBe("other");
    });

    it("builds field selectors in robustness order", () => {
        expect(
            buildFieldSelector({
                testId: "email-input",
                id: "email",
                name: "email",
            }),
        ).toBe("getByTestId('email-input')");

        expect(
            buildFieldSelector({
                id: "user:email",
                name: "email",
            }),
        ).toBe("#user\\:email");

        expect(
            buildFieldSelector({
                name: 'user"quote',
            }),
        ).toBe('[name="user\\"quote"]');

        expect(
            buildFieldSelector({
                label: "Email",
            }),
        ).toBe("getByLabel('Email')");

        expect(buildFieldSelector({})).toBe("input");
    });

    it("builds interactive selectors with stable fallback ordering", () => {
        const selectors = buildSelectors("button", "Submit", "submit-btn", {
            htmlId: "submit",
            htmlName: "submit",
            type: "submit",
            ariaLabel: "Submit form",
        });

        expect(selectors).toEqual([
            "getByTestId('submit-btn')",
            "#submit",
            'button[type="submit"]',
            "getByRole('button', { name: 'Submit' })",
            "getByLabel('Submit form')",
            "getByText('Submit')",
        ]);
    });

    it("builds landmark selectors without text fallback", () => {
        const selectors = buildSelectors("alertdialog", "Confirm delete", null, {
            ariaLabel: "Confirm delete",
        });

        expect(selectors).toEqual([
            "getByRole('alertdialog', { name: 'Confirm delete' })",
            "getByLabel('Confirm delete')",
        ]);
        expect(selectors.some((s) => s.startsWith("getByText"))).toBe(false);
    });

    it("builds unnamed landmark selectors by role only", () => {
        const selectors = buildSelectors("alertdialog", "", null, {
            ariaLabel: "Confirm delete",
        });

        expect(selectors).toEqual(["getByRole('alertdialog')", "getByLabel('Confirm delete')"]);
    });

    it("escapes quotes in role and name selectors", () => {
        const selectors = buildSelectors("button", "O'Brien", null);
        expect(selectors[0]).toBe("getByRole('button', { name: 'O\\'Brien' })");
    });
});
