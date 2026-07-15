import type { TestRunResult } from "../../../testing/runner";
import type { GraphStateType } from "../state";
import { resolveAutonomy } from "./repair";
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

export const createHitlRunNode = (deps: AgentNodeDeps) => async (state: GraphStateType) => {
    const { callTool } = deps;
    if (!state.savedTestPath || !state.shouldRunTests) return {};

    // A run triggered after a repair attempt is verifying that specific
    // fix, not asking "should this test run at all" from scratch — the
    // user already authorized the loop via `autoCorrect` when it wasn't
    // "off". Without this, a repair loop with `autoCorrect: "apply"`/
    // `"suggest"` but `autoRunTests: false` would pause here on every
    // single verification run, defeating automatic repair entirely.
    const isRepairVerification = state.repairAttempts > 0;
    const runResult = await callTool("runTest", {
        testFile: state.savedTestPath,
        headed: true,
        ...(isRepairVerification ? { _repairVerification: true } : {}),
    });
    if (runResult.hitlRequired) {
        return {
            shouldPause: true,
            awaitUserMessage: `Waiting for approval to run ${state.savedTestPath}.`,
        };
    }

    // The `runTest` tool sets `success: false` for BOTH "Playwright ran
    // and some tests failed" and "the tool itself never got Playwright
    // to run" (bad path, spawn error). Only the second case has no
    // per-test data — checking for real results first (regardless of
    // `success`) means a real assertion/selector failure reaches the
    // repair node with its actual error message instead of being
    // replaced by a generic "Test run failed", which left auto-repair
    // working blind.
    const results = Array.isArray(runResult.data) ? (runResult.data as TestRunResult[]) : null;
    if (results) {
        const stillFailing = results.some((r) => r.status !== "passed");
        if (stillFailing && isRepairVerification) {
            const autonomy = resolveAutonomy(deps);
            const exhausted = state.repairAttempts >= autonomy.maxRetries;
            // "apply" fully trusts the loop even when it gives up — it
            // just reports the outcome via the normal end-of-turn
            // summary, same as before. "suggest" gets exactly one pause,
            // and only now: automatic repair tried its best and is
            // still failing, so this is the one moment worth
            // interrupting the user for instead of silently leaving the
            // last (still-broken) attempt on disk unannounced.
            if (exhausted && autonomy.autoCorrect === "suggest") {
                return {
                    testRunResult: results,
                    shouldPause: true,
                    awaitUserMessage: `Automatic repair tried ${state.repairAttempts} time(s) but ${state.savedTestPath} still fails. The last attempt is saved — review it, edit manually, or ask me to try again.`,
                };
            }
        }
        return { testRunResult: results };
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
    return {};
};
