import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePlaywrightReport } from "../testing/report-parser";
import { writeTestRunReport } from "../testing/report-writer";

const sampleReport = {
    stats: { expected: 1, unexpected: 1, skipped: 0, duration: 4200 },
    suites: [
        {
            title: "overview.spec.ts",
            suites: [
                {
                    title: "Overview",
                    specs: [
                        {
                            id: "a1",
                            title: "loads the page",
                            tests: [{ results: [{ status: "passed", duration: 900 }] }],
                        },
                        {
                            id: "a2",
                            title: "shows the widget",
                            tests: [
                                {
                                    results: [
                                        {
                                            status: "failed",
                                            duration: 1200,
                                            error: {
                                                message: "expect(locator).toBeVisible() failed",
                                                snippet: "> 12 | await expect(x).toBeVisible()",
                                                location: {
                                                    file: "overview.spec.ts",
                                                    line: 12,
                                                    column: 5,
                                                },
                                            },
                                            attachments: [
                                                {
                                                    name: "screenshot",
                                                    contentType: "image/png",
                                                    path: "test-results/a2/test-failed-1.png",
                                                },
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

describe("parsePlaywrightReport", () => {
    it("extracts summary, tests, errors and attachments", () => {
        const run = parsePlaywrightReport(sampleReport);
        expect(run.summary.tests.passed).toBe(1);
        expect(run.summary.tests.failed).toBe(1);
        expect(run.summary.tests.total).toBe(2);
        expect(run.tests).toHaveLength(2);

        const failed = run.tests.find((t) => t.status === "failed");
        expect(failed?.name).toBe("shows the widget");
        expect(failed?.error?.location?.line).toBe(12);
        expect(failed?.attachments?.[0]?.contentType).toBe("image/png");
    });

    it("returns an empty run for malformed input", () => {
        expect(parsePlaywrightReport(null).tests).toEqual([]);
        expect(parsePlaywrightReport("nope").summary.tests.total).toBe(0);
    });
});

describe("writeTestRunReport", () => {
    let dir: string;
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-report-"));
        // Create a tiny 1x1 PNG so the writer can embed a real screenshot.
        const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            "base64",
        );
        fs.mkdirSync(path.join(dir, "test-results", "a2"), { recursive: true });
        fs.writeFileSync(path.join(dir, "test-results", "a2", "test-failed-1.png"), png);
    });
    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("writes a self-contained HTML report with an embedded screenshot", async () => {
        const run = parsePlaywrightReport(sampleReport);
        const written = await writeTestRunReport({
            projectPath: dir,
            run,
            formats: ["html", "json"],
        });

        expect(written.htmlPath).toBeTruthy();
        expect(written.screenshotsEmbedded).toBe(1);
        expect(fs.existsSync(path.join(dir, "test-reports", "latest.html"))).toBe(true);

        const html = fs.readFileSync(written.htmlPath as string, "utf-8");
        expect(html).toContain("Raiken Test Report");
        expect(html).toContain("data:image/png;base64,"); // embedded screenshot
        expect(html).toContain("shows the widget");

        const jsonFile = written.files.find((f) => f.endsWith(".json"));
        expect(jsonFile && fs.existsSync(jsonFile)).toBe(true);
    });

    it("strips ANSI color codes from error text", async () => {
        const run = parsePlaywrightReport({
            stats: { expected: 0, unexpected: 1, skipped: 0, duration: 10 },
            suites: [
                {
                    title: "x.spec.ts",
                    specs: [
                        {
                            id: "e1",
                            title: "ansi test",
                            tests: [
                                {
                                    results: [
                                        {
                                            status: "failed",
                                            duration: 5,
                                            // Orphaned SGR codes (ESC dropped) plus a real ESC seq.
                                            error: { message: "[2mexpect([22m x [39mfailed\u001b[31m!" },
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        });
        const written = await writeTestRunReport({ projectPath: dir, run, formats: ["html"] });
        const html = fs.readFileSync(written.htmlPath as string, "utf-8");
        expect(html).not.toContain("[22m");
        expect(html).not.toContain("[39m");
        expect(html).not.toContain("[2m");
        expect(html).toContain("expect(");
    });
});
