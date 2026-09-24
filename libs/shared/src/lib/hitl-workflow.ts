/**
 * Transport-safe HITL workflow record returned over tRPC.
 *
 * Kept in shared so dashboard bundles never import `@raiken/core` for this
 * shape. Compile-time parity with core is enforced in `config-parity.server.ts`.
 */

export type HitlWorkflowStatus =
    | "await_save_approval"
    | "await_run_approval"
    | "repairing"
    | "await_repair_review"
    | "completed"
    | "failed"
    | "cancelled";

export type HitlTestRunResultTransport = {
    testFile: string;
    testName: string;
    suite?: string;
    status: "passed" | "failed" | "error" | "timeout" | "skipped" | "flaky";
    duration: number;
    error?: {
        message: string;
        stack?: string;
        selector?: string;
        snippet?: string;
        location?: { file: string; line: number; column: number };
    };
    attachments?: Array<{
        name: string;
        contentType: string;
        path?: string;
        body?: string;
    }>;
};

export type HitlWorkflowRecord = {
    id: string;
    version: 1;
    kind: "test_generate_repair";
    status: HitlWorkflowStatus;
    createdAt: number;
    updatedAt: number;
    origin: "agent" | "dashboard" | "repl";
    savedTestPath?: string;
    testDraft?: string;
    testName?: string;
    shouldRunTests: boolean;
    repairAttempts: number;
    autonomy?: {
        autoCorrect: "suggest" | "apply" | "off";
        maxRetries: number;
        autoLearn: "confirm" | "auto" | "off";
    };
    lastRunResults?: HitlTestRunResultTransport[];
    lastRepairedCode?: string;
    statusMessage?: string;
    pendingAction?: "save" | "run";
    runSummary?: { passed: boolean; failureCount: number };
};
