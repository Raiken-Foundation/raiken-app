import { describe, expect, it } from "vitest";
import { validateSelectorGrounding } from "../agent/grounding";

const CAPTURED = "The catalog shows Pulse Ergonomic Mouse for $59.00.";

describe("assertion-value grounding", () => {
    it("flags a toHaveText value absent from capture", () => {
        const report = validateSelectorGrounding(
            `await expect(page.getByTestId("discount")).toHaveText("$5.90");`,
            [CAPTURED],
        );
        expect(
            report.warnings.some((w) => w.kind === "unknown_value" && w.locator.includes("$5.90")),
        ).toBe(true);
    });

    it("does not flag a value the scenario explicitly stated", () => {
        const report = validateSelectorGrounding(
            `await expect(page.getByTestId("discount")).toHaveText("$5.90");`,
            [CAPTURED],
            undefined,
            ["$5.90"],
        );
        expect(report.warnings.filter((w) => w.kind === "unknown_value")).toEqual([]);
    });

    it("does not flag a value the test itself typed", () => {
        const code = `
await page.getByTestId("title-input").fill("Test Card Title");
await expect(page.getByTestId("card-title")).toContainText("Test Card Title");`;
        const report = validateSelectorGrounding(code, [CAPTURED]);
        expect(report.warnings.filter((w) => w.kind === "unknown_value")).toEqual([]);
    });

    it("does not flag a value present in captured text", () => {
        const report = validateSelectorGrounding(
            `await expect(page.getByText("Pulse Ergonomic Mouse")).toHaveText("$59.00");`,
            [CAPTURED],
        );
        expect(report.warnings.filter((w) => w.kind === "unknown_value")).toEqual([]);
    });
});
