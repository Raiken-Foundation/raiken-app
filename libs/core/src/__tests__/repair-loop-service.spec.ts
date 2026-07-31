import { describe, expect, it } from "vitest";
import type { AutonomySettings } from "../agent/tools";
import { repairLoopService } from "../testing/repair-loop-service";

const failedRun = [
    {
        testFile: "e2e/login.spec.ts",
        testName: "logs in",
        status: "failed" as const,
        duration: 10,
    },
];

const autonomy = (autoCorrect: AutonomySettings["autoCorrect"]): AutonomySettings => ({
    autoSaveTests: false,
    autoRunTests: false,
    autoCorrect,
    autoLearn: "confirm",
    maxRetries: 2,
});

describe("RepairLoopService", () => {
    it("continues a failing run only while the retry policy permits it", () => {
        expect(
            repairLoopService.shouldContinueRepair(
                { testRunResult: failedRun, repairAttempts: 1 },
                autonomy("apply"),
            ),
        ).toBe(true);
        expect(
            repairLoopService.shouldContinueRepair(
                { testRunResult: failedRun, repairAttempts: 2 },
                autonomy("apply"),
            ),
        ).toBe(false);
    });

    // A fix that only worked on some verification runs is not a fix, so the
    // loop must keep going rather than declaring the test repaired.
    it("treats a flaky verification as unfinished work", () => {
        const flakyRun = [{ ...failedRun[0], status: "flaky" as const }];
        expect(
            repairLoopService.shouldContinueRepair(
                { testRunResult: flakyRun, repairAttempts: 0 },
                autonomy("apply"),
            ),
        ).toBe(true);
        expect(
            repairLoopService.nextStatus(
                { testRunResult: flakyRun, repairAttempts: 0 },
                autonomy("apply"),
            ),
        ).toBe("repairing");
    });

    it("surfaces exhausted suggest mode for manual review", () => {
        expect(
            repairLoopService.nextStatus(
                { testRunResult: failedRun, repairAttempts: 2 },
                autonomy("suggest"),
            ),
        ).toBe("await_repair_review");
        expect(
            repairLoopService.nextStatus(
                { testRunResult: failedRun, repairAttempts: 0 },
                autonomy("off"),
            ),
        ).toBe("completed");
    });
});
