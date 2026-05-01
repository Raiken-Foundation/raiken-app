import type { GraphStateType } from "../state";
import type { AgentNodeDeps } from "./types";
import type { TestRunResult } from "../../../testing/runner";

export const createHitlSaveNode =
    ({ callTool }: AgentNodeDeps) =>
    async (state: GraphStateType) => {
        if (!state.testDraft) return {};
        const testDirectory = state.testDirectory || "e2e";
        const baseName = state.userPrompt
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "")
            .slice(0, 40);
        const fileName = `${baseName || "raiken-test"}.spec.ts`;
        const filePath = `${testDirectory}/${fileName}`;
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
                testRunResult: [{
                    testFile: state.savedTestPath,
                    testName: "unknown",
                    status: "error" as const,
                    duration: 0,
                    error: { message: runResult.message || "Test run failed" },
                }] satisfies TestRunResult[],
            };
        }

        const results = Array.isArray(runResult.data)
            ? (runResult.data as TestRunResult[])
            : null;
        if (results) {
            return { testRunResult: results };
        }
        return {};
    };
