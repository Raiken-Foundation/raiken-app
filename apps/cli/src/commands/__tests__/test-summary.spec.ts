import { describe, expect, it } from "vitest";
import { looksLikeNoTestsCollected, stripAnsi, summarizeRunForCli } from "../test";

const failedCase = {
    name: "increments the cart count",
    suite: "cart.spec.ts > cart",
    status: "failed",
    duration: 5123,
    error: {
        message: 'expect(locator).toHaveText(expected) failed\n\nExpected: "2"',
        location: { file: "/proj/e2e/cart.spec.ts", line: 6, column: 5 },
    },
};

describe("summarizeRunForCli", () => {
    it("names every failing test with suite, file, and line", () => {
        const summary = summarizeRunForCli({
            tests: [
                failedCase,
                { name: "shows heading", suite: "home.spec.ts > home", status: "passed" },
            ],
            summary: { timeSeconds: 6.2 },
        });

        expect(summary.passed).toBe(1);
        expect(summary.failed).toBe(1);
        expect(summary.failures).toEqual([
            {
                name: "cart › increments the cart count",
                file: "/proj/e2e/cart.spec.ts",
                line: 6,
                durationMs: 5123,
            },
        ]);
        expect(summary.error).toContain("toHaveText");
    });

    it("strips the duplicated '<file> > ' prefix Playwright adds to suites", () => {
        const summary = summarizeRunForCli({ tests: [failedCase] });
        expect(summary.failures[0]?.name).toBe("cart › increments the cart count");
    });

    it("keeps the suite when it does not start with the file name", () => {
        const summary = summarizeRunForCli({
            tests: [
                {
                    ...failedCase,
                    suite: "checkout flow",
                },
            ],
        });
        expect(summary.failures[0]?.name).toBe("checkout flow › increments the cart count");
    });

    it("derives durationMs from the reporter stats when present", () => {
        const summary = summarizeRunForCli({
            tests: [],
            summary: { timeSeconds: 6.2, reporter: { durationMs: 6200 } },
        });
        expect(summary.durationMs).toBe(6200);
    });

    it("falls back to wall-clock seconds for durationMs", () => {
        const summary = summarizeRunForCli({ tests: [], summary: { timeSeconds: 6.2 } });
        expect(summary.durationMs).toBe(6200);
    });

    it("caps the failure list and surfaces stderr when nothing executed", () => {
        const tests = Array.from({ length: 12 }, (_, i) => ({
            ...failedCase,
            name: `failing ${i}`,
        }));
        const summary = summarizeRunForCli({ tests });
        expect(summary.failures.length).toBe(10);
        expect(summary.failed).toBe(12);

        const empty = summarizeRunForCli({ tests: [] }, "Error: playwright crashed\nstack");
        expect(empty.error).toContain("playwright crashed");
        expect(empty.failures).toEqual([]);
    });
});

describe("looksLikeNoTestsCollected", () => {
    it("recognizes the config failure Playwright reports as a build error", () => {
        const summary = summarizeRunForCli(
            {
                tests: [
                    {
                        name: "Compilation error",
                        suite: "Build errors",
                        status: "failed",
                        error: {
                            message:
                                "Error: No tests found.\nMake sure that arguments are regular expressions matching test files.",
                        },
                    },
                ],
            },
            "",
        );
        expect(looksLikeNoTestsCollected(summary.error)).toBe(true);
    });

    it("leaves a genuine assertion failure to the repair path", () => {
        const summary = summarizeRunForCli({ tests: [failedCase] });
        expect(looksLikeNoTestsCollected(summary.error)).toBe(false);
        expect(looksLikeNoTestsCollected(undefined)).toBe(false);
    });
});

describe("stripAnsi", () => {
    it("removes SGR escape sequences from Playwright error excerpts", () => {
        expect(stripAnsi("\u001b[31mError: \u001b[39mexpect \u001b[2mthing\u001b[22m")).toBe(
            "Error: expect thing",
        );
    });

    it("leaves plain text untouched", () => {
        expect(stripAnsi("Error: boom")).toBe("Error: boom");
    });
});
