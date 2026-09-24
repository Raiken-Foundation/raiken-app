import * as path from "node:path";
import { loadAutonomyConfig } from "../../../config";
import { executeRepairAttempt } from "../../../testing/repair-attempt";
import { repairLoopService } from "../../../testing/repair-loop-service";
import { isFailureStatus } from "../../../testing/run-outcome";
import type { AutonomySettings } from "../../tools";
import type { GraphStateType } from "../state";
import type { AgentNodeDeps } from "./types";

/**
 * Resolve autonomy settings for a node. Prefers the settings threaded
 * through by `agent.ts` (which already merges `raiken.config.json` with any
 * session-scoped override, e.g. the REPL's `/mode`); falls back to reading
 * the config file directly so nodes still work in isolation (tests, or any
 * caller that didn't wire `deps.autonomy` through).
 */
export function resolveAutonomy(
    deps: Pick<AgentNodeDeps, "autonomy" | "projectPath">,
): AutonomySettings {
    return deps.autonomy ?? loadAutonomyConfig(deps.projectPath);
}

export function shouldRepair(state: GraphStateType, autonomy: AutonomySettings): boolean {
    return repairLoopService.shouldContinueRepair(state, autonomy);
}

export const createRepairNode = (deps: AgentNodeDeps) => async (state: GraphStateType) => {
    const { callTool, gatherContext, projectPath, model } = deps;
    const results = state.testRunResult;
    // Skipped tests are not failures, so a run without any genuine failure has
    // nothing to repair — `every(passed)` would loop on skip-only runs.
    if (!results || !results.some((r) => isFailureStatus(r.status))) {
        return {};
    }

    const repair = await executeRepairAttempt(
        { model, gatherContext },
        {
            projectPath,
            savedTestPath: state.savedTestPath ?? undefined,
            testDraft: state.testDraft ?? undefined,
            testRunResult: results,
            repairAttempts: state.repairAttempts,
            lastRepairedCode: state.lastRepairedCode ?? undefined,
            domSummary: state.domSummary ?? undefined,
            pageSummaries: state.pageSummaries ?? undefined,
            context: state.context ?? undefined,
            signal: deps.signal,
        },
    );
    const fixedCode = repair.fixedCode;
    if (!fixedCode) {
        return {
            repairAttempts: repair.repairAttempts,
            summary: repair.summary,
            groundingViolations: repair.groundingViolations ?? [],
        };
    }
    if (repair.noProgress) {
        return {
            repairAttempts: repair.repairAttempts,
            shouldPause: true,
            lastRepairedCode: fixedCode,
            summary: repair.summary,
            awaitUserMessage: `Automatic repair couldn't find a working fix after ${repair.repairAttempts} attempt(s). Please review the failure and edit the test manually.`,
        };
    }

    // Both "suggest" and "apply" retry autonomously up to `maxRetries` —
    // pausing after every single attempt (the old "suggest" behavior)
    // defeated the point of automatic repair, and requiring a fresh
    // approval for a write here is redundant: the file was already
    // approved once to reach the repair loop at all, so `autoCorrect`
    // (not `autoSaveTests`) is the authorizing signal for THIS write.
    // `_repairVerification` tells the tool to use that gate instead.
    // The two modes now differ only in what happens once the loop ends:
    // "apply" fully trusts the loop and just reports the outcome via the
    // normal summary either way; "suggest" gets one explicit pause, but
    // only when automatic repair is exhausted and still failing (see
    // `createHitlRunNode`) — never on the happy path.
    if (state.savedTestPath) {
        const saveResult = await callTool("saveFile", {
            filePath: state.savedTestPath,
            content: fixedCode,
            testName: path.basename(state.savedTestPath),
            _repairVerification: true,
            // The file under repair IS the destination — a dedup guard that
            // redirected this write would leave the broken original in place
            // and verify a copy.
            _overwriteTarget: true,
        });
        if (!saveResult.success) {
            return {
                summary: `Repair attempt ${repair.repairAttempts} failed to save: ${saveResult.message}`,
                repairAttempts: repair.repairAttempts,
            };
        }
        return {
            testDraft: fixedCode,
            repairAttempts: repair.repairAttempts,
            testRunResult: null,
            lastRepairedCode: fixedCode,
        };
    }

    // No file to repair in place (e.g. the draft was never saved) —
    // nothing to verify against, so fall back to holding the candidate
    // for manual review.
    return {
        testDraft: fixedCode,
        repairAttempts: repair.repairAttempts,
        shouldPause: true,
        lastRepairedCode: fixedCode,
        awaitUserMessage: `Test repair suggestion (attempt ${repair.repairAttempts}):\n\nThe corrected test has been generated. Review the changes and approve to save.`,
    };
};
