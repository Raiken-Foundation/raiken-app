import * as path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { acquireProjectOperation } from "../../operations";
import { isTestRunSuccessful, summarizeTestRunResults } from "../../testing/run-outcome";
import { TestRunner, type TestRunResult } from "../../testing/runner";
import { createRunAction, shouldSkipHITL } from "../hitl-types";
import { AgentMemory } from "../memory";
import { safePath } from "./shared/project-path";
import type { AgentToolGroupDeps, AutonomySettings, ToolResult } from "./types";

/** Tool names owned by the test execution / repair group. */
export const TEST_EXECUTION_REPAIR_TOOL_NAMES = ["runTest"] as const;

export type TestExecutionRepairToolName = (typeof TEST_EXECUTION_REPAIR_TOOL_NAMES)[number];

/**
 * How many times a repair verification runs the spec. Two is the cheapest
 * number that can distinguish "fixed" from "passed once": the welcome-modal
 * regression passed a verification run and failed the very next one.
 */
export const VERIFICATION_REPEAT_EACH = 2;

/** Result of {@link executeTestRun}. */
export interface ExecuteTestRunResult {
    success: boolean;
    results?: TestRunResult[];
    message: string;
}

/**
 * Run a Playwright test file and (best-effort) record the outcome. Shared by
 * the `runTest` tool's auto-run branch and the repair node's own
 * verification runs — see {@link writeTestFile} for why the repair node
 * bypasses the tool wrapper's HITL gate but not its behavior.
 */
export async function executeTestRun(
    projectPath: string,
    testFile: string,
    headed: boolean,
    autonomy: Pick<AutonomySettings, "autoLearn">,
    signal?: AbortSignal,
    operationHeld = false,
    verifying = false,
): Promise<ExecuteTestRunResult> {
    if (signal?.aborted) {
        return {
            success: false,
            message: "Operation cancelled",
        };
    }

    const lease = operationHeld ? null : await acquireProjectOperation(projectPath, "test", signal);
    try {
        const runner = new TestRunner(projectPath);
        const results = await runner.runTest(testFile, {
            headed,
            signal,
            ...(verifying ? { retries: 0, repeatEach: VERIFICATION_REPEAT_EACH } : {}),
        });
        // Shared verdict: a deliberately skipped test is not a failure, and an
        // empty result set is not a pass.
        const passed = isTestRunSuccessful(results);

        const executedAny = results.some((r) => r.status !== "skipped");
        if (autonomy.autoLearn !== "off" && executedAny) {
            try {
                AgentMemory.getInstance(projectPath).recordRunOutcome(
                    testFile,
                    summarizeTestRunResults(results),
                );
            } catch {
                /* non-critical */
            }
        }

        return {
            success: passed,
            results,
            message: passed
                ? `All tests passed (${results.length} test(s))`
                : `${results.filter((r) => r.status !== "passed").length} test(s) failed`,
        };
    } catch (error) {
        return {
            success: false,
            message: `Test execution failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        };
    } finally {
        await lease?.release();
    }
}

export function createTestExecutionRepairTools(deps: AgentToolGroupDeps) {
    const { projectPath, autonomy, signal, operationHeld } = deps;

    return {
        runTest: tool({
            description:
                "Execute a Playwright test file and return results. Depending on autonomy settings, this may run immediately or ask for confirmation.",
            inputSchema: z.object({
                testFile: z.string().describe("Test file path relative to project root"),
                headed: z.boolean().optional().default(false).describe("Run with visible browser"),
            }),
            execute: async (params): Promise<ToolResult<TestRunResult[] | { status: string }>> => {
                const {
                    testFile,
                    headed = false,
                    _repairVerification,
                } = params as {
                    testFile: string;
                    headed?: boolean;
                    _repairVerification?: boolean;
                };
                let validatedTestFile: string;
                try {
                    validatedTestFile = path.relative(projectPath, safePath(projectPath, testFile));
                } catch (error) {
                    return {
                        success: false,
                        message: error instanceof Error ? error.message : "Invalid test file path",
                    };
                }

                const autoApproved =
                    shouldSkipHITL("run", autonomy) ||
                    (_repairVerification === true && autonomy.autoCorrect !== "off");
                if (autoApproved) {
                    const result = await executeTestRun(
                        projectPath,
                        validatedTestFile,
                        headed,
                        autonomy,
                        signal,
                        operationHeld,
                        _repairVerification === true,
                    );
                    return {
                        success: result.success,
                        data: result.results,
                        message: result.message,
                    };
                }

                const hitlAction = createRunAction(
                    validatedTestFile,
                    path.basename(validatedTestFile),
                );
                return {
                    success: true,
                    data: { status: "pending" },
                    message: `Ready to run ${validatedTestFile}. Waiting for confirmation.`,
                    hitlRequired: true,
                    hitlAction,
                };
            },
        }),
    };
}

export type TestExecutionRepairTools = ReturnType<typeof createTestExecutionRepairTools>;
