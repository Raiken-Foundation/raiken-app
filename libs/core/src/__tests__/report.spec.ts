import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    isCiRunReportShape,
    parseCiRunReport,
    parsePlaywrightReport,
} from "../testing/report-parser";
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

    it("carries Raiken's brand identity, not a generic dashboard look", async () => {
        const run = parsePlaywrightReport(sampleReport);
        const written = await writeTestRunReport({ projectPath: dir, run, formats: ["html"] });
        const html = fs.readFileSync(written.htmlPath as string, "utf-8");

        // The pixel [R] brand mark (adapted from `logo.tsx`) on its purple tile.
        expect(html).toContain('aria-label="Raiken"');
        expect(html).toContain("#a78bfa");
        // Real theme tokens, not the old ad hoc GitHub-Primer-style palette.
        expect(html).toContain("--accent:#a78bfa");
        expect(html).toContain("JetBrains Mono");
        expect(html).toContain("Inter");
        // The old generic look this replaces: blue accent, rounded cards, sans stack.
        expect(html).not.toContain("#2f81f7");
        expect(html).not.toContain("border-radius:10px");
        expect(html).not.toContain('-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto');
        // Lowercase, `─`-prefixed section voice instead of a generic bold header.
        expect(html).toContain("suite-head");
        expect(html).toContain('content:"─ "');
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
                                            error: {
                                                message: "[2mexpect([22m x [39mfailed\u001b[31m!",
                                            },
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

    it("writes a Markdown report with a stat line, suite headers, and error snippets", async () => {
        const run = parsePlaywrightReport(sampleReport);
        const written = await writeTestRunReport({ projectPath: dir, run, formats: ["markdown"] });
        const mdPath = written.files.find((f) => f.endsWith(".md"));
        expect(mdPath).toBeTruthy();

        const md = fs.readFileSync(mdPath as string, "utf-8");
        expect(md).toContain("# Raiken Test Report");
        expect(md).toContain("## overview.spec.ts &gt; Overview");
        expect(md).toContain("**1/2 passed**");
        expect(md).toContain("loads the page");
        expect(md).toContain("shows the widget");
        expect(md).toContain("expect(locator).toBeVisible() failed");
        expect(fs.existsSync(path.join(dir, "test-reports", "latest.md"))).toBe(true);
    });

    it("HTML-escapes Markdown-structural characters in titles/suite/test names", async () => {
        const run = parsePlaywrightReport({
            stats: { expected: 1, unexpected: 0, skipped: 0, duration: 10 },
            suites: [
                {
                    title: "*bold suite* <script>alert(1)</script>",
                    specs: [
                        {
                            id: "m1",
                            title: "click [the] `menu` & _win_",
                            tests: [{ results: [{ status: "passed", duration: 5 }] }],
                        },
                    ],
                },
            ],
        });
        const written = await writeTestRunReport({
            projectPath: dir,
            run,
            title: "<b>Injected</b> Title",
            formats: ["markdown"],
        });
        const mdPath = written.files.find((f) => f.endsWith(".md"));
        const md = fs.readFileSync(mdPath as string, "utf-8");
        expect(md).not.toContain("<script>");
        expect(md).not.toContain("<b>Injected</b>");
        expect(md).toContain("&lt;script&gt;");
        expect(md).toContain("\\*bold suite\\*");
        expect(md).toContain("\\`menu\\`");
        expect(md).toContain("\\_win\\_");
        expect(md).toContain("\\[the\\]");
    });

    it("links (does not embed) video and trace attachments", async () => {
        fs.mkdirSync(path.join(dir, "test-results", "vid"), { recursive: true });
        fs.writeFileSync(path.join(dir, "test-results", "vid", "video.webm"), Buffer.from("x"));
        fs.writeFileSync(path.join(dir, "test-results", "vid", "trace.zip"), Buffer.from("x"));

        const run = parsePlaywrightReport({
            stats: { expected: 1, unexpected: 0, skipped: 0, duration: 10 },
            suites: [
                {
                    title: "media.spec.ts",
                    specs: [
                        {
                            id: "v1",
                            title: "records a video",
                            tests: [
                                {
                                    results: [
                                        {
                                            status: "passed",
                                            duration: 5,
                                            attachments: [
                                                {
                                                    name: "video",
                                                    contentType: "video/webm",
                                                    path: "test-results/vid/video.webm",
                                                },
                                                {
                                                    name: "trace",
                                                    contentType: "application/zip",
                                                    path: "test-results/vid/trace.zip",
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
        });
        const written = await writeTestRunReport({ projectPath: dir, run, formats: ["html"] });
        expect(written.screenshotsEmbedded).toBe(0);
        const html = fs.readFileSync(written.htmlPath as string, "utf-8");
        expect(html).toContain("video.webm");
        expect(html).toContain("trace.zip");
        expect(html).not.toContain("data:video");
    });

    it("defends the embedded data: URI against a malformed contentType/body", async () => {
        const run = parsePlaywrightReport({
            stats: { expected: 0, unexpected: 1, skipped: 0, duration: 10 },
            suites: [
                {
                    title: "hostile.spec.ts",
                    specs: [
                        {
                            id: "h1",
                            title: "inline attachment",
                            tests: [
                                {
                                    results: [
                                        {
                                            status: "failed",
                                            duration: 5,
                                            attachments: [
                                                {
                                                    name: "screenshot",
                                                    contentType:
                                                        'image/png"><script>alert(1)</script>',
                                                    body: "not-valid-base64!!",
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
        });
        const written = await writeTestRunReport({ projectPath: dir, run, formats: ["html"] });
        expect(written.screenshotsEmbedded).toBe(0);
        const html = fs.readFileSync(written.htmlPath as string, "utf-8");
        expect(html).not.toContain("<script>alert(1)</script>");
    });
});

describe("CI run report bridge", () => {
    let dir: string;
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-ci-report-"));
    });
    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const ciReport = {
        schemaVersion: 1 as const,
        ran: true,
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:05.000Z",
        durationMs: 5000,
        tests: [
            {
                testFile: "e2e/login.spec.ts",
                testName: "logs in",
                status: "passed" as const,
                duration: 900,
            },
            {
                testFile: "e2e/checkout.spec.ts",
                testName: "completes checkout",
                status: "failed" as const,
                duration: 1500,
                error: { message: "Timed out waiting for selector", selector: "#submit" },
            },
        ],
        summary: { total: 2, passed: 1, failed: 1, timedOut: 0, errored: 0 },
    };

    it("recognizes a CI results.json and rejects a raw Playwright reporter payload", () => {
        expect(isCiRunReportShape(ciReport)).toBe(true);
        expect(isCiRunReportShape(sampleReport)).toBe(false);
        expect(isCiRunReportShape(null)).toBe(false);
        expect(isCiRunReportShape("nope")).toBe(false);
    });

    it("adapts a CI run report into the shared ParsedPlaywrightRun shape", () => {
        const run = parseCiRunReport(ciReport);
        expect(run.summary.tests.passed).toBe(1);
        expect(run.summary.tests.failed).toBe(1);
        expect(run.summary.tests.total).toBe(2);
        expect(run.summary.timeSeconds).toBe(5);
        expect(run.tests).toHaveLength(2);

        const failed = run.tests.find((t) => t.status === "failed");
        expect(failed?.name).toBe("completes checkout");
        expect(failed?.suite).toBe("e2e/checkout.spec.ts");
        expect(failed?.error?.message).toContain("Timed out waiting for selector");
        expect(failed?.error?.message).toContain("#submit");
    });

    it("round-trips through writeTestRunReport like a normal Playwright run", async () => {
        const run = parseCiRunReport(ciReport);
        const written = await writeTestRunReport({ projectPath: dir, run, formats: ["html"] });
        const html = fs.readFileSync(written.htmlPath as string, "utf-8");
        expect(html).toContain("completes checkout");
        expect(html).toContain("logs in");
    });
});
