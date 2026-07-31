import type { HitlWorkflowRecord } from "@raiken/shared";
import { deriveRunResolution, enrichHitlFromWorkflow } from "../hitl/workflow-state";
import type { HITLConfirmation, RunApprovalResolution } from "../types";

export interface HitlRunCardProps {
    messageId: string;
    hitl: HITLConfirmation;
    workflows: HitlWorkflowRecord[];
    workflowsAuthoritative: boolean;
    sessionRunApprovals: Record<string, RunApprovalResolution>;
    runningTestFor: string | null;
    onRun: (
        messageId: string,
        actionId: "run_approve" | "run_approve_remember" | "run_reject",
        hitl: HITLConfirmation,
    ) => void;
}

export function HitlRunCard({
    messageId,
    hitl,
    workflows,
    workflowsAuthoritative,
    sessionRunApprovals,
    runningTestFor,
    onRun,
}: HitlRunCardProps) {
    const enriched = enrichHitlFromWorkflow(hitl, workflows);
    const decision = deriveRunResolution(
        { id: messageId, hitlData: enriched },
        workflows,
        sessionRunApprovals,
        workflowsAuthoritative,
    );
    const isResolved = Boolean(decision);
    const isRunning = runningTestFor === messageId;

    return (
        <div className="hitl-confirmation hitl-run">
            <div className="hitl-header">
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                    focusable="false"
                >
                    <path d="M5 3l14 9-14 9V3z" />
                </svg>
                <span>{enriched.title}</span>
            </div>
            <p className="hitl-message">{enriched.message}</p>
            {enriched.testFile && (
                <p className="hitl-run-file">
                    <code>{enriched.testFile}</code>
                </p>
            )}
            {!isResolved && (
                <div className="hitl-actions">
                    {enriched.options.map((option) => {
                        const variant = option.id === "run_reject" ? "secondary" : "primary";
                        return (
                            <button
                                key={option.id}
                                type="button"
                                className={`hitl-btn ${variant}`}
                                onClick={() =>
                                    onRun(
                                        messageId,
                                        option.id as
                                            | "run_approve"
                                            | "run_approve_remember"
                                            | "run_reject",
                                        enriched,
                                    )
                                }
                                disabled={isRunning}
                                title={option.description}
                            >
                                <span>{isRunning ? "Running…" : option.label}</span>
                            </button>
                        );
                    })}
                </div>
            )}
            {decision?.status === "ran" && !decision.error && (
                <p className="hitl-resolved hitl-resolved-ok">
                    {decision.passed
                        ? "✅ Passed."
                        : "❌ Failed — open the file and use Fix with AI."}
                </p>
            )}
            {decision?.error && (
                <p className="hitl-resolved hitl-resolved-warn">⚠️ {decision.error}</p>
            )}
            {decision?.status === "skipped" && !decision.error && (
                <p className="hitl-resolved hitl-resolved-warn">Skipped.</p>
            )}
            {decision?.status === "cancelled" && !decision.error && (
                <p className="hitl-resolved hitl-resolved-warn">Test run cancelled.</p>
            )}
            {decision?.status === "handled" && (
                <p className="hitl-resolved hitl-resolved-warn">Run decision already handled.</p>
            )}
        </div>
    );
}
