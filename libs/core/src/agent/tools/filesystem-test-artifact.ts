import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { ProjectContext } from "../../analysis/project-context";
import type { AutonomyConfig } from "../../config";
import { prepareTestArtifactContent, saveTestArtifact } from "../../testing/save-test-artifact";
import { createSaveAction, shouldSkipHITL } from "../hitl-types";
import { safePath } from "./shared/project-path";
import type { AgentToolGroupDeps, AutonomySettings, ToolResult } from "./types";

/** Tool names owned by the filesystem / test-artifact group. */
export const FILESYSTEM_TEST_ARTIFACT_TOOL_NAMES = [
    "searchCodebase",
    "readFile",
    "listDirectory",
    "getProjectOverview",
    "saveFile",
] as const;

export type FilesystemTestArtifactToolName = (typeof FILESYSTEM_TEST_ARTIFACT_TOOL_NAMES)[number];

/** Result of {@link writeTestFile}. */
export interface WriteTestFileResult {
    success: boolean;
    path?: string;
    message: string;
}

/**
 * Clean, atomically write, and (best-effort) record a generated/repaired
 * test file. Shared by the `saveFile` tool's auto-save branch and the repair
 * node's own writes — the repair node bypasses the tool's HITL gate (its
 * `autoCorrect` setting, not `autoSaveTests`, is the authorizing signal for a
 * repair's writes) but must still go through the exact same clean +
 * atomic-write + learn pipeline so on-disk output never differs by caller.
 */
export async function writeTestFile(
    projectPath: string,
    filePath: string,
    rawContent: string,
    testName: string | undefined,
    autonomy: Pick<AutonomySettings, "autoLearn">,
    options: { avoidOverwrite?: boolean } = {},
): Promise<WriteTestFileResult> {
    const result = await saveTestArtifact({
        projectPath,
        relativePath: filePath,
        rawContent,
        testName,
        stripEditMarkersFromRaw: true,
        avoidOverwrite: options.avoidOverwrite,
        learn: { autoLearn: autonomy.autoLearn },
    });
    return {
        success: result.success,
        path: result.filePath,
        message: result.message,
    };
}

export function createFilesystemTestArtifactTools(deps: AgentToolGroupDeps) {
    const { projectPath, autonomy } = deps;

    return {
        searchCodebase: tool({
            description:
                "Search the codebase for files related to a query. Use this to find relevant source files before reading them.",
            inputSchema: z.object({
                query: z
                    .string()
                    .describe(
                        'Search query (e.g., "login form", "auth service", "user validation")',
                    ),
                limit: z
                    .number()
                    .optional()
                    .default(10)
                    .describe("Maximum number of files to return"),
            }),
            execute: async (params): Promise<ToolResult<string[]>> => {
                const { query, limit = 10 } = params as { query: string; limit?: number };
                try {
                    const projectContext = ProjectContext.getInstance(projectPath);
                    if (!projectContext.isInitialized()) {
                        await projectContext.initialize();
                    }
                    const files = projectContext.findRelevantFiles(query, limit);
                    return {
                        success: true,
                        data: files,
                        message:
                            files.length > 0
                                ? `Found ${files.length} relevant files`
                                : "No matching files found",
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        readFile: tool({
            description:
                "Read the contents of a source file. Use this to understand code before generating tests.",
            inputSchema: z.object({
                filePath: z
                    .string()
                    .describe(
                        "File path relative to project root (e.g., src/components/LoginForm.tsx)",
                    ),
            }),
            execute: async (params): Promise<ToolResult<{ content: string; lines: number }>> => {
                const { filePath } = params as { filePath: string };
                try {
                    const fullPath = safePath(projectPath, filePath);
                    const content = await fs.readFile(fullPath, "utf-8");
                    const lines = content.split("\n").length;
                    return {
                        success: true,
                        data: { content, lines },
                        message: `Read ${filePath} (${lines} lines)`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to read file: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        listDirectory: tool({
            description: "List files in a directory. Use this to explore the project structure.",
            inputSchema: z.object({
                dirPath: z
                    .string()
                    .describe("Directory path relative to project root (e.g., src/components)"),
            }),
            execute: async (params): Promise<ToolResult<string[]>> => {
                const { dirPath } = params as { dirPath: string };
                try {
                    const fullPath = safePath(projectPath, dirPath);
                    const entries = await fs.readdir(fullPath, { withFileTypes: true });
                    const files = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
                    return {
                        success: true,
                        data: files,
                        message: `Found ${files.length} items in ${dirPath}`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to list directory: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        getProjectOverview: tool({
            description:
                "Get an overview of the project structure including modules and file counts.",
            inputSchema: z.object({}),
            execute: async (): Promise<
                ToolResult<{
                    fileCount: number;
                    modules: Array<{ name: string; fileCount: number }>;
                }>
            > => {
                try {
                    const projectContext = ProjectContext.getInstance(projectPath);
                    if (!projectContext.isInitialized()) {
                        await projectContext.initialize();
                    }

                    const modules = projectContext.getModules();
                    const fileCount = projectContext.getFileCount();

                    return {
                        success: true,
                        data: {
                            fileCount,
                            modules: modules.slice(0, 10).map((m) => ({
                                name: m.name,
                                fileCount: m.files.length,
                            })),
                        },
                        message: `Project has ${fileCount} files across ${modules.length} modules`,
                    };
                } catch (error) {
                    return {
                        success: false,
                        message: `Failed to get project overview: ${error instanceof Error ? error.message : "Unknown error"}`,
                    };
                }
            },
        }),

        saveFile: tool({
            description:
                "Save content to a file. Depending on autonomy settings, this may save immediately or ask for confirmation.",
            inputSchema: z.object({
                filePath: z
                    .string()
                    .describe("File path relative to project root (e.g., tests/login.spec.ts)"),
                content: z.string().describe("File content to save"),
                testName: z.string().optional().describe("Name of the test (for display)"),
            }),
            execute: async (params): Promise<ToolResult<{ path: string; saved: boolean }>> => {
                const {
                    filePath,
                    content: rawContent,
                    testName,
                    _repairVerification,
                    _overwriteTarget,
                } = params as {
                    filePath: string;
                    content: string;
                    testName?: string;
                    _repairVerification?: boolean;
                    _overwriteTarget?: boolean;
                };
                const name = testName || path.basename(filePath, path.extname(filePath));

                const autoApproved =
                    shouldSkipHITL("save", autonomy) ||
                    (_repairVerification === true && autonomy.autoCorrect !== "off");
                if (autoApproved) {
                    const result = await writeTestFile(
                        projectPath,
                        filePath,
                        rawContent,
                        name,
                        autonomy,
                    );
                    if (!result.success) return { success: false, message: result.message };
                    return {
                        success: true,
                        data: { path: result.path ?? filePath, saved: true },
                        message: result.message,
                    };
                }

                const content = prepareTestArtifactContent(rawContent, {
                    stripEditMarkersFromRaw: true,
                });
                const hitlAction = createSaveAction(
                    content,
                    filePath,
                    name,
                    _overwriteTarget === true,
                );
                return {
                    success: true,
                    data: { path: filePath, saved: false },
                    message: `Ready to save ${filePath}. Waiting for confirmation.`,
                    hitlRequired: true,
                    hitlAction,
                };
            },
        }),
    };
}

export type FilesystemTestArtifactTools = ReturnType<typeof createFilesystemTestArtifactTools>;

/** @internal Re-export for type parity with config schema consumers. */
export type { AutonomyConfig };
