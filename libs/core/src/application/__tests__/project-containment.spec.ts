import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTestRunReport } from "../../testing/report-writer";
import { IndexingApplication } from "../indexing";

describe("project containment at application entry points", () => {
    let root: string;
    let project: string;
    let outside: string;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-containment-"));
        project = path.join(root, "project");
        outside = path.join(root, "outside");
        fs.mkdirSync(project);
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(project, "linked"), "dir");
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
    it("rejects an indexing target outside the project before creating state", async () => {
        const app = new IndexingApplication(project);
        await expect(app.buildCodeGraph({ path: outside })).rejects.toThrow(/outside project/);
        await expect(app.buildCodeGraph({ path: "linked" })).rejects.toThrow(/outside project/);
        expect(fs.readdirSync(outside)).toEqual([]);
    });
    it("rejects report output through a symlink and never embeds an escaped attachment", async () => {
        const secret = "synthetic-private-content";
        fs.writeFileSync(path.join(outside, "secret.png"), secret);
        const run = {
            tests: [
                {
                    id: "a",
                    name: "a",
                    suite: "a",
                    status: "failed" as const,
                    attachments: [
                        { name: "screenshot", contentType: "image/png", path: "linked/secret.png" },
                    ],
                },
            ],
            summary: {
                suites: { total: 1, passed: 0, failed: 1 },
                tests: { total: 1, passed: 0, failed: 1 },
                timeSeconds: 0,
            },
        };
        await expect(
            writeTestRunReport({ projectPath: project, run, outputDir: "linked/reports" }),
        ).rejects.toThrow(/outside project/);
        const report = await writeTestRunReport({ projectPath: project, run });
        expect(report.screenshotsEmbedded).toBe(0);
        expect(fs.readFileSync(report.htmlPath ?? "", "utf8")).not.toContain(
            Buffer.from(secret).toString("base64"),
        );
        expect(fs.existsSync(path.join(outside, "reports"))).toBe(false);
    });
});

describe("report leaf symlinks", () => {
    it.each([
        "html",
        "md",
        "json",
    ])("atomically replaces latest.%s without following its symlink", async (ext) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-report-leaf-"));
        try {
            const project = path.join(root, "project");
            const reports = path.join(project, "test-reports");
            fs.mkdirSync(reports, { recursive: true });
            const outside = path.join(root, "outside");
            fs.writeFileSync(outside, "unchanged");
            fs.symlinkSync(outside, path.join(reports, `latest.${ext}`));
            const run = {
                tests: [],
                summary: {
                    suites: { total: 0, passed: 0, failed: 0 },
                    tests: { total: 0, passed: 0, failed: 0 },
                    timeSeconds: 0,
                },
            };
            await writeTestRunReport({
                projectPath: project,
                run,
                formats: ["html", "markdown", "json"],
            });
            expect(fs.readFileSync(outside, "utf8")).toBe("unchanged");
            expect(fs.lstatSync(path.join(reports, `latest.${ext}`)).isSymbolicLink()).toBe(false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    it("rejects every escaped reindex input before initializing", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "raiken-reindex-"));
        try {
            const project = path.join(root, "project");
            fs.mkdirSync(project);
            const outside = path.join(root, "outside.ts");
            fs.writeFileSync(outside, "export const outside = true;");
            fs.symlinkSync(outside, path.join(project, "linked.ts"));
            for (const file of [outside, "../outside.ts", "linked.ts"]) {
                await expect(
                    new IndexingApplication(project).reindexFiles({ files: [file] }),
                ).rejects.toThrow(/outside project/);
            }
            expect(fs.readdirSync(project)).toEqual(["linked.ts"]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
