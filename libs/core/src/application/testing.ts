import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadAutonomySettings } from "../agent/agent";
import { getProvider, resolveAIConfig } from "../agent/ai-providers";
import { loadTestDirectory } from "../config";
import { CodeGraphDB } from "../database/db";
import { conflictError, internalError, notFoundError, validationError } from "../errors";
import { getQuickInterpretation, getTestRepair } from "../testing/interpreter";
import { playwrightConfigExists, writePlaywrightConfig } from "../testing/playwright-config";
import { extractReporterJson } from "../testing/playwright-json-report";
import {
    isCiRunReportShape,
    parseCiRunReport,
    parsePlaywrightReport,
} from "../testing/report-parser";
import { type ReportFormat, writeTestRunReport } from "../testing/report-writer";
import { saveTestArtifact } from "../testing/save-test-artifact";
import { testExecutionService } from "../testing/test-execution-service";
import type { ProjectApplicationContext } from "./context";
import { assertUnderProjectRoot, writeFileAtomic } from "./paths";

/** Project-scoped test execution, repair, reporting, and artifact management. */
export class TestingApplication implements ProjectApplicationContext {
    readonly projectPath: string;

    constructor(projectPath: string) {
        this.projectPath = projectPath;
    }

    runTests(input: Parameters<typeof testExecutionService.run>[1]) {
        return testExecutionService.run(this.projectPath, input);
    }

    cancelTestRun(runId?: string) {
        return {
            success: testExecutionService.cancel(this.projectPath, runId),
        };
    }

    async generateTestReport(input: {
        report?: unknown;
        rawReportJson?: string;
        rawOutput?: string;
        testFile?: string;
        title?: string;
        formats?: ReportFormat[];
        outputDir?: string;
        embedScreenshots?: boolean;
    }) {
        let reportJson: unknown = input.report;
        if (reportJson === undefined && input.rawReportJson) {
            reportJson = extractReporterJson(input.rawReportJson) ?? undefined;
        }
        if (reportJson === undefined) {
            throw validationError(
                "No Playwright report provided. Pass `report` (parsed JSON) or `rawReportJson`.",
            );
        }

        const run = isCiRunReportShape(reportJson)
            ? parseCiRunReport(reportJson)
            : parsePlaywrightReport(reportJson);

        const outputDir = input.outputDir ?? "test-reports";
        assertUnderProjectRoot(outputDir, this.projectPath);

        const written = await writeTestRunReport({
            projectPath: this.projectPath,
            run,
            rawOutput: input.rawOutput,
            testFile: input.testFile,
            title: input.title,
            formats: input.formats,
            outputDir,
            embedScreenshots: input.embedScreenshots,
        });

        return {
            outputDir: path.relative(this.projectPath, written.outputDir) || outputDir,
            files: written.files.map((f) => path.relative(this.projectPath, f)),
            htmlPath: written.htmlPath
                ? path.relative(this.projectPath, written.htmlPath)
                : undefined,
            screenshotsEmbedded: written.screenshotsEmbedded,
            summary: written.summary,
        };
    }

    async checkPlaywrightConfig() {
        const exists = await playwrightConfigExists(this.projectPath);
        return { exists };
    }

    async generatePlaywrightConfig(input: {
        testDir?: string;
        parallel?: boolean;
        workers?: number | "auto";
        retries?: number;
        timeout?: number;
    }) {
        const exists = await playwrightConfigExists(this.projectPath);
        if (exists) {
            return {
                success: false,
                path: "",
                message:
                    "playwright.config.ts already exists. Delete it first if you want to regenerate.",
                exists: true,
            };
        }

        const result = await writePlaywrightConfig(this.projectPath, input);
        return { ...result, exists: false };
    }

