import {
    createLangChainModel,
    type ResolvedAIConfig,
    resolveAIConfig,
} from "../agent/ai-providers";
import type { HITLAction, HITLRunAction, HITLSaveAction } from "../agent/hitl-types";
import {
    type AutonomySettings,
    type ExecuteTestRunResult,
    executeTestRun,
    writeTestFile,
} from "../agent/tools";
import { loadAutonomyConfig } from "../config";
import { mergeCorrelationContext, runDetachedOperation } from "../observability";
import { acquireProjectOperation } from "../operations";
import { executeRepairAttempt } from "../testing/repair-attempt";
import { repairLoopService } from "../testing/repair-loop-service";
import { parsedRunToTestRunResults } from "../testing/run-outcome";
import { testExecutionService } from "../testing/test-execution-service";
import { type HitlWorkflowRecord, WorkflowStore } from "./workflow-store";

export type ContinueHitlWorkflowInput =
    | {
          projectPath: string;
          workflowId: string;
          action: "save";
          decision: "approve" | "reject";
          filePath?: string;
          avoidOverwrite?: boolean;
      }
    | {
          projectPath: string;
          workflowId: string;
          action: "run";
          decision: "approve" | "reject";
      };

export interface ContinueHitlWorkflowResult {
    workflow: HitlWorkflowRecord;
    savedPath?: string;
    run?: ExecuteTestRunResult;
}

export interface HitlWorkflowDependencies {
    model?: ReturnType<typeof createLangChainModel>;
    repairAttempt?: typeof executeRepairAttempt;
    writeTest?: typeof writeTestFile;
    executeRun?: typeof executeTestRun;
}

async function executeApprovedUserRun(
    projectPath: string,
    testFile: string,
): Promise<ExecuteTestRunResult> {
    const result = await testExecutionService.run(
        projectPath,
        { testFile },
        { operationHeld: true },
    );
    return {
        success: result.success,
        results: result.parsedRun
            ? parsedRunToTestRunResults(result.parsedRun, testFile)
            : undefined,
        message: result.success
            ? "Test passed"
            : result.cancelled
              ? "Test run cancelled"
              : result.stderr || "Test failed",
    };
}

export async function persistHitlPauseWorkflow(input: {
    projectPath: string;
    hitlActions: HITLAction[];
    origin: HitlWorkflowRecord["origin"];
    repairAttempts: number;
    shouldRunTests: boolean;
    autonomy?: AutonomySettings;
}): Promise<HitlWorkflowRecord | null> {
    const action = input.hitlActions.at(-1);
    if (action?.type !== "save" && action?.type !== "run") return null;

    const save = action as HITLSaveAction;
    const run = action as HITLRunAction;
    return new WorkflowStore(input.projectPath).create({
        kind: "test_generate_repair",
        status: action.type === "save" ? "await_save_approval" : "await_run_approval",
        origin: input.origin,
        savedTestPath: action.type === "save" ? save.suggestedPath : run.testFile,
        testDraft: action.type === "save" ? save.testCode : undefined,
        testName: action.type === "save" ? save.testName : run.testName,
        shouldRunTests: input.shouldRunTests,
        repairAttempts: input.repairAttempts,
        autonomy: input.autonomy
            ? {
                  autoCorrect: input.autonomy.autoCorrect,
                  maxRetries: input.autonomy.maxRetries,
                  autoLearn: input.autonomy.autoLearn,
              }
            : undefined,
        pendingAction: action.type,
    });
}

function resolveWorkflowAutonomy(
    projectPath: string,
    workflow: HitlWorkflowRecord,
): Required<ReturnType<typeof loadAutonomyConfig>> {
    return loadAutonomyConfig(projectPath, workflow.autonomy);
}

