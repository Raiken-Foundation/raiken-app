import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { mapReportToTestRunResults, parsePlaywrightJsonReport } from "../playwright-json-report";
import type { PlaywrightJsonReport } from "../playwright-json-types";
import { parsePlaywrightReport } from "../report-parser";

const fixturesDir = path.join(__dirname, "fixtures");

function loadFixture(name: string): PlaywrightJsonReport {
    return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf-8"));
}

describe("Playwright JSON reporter goldens", () => {
    it("nested pass: walked counts align with reporter stats", () => {
        const report = loadFixture("playwright-nested-pass.json");
        const parsed = parsePlaywrightReport(report);

        expect(parsed.summary.reporter).toEqual({
            expected: 2,
            unexpected: 0,
            skipped: 0,
            durationMs: 3100,
        });
        expect(parsed.summary.tests).toEqual({ passed: 2, failed: 0, total: 2 });
        expect(parsed.summary.timeSeconds).toBe(3.1);
        expect(parsed.tests.map((t) => t.name)).toEqual([
            "adds item to cart",
            "completes purchase",
        ]);
        expect(parsed.tests[0]?.suite).toBe("checkout.spec.ts > Checkout");
    });

    it("compile-error-only: surfaces build errors without specs", () => {
        const report = loadFixture("playwright-compile-error.json");
        const parsed = parsePlaywrightReport(report);

        expect(parsed.tests).toHaveLength(1);
        expect(parsed.tests[0]?.suite).toBe("Build errors");
        expect(parsed.tests[0]?.status).toBe("failed");
        expect(parsed.summary.tests.failed).toBe(1);
        expect(parsed.summary.reporter?.unexpected).toBe(1);
    });

    it("repeat/flaky: walked merge diverges from reporter unexpected count by design", () => {
        const report = loadFixture("playwright-repeat-flaky.json");
        const runResults = mapReportToTestRunResults(report, "workspace.spec.ts");
        const parsed = parsePlaywrightReport(report);

        expect(runResults).toHaveLength(1);
        expect(runResults[0]?.status).toBe("flaky");
        // Playwright stats count two spec entries (1 pass + 1 fail repetition).
        expect(parsed.summary.reporter).toMatchObject({ expected: 1, unexpected: 1 });
        // Raiken merges repetitions — one flaky verdict, one failed dashboard row.
        expect(parsed.summary.tests).toEqual({ passed: 0, failed: 1, total: 1 });
    });

    it("interrupted status maps to failed, not skipped", () => {
        const report = loadFixture("playwright-interrupted.json");
        const runResults = mapReportToTestRunResults(report, "auth.spec.ts");
        const parsed = parsePlaywrightReport(report);

        expect(runResults[0]?.status).toBe("failed");
        expect(parsed.tests[0]?.status).toBe("failed");
        expect(parsed.summary.tests.failed).toBe(1);
        expect(parsed.summary.reporter?.unexpected).toBe(1);
    });

    it("documents summary semantics in parsePlaywrightJsonReport", () => {
        const report = loadFixture("playwright-nested-pass.json");
        const parsed = parsePlaywrightJsonReport(report, "checkout.spec.ts");

        // Walked counts are authoritative for dashboard tallies.
        expect(parsed.summary.tests.passed).toBe(parsed.summary.reporter?.expected);
        expect(parsed.summary.tests.failed).toBe(parsed.summary.reporter?.unexpected);
    });
});