    async interpretTestResults(input: {
        testResults: Array<{
            name: string;
            suite: string;
            status: "passed" | "failed" | "skipped";
            duration?: number;
            error?: {
                message?: string;
                snippet?: string;
                location?: { file: string; line: number; column: number };
            };
            attachments?: Array<{
                name: string;
                contentType?: string;
                path?: string;
            }>;
        }>;
        testCode: string;
        testFilePath?: string;
        rawOutput?: string;
        sourceCode?: string;
        domContext?: Parameters<typeof getQuickInterpretation>[0]["domContext"];
        pageSummaries?: string[];
    }) {
        const resolved = resolveAIConfig(this.projectPath);
        const provider = getProvider(resolved.provider);
        const requiresKey = provider.envVars.length > 0;
        if (requiresKey && !resolved.apiKey) {
            const keyHint = provider.envVars[0] ?? "an API key";
            return {
                interpretation: `Error: No API key configured for ${provider.label}. Set ${keyHint} or add it in Settings.`,
                error: true,
                testCodeSource: null as
                    | "disk"
                    | "client-snapshot"
                    | "client-snapshot-fallback"
                    | null,
            };
        }

        let testCode = input.testCode;
        let testCodeSource: "disk" | "client-snapshot" | "client-snapshot-fallback" =
            "client-snapshot";
        const rawPath = input.testFilePath;
        if (rawPath && !rawPath.startsWith("scratch:")) {
            try {
                const candidate = assertUnderProjectRoot(rawPath, this.projectPath);
                testCode = await fs.readFile(candidate, "utf-8");
                testCodeSource = "disk";
            } catch {
                testCodeSource = "client-snapshot-fallback";
            }
        }

        try {
            const interpretation = await getQuickInterpretation(
                {
                    testResults: input.testResults,
                    testCode,
                    testFilePath: input.testFilePath,
                    rawOutput: input.rawOutput,
                    sourceCode: input.sourceCode,
                    domContext: input.domContext,
                    pageSummaries: input.pageSummaries,
                    projectPath: this.projectPath,
                },
                {
                    apiKey: resolved.apiKey ?? "",
                    model: resolved.model,
                    provider: resolved.provider,
                    baseURL: resolved.baseURL,
                },
            );
            return { interpretation, error: false, testCodeSource };
        } catch (error) {
            console.error("Interpretation error:", error);
            const raw = error instanceof Error ? error.message : String(error);
            let interpretation = `Error interpreting results: ${raw}`;
            if (raw.includes("402") || raw.includes("credits")) {
                interpretation = `Insufficient credits/quota for AI analysis with ${provider.label}. Check your account balance or switch providers in Settings, then try again.`;
            }
            return { interpretation, error: true, testCodeSource };
        }
    }

    async repairTestResults(input: {
        testResults: Array<{
            name: string;
            suite: string;
            status: "passed" | "failed" | "skipped";
            duration?: number;
            error?: {
                message?: string;
                snippet?: string;
                location?: { file: string; line: number; column: number };
            };
            attachments?: Array<{
                name: string;
                contentType?: string;
                path?: string;
            }>;
        }>;
        testCode: string;
        testFilePath?: string;
        rawOutput?: string;
        sourceCode?: string;
        interpretation?: string;
        domContext?: Parameters<typeof getTestRepair>[0]["domContext"];
        pageSummaries?: string[];
        provenSelectors?: Parameters<typeof getTestRepair>[0]["provenSelectors"];
        sourceSelectors?: Parameters<typeof getTestRepair>[0]["sourceSelectors"];
        scenario?: Parameters<typeof getTestRepair>[0]["scenario"];
        allowWeaken?: boolean;
        signal?: AbortSignal;
    }) {
        const resolved = resolveAIConfig(this.projectPath);
        const provider = getProvider(resolved.provider);
        const requiresKey = provider.envVars.length > 0;
        if (requiresKey && !resolved.apiKey) {
            const keyHint = provider.envVars[0] ?? "an API key";
            return {
                fixedCode: null as string | null,
                originalCode: input.testCode,
                mode: null as "edits" | "full" | null,
                editCount: null as number | null,
                matchFailed: false,
                filePath: input.testFilePath ?? null,
                error: `No API key configured for ${provider.label}. Set ${keyHint} or add it in Settings.`,
            };
        }

        let testCode = input.testCode;
        const rawPath = input.testFilePath;
        if (rawPath && !rawPath.startsWith("scratch:")) {
            try {
                const candidate = assertUnderProjectRoot(rawPath, this.projectPath);
                testCode = await fs.readFile(candidate, "utf-8");
            } catch {
                // A missing or untrusted path never overrides the client snapshot.
            }
        }

        const images: Array<{ name: string; data: Uint8Array; mediaType: string }> = [];
        const MAX_REPAIR_IMAGES = 2;
        const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
        for (const result of input.testResults) {
            if (images.length >= MAX_REPAIR_IMAGES) break;
            const atts = [...(result.attachments ?? [])].sort((a, b) => {
                const aFail = a.name?.toLowerCase().includes("test-failed") ? 0 : 1;
                const bFail = b.name?.toLowerCase().includes("test-failed") ? 0 : 1;
                return aFail - bFail;
            });
            for (const att of atts) {
                if (images.length >= MAX_REPAIR_IMAGES) break;
                const ct = (att.contentType ?? "").toLowerCase();
                if (!ct.startsWith("image/") || !att.path) continue;
                try {
                    const candidate = assertUnderProjectRoot(att.path, this.projectPath);
                    const stat = await fs.stat(candidate);
                    if (stat.size > MAX_IMAGE_BYTES) continue;
                    const data = await fs.readFile(candidate);
                    images.push({ name: att.name, data: new Uint8Array(data), mediaType: ct });
                } catch {
                    // skip
                }
            }
        }

        try {
            const { fixedCode, originalCode, mode, editCount, matchFailed, error } =
                await getTestRepair(
                    {
                        testResults: input.testResults,
                        testCode,
                        testFilePath: input.testFilePath,
                        rawOutput: input.rawOutput,
                        sourceCode: input.sourceCode,
                        interpretation: input.interpretation,
                        domContext: input.domContext,
                        pageSummaries: input.pageSummaries,
                        provenSelectors: input.provenSelectors,
                        sourceSelectors: input.sourceSelectors,
                        scenario: input.scenario,
                        allowWeaken: input.allowWeaken,
                        signal: input.signal,
                        images: images.length > 0 ? images : undefined,
                        projectPath: this.projectPath,
                    },
                    {
                        apiKey: resolved.apiKey ?? "",
                        model: resolved.model,
                        provider: resolved.provider,
                        baseURL: resolved.baseURL,
                    },
                );
            return {
                fixedCode,
                originalCode: originalCode ?? testCode,
                mode: mode ?? null,
                editCount: editCount ?? null,
                matchFailed: matchFailed ?? false,
                filePath: input.testFilePath ?? null,
                error,
            };
        } catch (error) {
            const raw = error instanceof Error ? error.message : String(error);
            let msg = `Error repairing test: ${raw}`;
            if (raw.includes("402") || raw.includes("credits")) {
                msg = `Insufficient credits/quota for AI repair with ${provider.label}. Check your account balance or switch providers in Settings, then try again.`;
            }
            return {
                fixedCode: null as string | null,
                originalCode: input.testCode,
                mode: null as "edits" | "full" | null,
                editCount: null as number | null,
                matchFailed: false,
                filePath: input.testFilePath ?? null,
                error: msg,
            };
        }
    }