async function driveRepairLoop(
    store: WorkflowStore,
    workflow: HitlWorkflowRecord,
    projectPath: string,
    resolvedAI?: ResolvedAIConfig,
    dependencies: HitlWorkflowDependencies = {},
): Promise<HitlWorkflowRecord> {
    if (!workflow.savedTestPath || !workflow.lastRunResults) {
        return (
            (await store.update(workflow.id, {
                status: "await_repair_review",
                statusMessage:
                    "Repair could not resume because its test path or failure data is missing.",
            })) ?? workflow
        );
    }
    const savedTestPath = workflow.savedTestPath;
    const autonomy = resolveWorkflowAutonomy(projectPath, workflow);
    let model = dependencies.model;
    try {
        model ??= createLangChainModel(resolvedAI ?? resolveAIConfig(projectPath));
    } catch (error) {
        return (
            (await store.update(workflow.id, {
                status: "await_repair_review",
                statusMessage:
                    error instanceof Error
                        ? `Automatic repair could not start: ${error.message}`
                        : "Automatic repair could not start.",
            })) ?? workflow
        );
    }
    let current = workflow;
    while (
        repairLoopService.shouldContinueRepair(
            {
                testRunResult: current.lastRunResults,
                repairAttempts: current.repairAttempts,
            },
            autonomy,
        )
    ) {
        const attempt = await (dependencies.repairAttempt ?? executeRepairAttempt)(
            { model },
            {
                projectPath,
                savedTestPath,
                testDraft: current.testDraft,
                testRunResult: current.lastRunResults ?? [],
                repairAttempts: current.repairAttempts,
                lastRepairedCode: current.lastRepairedCode,
            },
        );
        if (!attempt.fixedCode || attempt.noProgress) {
            return (
                (await store.update(current.id, {
                    status: "await_repair_review",
                    repairAttempts: attempt.repairAttempts,
                    lastRepairedCode: attempt.fixedCode,
                    statusMessage: attempt.summary,
                })) ?? current
            );
        }
        const saved = await (dependencies.writeTest ?? writeTestFile)(
            projectPath,
            savedTestPath,
            attempt.fixedCode,
            current.testName,
            autonomy,
        );
        if (!saved.success) {
            return (
                (await store.update(current.id, {
                    status: "failed",
                    repairAttempts: attempt.repairAttempts,
                    statusMessage: saved.message,
                })) ?? current
            );
        }
        const run = await (dependencies.executeRun ?? executeTestRun)(
            projectPath,
            savedTestPath,
            false,
            autonomy,
            undefined,
            true,
            // Verifying a fix, not running at the user's request: no retries,
            // and it has to hold up across repetitions.
            true,
        );
        const results = run.results ?? [];
        const next = repairLoopService.nextStatus(
            { testRunResult: results, repairAttempts: attempt.repairAttempts },
            autonomy,
        );
        current =
            (await store.update(current.id, {
                status: next,
                repairAttempts: attempt.repairAttempts,
                lastRepairedCode: attempt.fixedCode,
                lastRunResults: results,
                runSummary: {
                    passed: run.success,
                    failureCount: results.filter((result) => result.status !== "passed").length,
                },
                statusMessage: run.message,
            })) ?? current;
        if (next !== "repairing") return current;
    }
    return current;
}

export async function advanceHitlWorkflow(
    input: {
        projectPath: string;
        workflowId: string;
    },
    dependencies: HitlWorkflowDependencies = {},
): Promise<HitlWorkflowRecord> {
    return runDetachedOperation(
        { workflowId: input.workflowId, projectPath: input.projectPath },
        async () => {
            mergeCorrelationContext({
                workflowId: input.workflowId,
                projectPath: input.projectPath,
            });
            const store = new WorkflowStore(input.projectPath);
            const workflow = await store.load(input.workflowId);
            if (!workflow) throw new Error("The requested HITL workflow no longer exists.");
            if (workflow.status !== "repairing") return workflow;
            const lease = await acquireProjectOperation(input.projectPath, "test");
            try {
                return await driveRepairLoop(
                    store,
                    workflow,
                    input.projectPath,
                    undefined,
                    dependencies,
                );
            } finally {
                await lease.release();
            }
        },
    );
}

