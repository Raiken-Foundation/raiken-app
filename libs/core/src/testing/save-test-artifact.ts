import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { AgentMemory } from "../agent/memory";
import { loadTestDirectory, resolvePathWithinProject } from "../config";
import { CodeGraphDB } from "../database/db";
import { validationError } from "../errors";
import { writeFileAtomic } from "../io/atomic-write";
import { cleanGeneratedTestCode } from "../utils";
import { stripEditMarkers } from "./edit-blocks";
import { validateTestCode } from "./test-code-validation";

const TEST_FILE_NAME = /^[a-zA-Z0-9_-]+\.(spec|test)\.(ts|tsx|js|jsx)$/;

export interface SaveTestArtifactLearnOptions {
    autoLearn: "confirm" | "auto" | "off";
}

export interface SaveTestArtifactInput {
    projectPath: string;
    /** Relative path from project root (agent/HITL/repair writes). */
    relativePath?: string;
    /** Basename only (dashboard/tRPC saves). Requires `testDir` or default test directory. */
    fileName?: string;
    testDir?: string;
    rawContent: string;
    testName?: string;
    stripEditMarkersFromRaw?: boolean;
    avoidOverwrite?: boolean;
    sourceFiles?: string[];
    learn?: SaveTestArtifactLearnOptions;
    /**
     * Skip {@link validateTestCode}. Intended ONLY for explicit user-authored
     * buffers saved verbatim; every generated/repaired/client-supplied spec
     * must clear the gate. Validation is on by default (review finding: the
     * gate previously lived at call sites only, so any new caller bypassed it).
     */
    skipValidation?: boolean;
}

export interface SaveTestArtifactResult {
    success: boolean;
    filePath?: string;
    absolutePath?: string;
    content?: string;
    message: string;
}

function assertRelativePath(filePath: string): void {
    if (filePath.includes("..") || path.isAbsolute(filePath)) {
        throw validationError("Path must be relative to the project root", {
            code: "PATH_OUTSIDE_PROJECT",
        });
    }
}

function validateTestFileName(fileName: string): void {
    if (!TEST_FILE_NAME.test(fileName)) {
        throw validationError(
            "Invalid filename. Must be a test file (*.spec.ts, *.test.tsx, etc.)",
        );
    }
    if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
        throw validationError(
            "Filename must not contain path separators or parent directory references",
            { code: "PATH_OUTSIDE_PROJECT" },
        );
    }
}

export function prepareTestArtifactContent(
    rawContent: string,
    options: { stripEditMarkersFromRaw?: boolean } = {},
): string {
    const stripped = options.stripEditMarkersFromRaw ? stripEditMarkers(rawContent) : rawContent;
    return cleanGeneratedTestCode(stripped);
}

async function resolveDedupedFileName(
    directory: string,
    fileName: string,
    content: string,
): Promise<string> {
    const match = fileName.match(/^(.*)\.(spec|test)\.(ts|tsx|js|jsx)$/);
    if (!match) return fileName;

    const [, stem, kind, ext] = match;
    let candidate = fileName;
    let n = 1;
    while (true) {
        const absolute = path.join(directory, candidate);
        let existing: string | null = null;
        try {
            existing = await fsPromises.readFile(absolute, "utf-8");
        } catch {
            existing = null;
        }
        if (existing === null || existing === content) {
            return candidate;
        }
        n += 1;
        candidate = `${stem}-${n}.${kind}.${ext}`;
    }
}

async function recordTestSourceFiles(
    projectPath: string,
    relativeFilePath: string,
    sourceFiles: string[],
): Promise<void> {
    try {
        const db = new CodeGraphDB(projectPath);
        db.recordTestSourceFiles(relativeFilePath, sourceFiles);
        db.close();
    } catch (err) {
        console.warn("Failed to record test source mapping:", err);
    }
}

async function recordTestGenerated(
    projectPath: string,
    relativeFilePath: string,
    displayName: string,
    content: string,
    learn: SaveTestArtifactLearnOptions | undefined,
): Promise<void> {
    if (!learn || learn.autoLearn === "off") return;
    try {
        AgentMemory.getInstance(projectPath).recordTestGenerated(
            relativeFilePath,
            displayName,
            "",
            content,
        );
    } catch {
        /* non-critical */
    }
}

/**
 * Single save pipeline for generated/repaired tests: clean content, resolve a
 * contained path, apply overwrite/dedupe policy, atomic write, and learning hooks.
 */
export async function saveTestArtifact(
    input: SaveTestArtifactInput,
): Promise<SaveTestArtifactResult> {
    const content = prepareTestArtifactContent(input.rawContent, {
        stripEditMarkersFromRaw: input.stripEditMarkersFromRaw,
    });

    if (!input.skipValidation) {
        const validation = validateTestCode(content);
        if (!validation.ok) {
            return {
                success: false,
                message: `Refusing to save: the test code ${validation.reason}.`,
            };
        }
    }

    try {
        let relativePath = input.relativePath;
        let fileName = input.fileName;

        if (relativePath) {
            assertRelativePath(relativePath);
            // The agent's saveFile auto-approves under autoSaveTests and must
            // never be able to overwrite arbitrary project files (package.json,
            // .env.local, workflows) with model content (review finding).
            // Every legitimate relativePath caller writes a spec; explicit
            // user-authored buffers bypass this pipeline entirely.
            const basename = path.basename(relativePath.replace(/\\/g, "/"));
            if (!TEST_FILE_NAME.test(basename)) {
                return {
                    success: false,
                    message:
                        "Refusing to save: only test files (*.spec.ts, *.test.tsx, …) can be written through this pipeline.",
                };
            }
        } else if (fileName) {
            validateTestFileName(fileName);
            const testDirectory = input.testDir || loadTestDirectory(input.projectPath);
            const testDirPath = resolvePathWithinProject(
                input.projectPath,
                path.join(testDirectory),
            );
            await fsPromises.mkdir(testDirPath, { recursive: true });

            if (input.avoidOverwrite) {
                fileName = await resolveDedupedFileName(testDirPath, fileName, content);
            }

            relativePath = path.join(testDirectory, fileName);
        } else {
            return {
                success: false,
                message: "Either relativePath or fileName is required",
            };
        }

        const absolutePath = resolvePathWithinProject(input.projectPath, relativePath);
        await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFileAtomic(absolutePath, content);

        const projectRoot = fs.realpathSync(path.resolve(input.projectPath));
        const relativeFilePath = path.relative(projectRoot, absolutePath);
        const displayName =
            input.testName || path.basename(relativeFilePath, path.extname(relativeFilePath));

        if (input.sourceFiles && input.sourceFiles.length > 0) {
            await recordTestSourceFiles(input.projectPath, relativeFilePath, input.sourceFiles);
        }
        await recordTestGenerated(
            input.projectPath,
            relativeFilePath,
            displayName,
            content,
            input.learn,
        );

        return {
            success: true,
            filePath: relativeFilePath,
            absolutePath,
            content,
            message: `Saved ${relativeFilePath}`,
        };
    } catch (error) {
        return {
            success: false,
            message: `Failed to save file: ${error instanceof Error ? error.message : "Unknown error"}`,
        };
    }
}
