import type { AutonomySettings } from "../agent/tools";
import type { TestRunResult } from "./runner";

export interface RepairLoopState {
    testRunResult?: TestRunResult[] | null;
    repairAttempts: number;
}

/**
 * The policy portion of the repair lifecycle. Keeping this independent of the
 * graph makes the exact same retry decision available to durable HITL
 * continuations, without changing the current graph execution behavior.
 */
export class RepairLoopService {
    shouldContinueRepair(state: RepairLoopState, autonomy: AutonomySettings): boolean {
        if (!state.testRunResult?.some((result) => result.status !== "passed")) return false;
        return autonomy.autoCorrect !== "off" && state.repairAttempts < autonomy.maxRetries;
    }

    nextStatus(
        state: RepairLoopState,
        autonomy: AutonomySettings,
    ): "completed" | "repairing" | "await_repair_review" {
        if (!state.testRunResult?.some((result) => result.status !== "passed")) return "completed";
        if (this.shouldContinueRepair(state, autonomy)) return "repairing";
        return autonomy.autoCorrect === "suggest" ? "await_repair_review" : "completed";
    }
}

export const repairLoopService = new RepairLoopService();