export async function continueHitlWorkflow(
    input: ContinueHitlWorkflowInput,
    dependencies: HitlWorkflowDependencies = {},
): Promise<ContinueHitlWorkflowResult> {
    return runDetachedOperation(
        { workflowId: input.workflowId, projectPath: input.projectPath },
        async () => {
            mergeCorrelationContext({
                workflowId: input.workflowId,
                projectPath: input.projectPath,
            });
            const store = new WorkflowStore(input.projectPath);
            const workflow = await store.load(input.workflowId);
            if (!workflow) throw new Error("The requested HITL workflow no longer exists.");

            if (input.action === "save") {
                if (workflow.status !== "await_save_approval") {
                    throw new Error("This workflow is not awaiting a save decision.");
                }
                if (input.decision === "reject") {
                    const cancelled = await store.update(workflow.id, {
                        status: "cancelled",
                        pendingAction: undefined,
                    });
                    return { workflow: cancelled ?? workflow };
                }

                const filePath = input.filePath?.trim() || workflow.savedTestPath;
                if (!filePath || !workflow.testDraft)
                    throw new Error("The saved test draft is unavailable.");
                const lease = await acquireProjectOperation(input.projectPath, "test");
                try {
                    const autonomy = resolveWorkflowAutonomy(input.projectPath, workflow);
                    const saved = await writeTestFile(
                        input.projectPath,
                        filePath,
                        workflow.testDraft,
                        workflow.testName,
                        autonomy,
                        { avoidOverwrite: input.avoidOverwrite },
                    );
                    if (!saved.success) {
                        const failed = await store.update(workflow.id, {
                            status: "failed",
                            pendingAction: undefined,
                        });
                        return { workflow: failed ?? workflow };
                    }
                    const updated = await store.update(workflow.id, {
                        savedTestPath: filePath,
                        status: workflow.shouldRunTests ? "await_run_approval" : "completed",
                        pendingAction: workflow.shouldRunTests ? "run" : undefined,
                    });
                    return { workflow: updated ?? workflow, savedPath: filePath };
                } finally {
                    await lease.release();
                }
            }

            if (workflow.status !== "await_run_approval") {
                throw new Error("This workflow is not awaiting a run decision.");
            }
            if (input.decision === "reject") {
                const cancelled = await store.update(workflow.id, {
                    status: "cancelled",
                    pendingAction: undefined,
                });
                return { workflow: cancelled ?? workflow };
            }
            if (!workflow.savedTestPath) throw new Error("The saved test path is unavailable.");

            const lease = await acquireProjectOperation(input.projectPath, "test");
            try {
                const autonomy = resolveWorkflowAutonomy(input.projectPath, workflow);
                const run = dependencies.executeRun
                    ? await dependencies.executeRun(
                          input.projectPath,
                          workflow.savedTestPath,
                          false,
                          autonomy,
                          undefined,
                          true,
                      )
                    : await executeApprovedUserRun(input.projectPath, workflow.savedTestPath);
                const results = run.results ?? [];
                const next = repairLoopService.nextStatus(
                    { testRunResult: results, repairAttempts: workflow.repairAttempts },
                    autonomy,
                );
                const updated = await store.update(workflow.id, {
                    status: next,
                    pendingAction: undefined,
                    runSummary: {
                        passed: run.success,
                        failureCount: results.filter((result) => result.status !== "passed").length,
                    },
                    lastRunResults: results,
                    statusMessage: run.message,
                });
                const nextWorkflow =
                    updated?.status === "repairing"
                        ? await driveRepairLoop(
                              store,
                              updated,
                              input.projectPath,
                              undefined,
                              dependencies,
                          )
                        : (updated ?? workflow);
                return { workflow: nextWorkflow, run };
            } finally {
                await lease.release();
            }
        },
    );
}