    async saveGeneratedTest(input: {
        fileName: string;
        content: string;
        testDir?: string;
        sourceFiles?: string[];
        avoidOverwrite?: boolean;
    }) {
        const { testDir: customTestDir, sourceFiles } = input;
        let autonomy: ReturnType<typeof loadAutonomySettings> | undefined;
        try {
            autonomy = loadAutonomySettings(this.projectPath);
        } catch {
            autonomy = undefined;
        }

        const result = await saveTestArtifact({
            projectPath: this.projectPath,
            fileName: input.fileName,
            testDir: customTestDir,
            rawContent: input.content,
            avoidOverwrite: input.avoidOverwrite,
            sourceFiles,
            learn: autonomy ? { autoLearn: autonomy.autoLearn } : undefined,
        });

        if (!result.success || !result.filePath || !result.absolutePath || !result.content) {
            throw internalError(result.message, { cause: result });
        }

        return {
            success: true as const,
            filePath: result.filePath,
            absolutePath: result.absolutePath,
            content: result.content,
        };
    }

    /**
     * Persist an explicit editor buffer exactly as authored.
     *
     * This intentionally does not clean, dedupe, or learn from the content:
     * generated/HITL artifacts use `saveGeneratedTest` and its canonical
     * `saveTestArtifact` pipeline, while this path preserves user edits.
     */
    async saveFileContent(input: { filePath: string; content: string }) {
        const resolved = assertUnderProjectRoot(
            path.isAbsolute(input.filePath)
                ? input.filePath
                : path.join(this.projectPath, input.filePath),
            this.projectPath,
        );
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await writeFileAtomic(resolved, input.content);
        return {
            success: true,
            filePath: path.relative(this.projectPath, resolved),
        };
    }

    async deleteTestFile(input: { filePath: string }) {
        const resolved = assertUnderProjectRoot(
            path.isAbsolute(input.filePath)
                ? input.filePath
                : path.join(this.projectPath, input.filePath),
            this.projectPath,
        );
        try {
            await fs.access(resolved);
        } catch {
            throw notFoundError(`File not found: ${input.filePath}`, {
                code: "FILE_NOT_FOUND",
                details: { filePath: input.filePath },
            });
        }
        await fs.unlink(resolved);
        const relPath = path.relative(this.projectPath, resolved);
        try {
            const db = new CodeGraphDB(this.projectPath);
            db.deleteTestRecords(relPath);
            db.close();
        } catch (err) {
            console.warn("Failed to clean test records for deleted file:", err);
        }
        return { success: true, filePath: relPath };
    }

