import type { TestRunResult } from "../../../testing/runner";
import type { GraphStateType } from "../state";
import type { AgentNodeDeps } from "./types";

const MAX_BASENAME_LENGTH = 40;

function sanitizeBaseName(input: string): string {
    const slug = input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
    if (slug.length <= MAX_BASENAME_LENGTH) return slug;
    const sliced = slug.slice(0, MAX_BASENAME_LENGTH);
    const lastBoundary = sliced.lastIndexOf("-");
    const trimmed = lastBoundary > 0 ? sliced.slice(0, lastBoundary) : sliced;
    return trimmed.replace(/-+$/, "");
}

function deriveFileNameFromTestCode(code: string): string | null {
    const describeMatch = code.match(/test\.describe\(\s*['"`](.+?)['"`]/);
    const titleMatch = describeMatch ?? code.match(/test\(\s*['"`](.+?)['"`]/);
    if (!titleMatch) return null;
    const base = sanitizeBaseName(titleMatch[1]);
    return base ? `${base}.spec.ts` : null;
}

export const createHitlSaveNode =
    ({ callTool }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        if (!state.testDraft) return {};
        const testDirectory = state.testDirectory || "e2e";
        // If the user had a test file highlighted/open, overwrite it instead of
        // deriving a brand-new file name. The save-approval card still shows
        // this path (editable) so the user confirms before it is written.
        let filePath: string;
        let fileName: string;
        if (state.targetTestFile) {
            filePath = state.targetTestFile;
            fileName = filePath.split("/").pop() || filePath;
        } else {
            const llmDerivedName = deriveFileNameFromTestCode(state.testDraft);
            const baseName = sanitizeBaseName(state.userPrompt);
            fileName = llmDerivedName ?? `${baseName || "raiken-test"}.spec.ts`;
            filePath = `${testDirectory}/${fileName}`;
        }
        const saveResult = await callTool("saveFile", {
            filePath,
            content: state.testDraft,
            testName: fileName,
        });

        if (!saveResult.success) {
            return {
                summary: `Failed to save test file: ${saveResult.message || "unknown error"}`,
            };
        }

        const savedPath = (saveResult.data as { path?: string } | undefined)?.path || null;
        if (saveResult.hitlRequired) {
            return {
                shouldPause: true,
                savedTestPath: savedPath,
                awaitUserMessage: `Waiting for approval to save ${filePath}.`,
            };
        }
        return {
            savedTestPath: savedPath,
        };
    };

export const createHitlRunNode =
    ({ callTool }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        if (!state.savedTestPath || !state.shouldRunTests) return {};
        const runResult = await callTool("runTest", {
            testFile: state.savedTestPath,
            headed: true,
        });
        if (runResult.hitlRequired) {
            return {
                shouldPause: true,
                awaitUserMessage: `Waiting for approval to run ${state.savedTestPath}.`,
            };
        }

        if (!runResult.success) {
            return {
                testRunResult: [
                    {
                        testFile: state.savedTestPath,
                        testName: "unknown",
                        status: "error" as const,
                        duration: 0,
                        error: { message: runResult.message || "Test run failed" },
                    },
                ] satisfies TestRunResult[],
            };
        }

        const results = Array.isArray(runResult.data) ? (runResult.data as TestRunResult[]) : null;
        if (results) {
            return { testRunResult: results };
        }
        return {};
    };
