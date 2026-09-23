import { describe, expect, it } from "vitest";
import {
    buildResultStateKey,
    buildSuiteTree,
    categorizeArtifacts,
    flattenSuiteTree,
    isFailureOutcome,
    outcomeLabel,
    partitionResults,
    splitSuitePath,
    statusBucket,
    stripAnsiCodes,
} from "../model/report-model";
import type { TestResult } from "../types";

function test(id: string, overrides: Partial<TestResult> = {}): TestResult {
    return {
        id,
        name: `Test ${id}`,
        suite: "Suite",
        status: "passed",
        ...overrides,
    };
}

describe("stripAnsiCodes", () => {
    it("removes ANSI color sequences from error messages", () => {
        expect(stripAnsiCodes("\x1b[31mError\x1b[0m")).toBe("Error");
    });
});

describe("splitSuitePath", () => {
    it("splits nested suite breadcrumbs from core transport", () => {
        expect(splitSuitePath("Auth > Login > OAuth")).toEqual(["Auth", "Login", "OAuth"]);
    });
});

describe("buildSuiteTree", () => {
    it("groups flat transport rows into nested suite nodes", () => {
        const tree = buildSuiteTree([
            test("1", { suite: "Auth > Login", name: "valid credentials" }),
            test("2", { suite: "Auth > Login", name: "invalid password" }),
            test("3", { suite: "Auth > Signup", name: "creates account" }),
        ]);

        expect(tree).toHaveLength(1);
        expect(tree[0]?.name).toBe("Auth");
        expect(tree[0]?.children.map((node) => node.name)).toEqual(["Login", "Signup"]);
        expect(tree[0]?.children[0]?.tests.map((row) => row.name)).toEqual([
            "valid credentials",
            "invalid password",
        ]);
    });
});

describe("flattenSuiteTree", () => {
    it("preserves depth-first ordering for render", () => {
        const tree = buildSuiteTree([
            test("1", { suite: "A > B", name: "b-test" }),
            test("2", { suite: "A > C", name: "c-test" }),
        ]);
        expect(flattenSuiteTree(tree).map((row) => row.name)).toEqual(["b-test", "c-test"]);
    });
});

describe("Playwright outcome semantics", () => {
    it("treats flaky and timeout as failure outcomes", () => {
        expect(isFailureOutcome("flaky")).toBe(true);
        expect(isFailureOutcome("timeout")).toBe(true);
        expect(isFailureOutcome("skipped")).toBe(false);
    });

    it("maps flaky and timeout to failed visual buckets", () => {
        expect(statusBucket("flaky")).toBe("failed");
        expect(statusBucket("timeout")).toBe("failed");
        expect(statusBucket("skipped")).toBe("skipped");
    });

    it("labels flaky and timeout distinctly in detail headers", () => {
        expect(outcomeLabel("flaky")).toBe("FLAKY");
        expect(outcomeLabel("timeout")).toBe("TIMEOUT");
        expect(outcomeLabel("skipped")).toBe("SKIPPED");
    });

    it("partitions skipped separately from failures", () => {
        const parts = partitionResults([
            test("1", { status: "passed" }),
            test("2", { status: "failed" }),
            test("3", { status: "skipped" }),
        ]);
        expect(parts.passed).toHaveLength(1);
        expect(parts.skipped).toHaveLength(1);
        expect(parts.failed).toHaveLength(1);
    });
});

describe("categorizeArtifacts", () => {
    it("groups screenshots, videos, traces, and other attachments", () => {
        const grouped = categorizeArtifacts([
            test("1", {
                status: "failed",
                attachments: [
                    { name: "shot.png", contentType: "image/png", path: "test-results/a.png" },
                    { name: "video", contentType: "video/webm", path: "test-results/a.webm" },
                    { name: "trace", contentType: "application/zip", path: "test-results/trace.zip" },
                    { name: "stdout", contentType: "text/plain", path: "test-results/out.txt" },
                ],
            }),
        ]);

        expect(grouped.screenshots).toHaveLength(1);
        expect(grouped.videos).toHaveLength(1);
        expect(grouped.traces).toHaveLength(1);
        expect(grouped.other).toHaveLength(1);
        expect(grouped.all[0]?.testStatus).toBe("failed");
    });
});

describe("buildResultStateKey", () => {
    it("changes when a test status changes", () => {
        const before = buildResultStateKey([test("1", { status: "failed" })]);
        const after = buildResultStateKey([test("1", { status: "passed" })]);
        expect(before).not.toBe(after);
    });
});