    async renameTestFile(input: { filePath: string; newFileName: string }) {
        const newName = input.newFileName.trim();
        if (!newName.match(/^[a-zA-Z0-9_-]+\.(spec|test)\.(ts|tsx|js|jsx)$/)) {
            throw validationError(
                "Invalid filename. Must be a test file (*.spec.ts, *.test.tsx, etc.) with no path separators.",
            );
        }
        const source = assertUnderProjectRoot(
            path.isAbsolute(input.filePath)
                ? input.filePath
                : path.join(this.projectPath, input.filePath),
            this.projectPath,
        );
        try {
            await fs.access(source);
        } catch {
            throw notFoundError(`File not found: ${input.filePath}`, {
                code: "FILE_NOT_FOUND",
                details: { filePath: input.filePath },
            });
        }
        const target = assertUnderProjectRoot(
            path.join(path.dirname(source), newName),
            this.projectPath,
        );
        if (target === source) {
            return { success: true, filePath: path.relative(this.projectPath, source) };
        }
        try {
            await fs.access(target);
            throw conflictError(`A file named ${newName} already exists in that folder.`, {
                code: "RESOURCE_CONFLICT",
                details: { fileName: newName },
            });
        } catch (err) {
            if (err instanceof Error && err.message.includes("already exists")) throw err;
        }
        await fs.rename(source, target);
        const oldRel = path.relative(this.projectPath, source);
        const newRel = path.relative(this.projectPath, target);
        try {
            const db = new CodeGraphDB(this.projectPath);
            try {
                db.renameTestRecords(oldRel, newRel);
            } finally {
                db.close();
            }
        } catch (err) {
            console.warn("Failed to update test records after rename:", err);
        }
        return { success: true, filePath: newRel };
    }

    async listTestFiles(input: { testDir?: string } = {}) {
        const testDirectory = input.testDir || loadTestDirectory(this.projectPath);

        const testDirPath = assertUnderProjectRoot(
            path.join(this.projectPath, testDirectory),
            this.projectPath,
        );
        const testFiles: Array<{
            name: string;
            path: string;
            directory: string;
            status?: "fresh" | "stale" | "broken";
        }> = [];

        try {
            await fs.access(testDirPath);
        } catch {
            return { files: testFiles, testDirectory };
        }

        let outcomesByFile: Map<
            string,
            { status: string; lastRun: number | null; createdAt: number }
        > = new Map();
        let statusDb: CodeGraphDB | null = null;
        try {
            statusDb = new CodeGraphDB(this.projectPath);
            outcomesByFile = statusDb.getLatestOutcomesPerFile();
        } catch (err) {
            console.warn("Failed to load test outcome history for status badges:", err);
        }

        const deriveStatus = async (
            relPath: string,
            absPath: string,
        ): Promise<"fresh" | "stale" | "broken" | undefined> => {
            const outcome = outcomesByFile.get(relPath);
            if (!outcome) return undefined;
            if (
                outcome.status === "failed" ||
                outcome.status === "error" ||
                outcome.status === "timeout"
            ) {
                return "broken";
            }
            if (outcome.status !== "passed") return undefined;
            const referenceTime = outcome.lastRun ?? outcome.createdAt;
            try {
                const stat = await fs.stat(absPath);
                if (stat.mtimeMs > referenceTime) return "stale";
            } catch {
                return "stale";
            }
            const sourceFiles = statusDb?.getSourceFilesForTest(relPath) ?? [];
            for (const src of sourceFiles) {
                try {
                    const srcStat = await fs.stat(path.join(this.projectPath, src));
                    if (srcStat.mtimeMs > referenceTime) return "stale";
                } catch {
                    // ignore
                }
            }
            return "fresh";
        };

        const scanDir = async (dirPath: string, relativePath = "") => {
            try {
                const entries = await fs.readdir(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    const entryPath = path.join(dirPath, entry.name);
                    const entryRelPath = relativePath
                        ? `${relativePath}/${entry.name}`
                        : entry.name;
                    if (entry.isDirectory()) {
                        await scanDir(entryPath, entryRelPath);
                    } else if (
                        entry.isFile() &&
                        /\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/.test(entry.name) &&
                        !/\.raiken-run-\d+\.spec\.(ts|tsx|js|jsx)$/.test(entry.name)
                    ) {
                        const relPath = path.posix
                            .normalize(`${testDirectory}/${entryRelPath}`)
                            .replace(/^\.\//, "");
                        testFiles.push({
                            name: entry.name,
                            path: relPath,
                            directory: testDirectory + (relativePath ? `/${relativePath}` : ""),
                            status: await deriveStatus(relPath, entryPath),
                        });
                    }
                }
            } catch (error) {
                console.error(`Error scanning directory ${dirPath}:`, error);
            }
        };

        await scanDir(testDirPath);
        statusDb?.close();
        return { files: testFiles, testDirectory };
    }
}
