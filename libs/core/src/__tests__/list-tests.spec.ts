import { describe, expect, it } from "vitest";
import { listTestsFromReport } from "../testing/playwright-json-report";

describe("listTestsFromReport", () => {
    it("flattens nested suites into titled rows with file/line", () => {
        const listed = listTestsFromReport({
            suites: [
                {
                    title: "login.spec.ts",
                    suites: [
                        {
                            title: "Login",
                            specs: [
                                {
                                    id: "s1",
                                    title: "signs in with valid credentials",
                                    file: "e2e/login.spec.ts",
                                    line: 10,
                                },
                            ],
                            suites: [
                                {
                                    title: "edge cases",
                                    specs: [
                                        {
                                            id: "s2",
                                            title: "locks out after 5 attempts",
                                            file: "e2e/login.spec.ts",
                                            line: 42,
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
                {
                    title: "cart.spec.ts",
                    specs: [{ id: "s3", title: "adds an item", file: "e2e/cart.spec.ts", line: 4 }],
                },
            ],
        });

        expect(listed).toEqual([
            {
                title: "signs in with valid credentials",
                suite: "login.spec.ts > Login",
                file: "e2e/login.spec.ts",
                line: 10,
            },
            {
                title: "locks out after 5 attempts",
                suite: "login.spec.ts > Login > edge cases",
                file: "e2e/login.spec.ts",
                line: 42,
            },
            {
                title: "adds an item",
                suite: "cart.spec.ts",
                file: "e2e/cart.spec.ts",
                line: 4,
            },
        ]);
    });

    it("returns an empty list for an empty report", () => {
        expect(listTestsFromReport({})).toEqual([]);
        expect(listTestsFromReport({ suites: [] })).toEqual([]);
    });

    it("omits file/line when the report does not carry them", () => {
        const listed = listTestsFromReport({
            suites: [{ title: "a.spec.ts", specs: [{ title: "works" }] }],
        });
        expect(listed).toEqual([{ title: "works", suite: "a.spec.ts" }]);
    });
});
