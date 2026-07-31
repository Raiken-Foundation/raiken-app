import type { HitlWorkflowRecord } from "@raiken/shared";
import type {
    HITLConfirmation,
    Message,
    RunApprovalResolution,
    SaveApprovalResolution,
} from "../types";

const PENDING_SAVE = new Set<HitlWorkflowRecord["status"]>(["await_save_approval"]);
const PENDING_RUN = new Set<HitlWorkflowRecord["status"]>(["await_run_approval"]);

export function workflowById(workflows: HitlWorkflowRecord[]): Map<string, HitlWorkflowRecord> {
    return new Map(workflows.map((workflow) => [workflow.id, workflow]));
}

export function isWorkflowPendingSave(
    workflowId: string | undefined,
    workflows: HitlWorkflowRecord[],
): boolean {
    if (!workflowId) return false;
    const workflow = workflows.find((item) => item.id === workflowId);
    return Boolean(workflow && PENDING_SAVE.has(workflow.status));
}

export function isWorkflowPendingRun(
    workflowId: string | undefined,
    workflows: HitlWorkflowRecord[],
): boolean {
    if (!workflowId) return false;
    const workflow = workflows.find((item) => item.id === workflowId);
    return Boolean(workflow && PENDING_RUN.has(workflow.status));
}

/**
 * Derive save/run card resolution from durable workflow status. Session-only
 * resolutions cover legacy cards without a workflow id and in-flight mutations.
 */
export function deriveSaveResolution(
    message: Pick<Message, "id" | "hitlData">,
    workflows: HitlWorkflowRecord[],
    session: Record<string, SaveApprovalResolution>,
    workflowsAuthoritative = false,
): SaveApprovalResolution | undefined {
    const workflowId = message.hitlData?.context.workflowId;
    if (workflowId) {
        const workflow = workflows.find((item) => item.id === workflowId);
        if (workflow && PENDING_SAVE.has(workflow.status)) return undefined;
        if (workflow && workflow.status === "cancelled") return { status: "rejected" };
        if (workflow?.savedTestPath && workflow.status !== "await_save_approval") {
            return { status: "saved", filePath: workflow.savedTestPath };
        }
        if (!workflow) {
            if (!workflowsAuthoritative) return undefined;
            return session[message.id] ?? { status: "handled" };
        }
    }
    return session[message.id];
}

export function deriveRunResolution(
    message: Pick<Message, "id" | "hitlData">,
    workflows: HitlWorkflowRecord[],
    session: Record<string, RunApprovalResolution>,
    workflowsAuthoritative = false,
): RunApprovalResolution | undefined {
    const workflowId = message.hitlData?.context.workflowId;
    if (workflowId) {
        const workflow = workflows.find((item) => item.id === workflowId);
        if (workflow && PENDING_RUN.has(workflow.status)) return undefined;
        if (workflow && workflow.status === "cancelled") return { status: "skipped" };
        if (workflow?.runSummary) {
            return { status: "ran", passed: workflow.runSummary.passed };
        }
        if (workflow && workflow.status === "completed") {
            return { status: "ran", passed: workflow.runSummary?.passed ?? true };
        }
        if (!workflow) {
            if (!workflowsAuthoritative) return undefined;
            return session[message.id] ?? { status: "handled" };
        }
    }
    return session[message.id];
}

export function computeHitlPending(
    messages: Pick<Message, "id" | "isUser" | "hitlData">[],
    workflows: HitlWorkflowRecord[],
    sessionSave: Record<string, SaveApprovalResolution> = {},
    sessionRun: Record<string, RunApprovalResolution> = {},
    workflowsAuthoritative = false,
): boolean {
    if (
        workflows.some(
            (workflow) => !["completed", "failed", "cancelled"].includes(workflow.status),
        )
    ) {
        return true;
    }

    return messages.some((msg) => {
        if (msg.isUser || !msg.hitlData) return false;
        if (msg.hitlData.kind === "save_approval") {
            return !deriveSaveResolution(msg, workflows, sessionSave, workflowsAuthoritative);
        }
        if (msg.hitlData.kind === "run_approval") {
            return !deriveRunResolution(msg, workflows, sessionRun, workflowsAuthoritative);
        }
        return false;
    });
}

export function rehydrateWorkflowHitlCards(
    messages: Message[],
    workflows: HitlWorkflowRecord[],
): Message[] {
    const represented = new Set(
        messages
            .map((message) => message.hitlData?.context.workflowId)
            .filter((id): id is string => Boolean(id)),
    );
    const recovered = workflows.flatMap((workflow): Message[] => {
        if (represented.has(workflow.id)) return [];
        const context = { workflowId: workflow.id };
        const timestamp = new Date(workflow.updatedAt).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
        });
        if (workflow.status === "await_save_approval" && workflow.testDraft) {
            return [
                {
                    id: `workflow-${workflow.id}`,
                    content: "Recovered a generated test that is awaiting your approval.",
                    timestamp,
                    isUser: false,
                    hitlData: {
                        kind: "save_approval",
                        type: "save",
                        title: "Approve test save",
                        message: "Review and save this recovered test draft, or reject it.",
                        reasons: [],
                        options: [
                            {
                                id: "save_approve",
                                label: "Save",
                                description: "Write the recovered test to disk.",
                            },
                            {
                                id: "save_reject",
                                label: "Reject",
                                description: "Discard the recovered draft.",
                            },
                        ],
                        context,
                        testCode: workflow.testDraft,
                        suggestedPath: workflow.savedTestPath,
                        testName: workflow.testName,
                    },
                },
            ];
        }
        if (workflow.status === "await_run_approval" && workflow.savedTestPath) {
            return [
                {
                    id: `workflow-${workflow.id}`,
                    content: "Recovered a saved test that is awaiting run approval.",
                    timestamp,
                    isUser: false,
                    hitlData: {
                        kind: "run_approval",
                        type: "run",
                        title: "Approve test run",
                        message: "Run the recovered saved test, or skip it.",
                        reasons: [],
                        options: [
                            {
                                id: "run_approve",
                                label: "Run",
                                description: "Run the recovered test.",
                            },
                            {
                                id: "run_reject",
                                label: "Skip",
                                description: "Do not run it now.",
                            },
                        ],
                        context,
                        testFile: workflow.savedTestPath,
                        testName: workflow.testName,
                    },
                },
            ];
        }
        return [
            {
                id: `workflow-${workflow.id}`,
                content:
                    workflow.statusMessage ??
                    `Test workflow for \`${workflow.savedTestPath ?? "unknown test"}\` needs attention.`,
                timestamp,
                isUser: false,
            },
        ];
    });
    return recovered.length > 0 ? [...messages, ...recovered] : messages;
}

export function enrichHitlFromWorkflow(
    hitl: HITLConfirmation,
    workflows: HitlWorkflowRecord[],
): HITLConfirmation {
    const workflowId = hitl.context.workflowId;
    if (!workflowId) return hitl;
    const workflow = workflows.find((item) => item.id === workflowId);
    if (!workflow) return hitl;
    if (hitl.kind === "save_approval") {
        return {
            ...hitl,
            testCode: hitl.testCode ?? workflow.testDraft,
            suggestedPath: hitl.suggestedPath ?? workflow.savedTestPath,
            testName: hitl.testName ?? workflow.testName,
        };
    }
    if (hitl.kind === "run_approval") {
        return {
            ...hitl,
            testFile: hitl.testFile ?? workflow.savedTestPath,
            testName: hitl.testName ?? workflow.testName,
        };
    }
    return hitl;
}
