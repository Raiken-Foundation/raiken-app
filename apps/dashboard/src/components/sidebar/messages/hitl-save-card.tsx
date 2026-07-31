import type { HitlWorkflowRecord } from "@raiken/shared";
import { deriveSaveResolution, enrichHitlFromWorkflow } from "../hitl/workflow-state";
import type { HITLConfirmation, SaveApprovalResolution } from "../types";
import { openHitlTestInEditor } from "./message-content";

export interface HitlSaveCardProps {
    messageId: string;
    hitl: HITLConfirmation;
    workflows: HitlWorkflowRecord[];
    workflowsAuthoritative: boolean;
    sessionSaveApprovals: Record<string, SaveApprovalResolution>;
    pathEdits: Record<string, string>;
    setPathEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    isSaving: boolean;
    runningTestFor: string | null;
    onSave: (
        messageId: string,
        actionId: "save_approve" | "save_approve_remember" | "save_reject",
        hitl: HITLConfirmation,
    ) => void;
    onRunSaved: (messageId: string, filePath: string, workflowId?: string) => void;
    onFileSelect?: (filePath: string) => void;
}

export function HitlSaveCard({
    messageId,
    hitl,
    workflows,
    workflowsAuthoritative,
    sessionSaveApprovals,
    pathEdits,
    setPathEdits,
    isSaving,
    runningTestFor,
    onSave,
    onRunSaved,
    onFileSelect,
}: HitlSaveCardProps) {
    const enriched = enrichHitlFromWorkflow(hitl, workflows);
    const decision = deriveSaveResolution(
        { id: messageId, hitlData: enriched },
        workflows,
        sessionSaveApprovals,
        workflowsAuthoritative,
    );
    const editedPath = pathEdits[messageId] ?? enriched.suggestedPath ?? "";
    const isResolved = Boolean(decision);
    const isPending = !isResolved;

    return (
        <div className="hitl-confirmation hitl-save">
            <div className="hitl-header">
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                    focusable="false"
                >
                    <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                    <path d="M17 21v-8H7v8M7 3v5h8" />
                </svg>
                <span>{enriched.title}</span>
            </div>
            <p className="hitl-message">{enriched.message}</p>

            {enriched.testCode && (
                <div className="hitl-code-preview">
                    <div className="hitl-code-header">
                        <span>{enriched.testName ?? "test"}</span>
                        <span className="hitl-code-meta">
                            {enriched.testCode.split("\n").length} lines
                        </span>
                    </div>
                    <pre>
                        <code>{enriched.testCode}</code>
                    </pre>
                </div>
            )}

            <label className="hitl-path-row" htmlFor={`hitl-path-${messageId}`}>
                <span>Save to</span>
                <input
                    id={`hitl-path-${messageId}`}
                    className="hitl-path-input"
                    type="text"
                    value={editedPath}
                    onChange={(e) =>
                        setPathEdits((prev) => ({ ...prev, [messageId]: e.target.value }))
                    }
                    disabled={isResolved || isSaving}
                />
            </label>

            <div className="hitl-actions">
                {enriched.testCode && (
                    <button
                        type="button"
                        className="hitl-btn ghost"
                        onClick={() => openHitlTestInEditor(enriched, onFileSelect)}
                        disabled={isSaving}
                        title="Open the generated test in the editor to review it"
                    >
                        <span>Open in editor</span>
                    </button>
                )}
                {isPending &&
                    enriched.options.map((option) => {
                        const variant =
                            option.id === "save_approve"
                                ? "primary"
                                : option.id === "save_reject"
                                  ? "danger"
                                  : "secondary";
                        return (
                            <button
                                key={option.id}
                                type="button"
                                className={`hitl-btn ${variant}`}
                                onClick={() =>
                                    onSave(
                                        messageId,
                                        option.id as
                                            | "save_approve"
                                            | "save_approve_remember"
                                            | "save_reject",
                                        enriched,
                                    )
                                }
                                disabled={isResolved || isSaving}
                                title={option.description}
                            >
                                <span>{option.label}</span>
                            </button>
                        );
                    })}
            </div>

            {decision?.status === "saved" && (
                <div className="hitl-resolved hitl-resolved-ok">
                    <p>
                        ✅ Saved to <code>{decision.filePath}</code>.
                    </p>
                    {decision.filePath && (
                        <div className="hitl-actions">
                            <button
                                type="button"
                                className="hitl-btn secondary"
                                onClick={() => onFileSelect?.(decision.filePath as string)}
                                disabled={Boolean(runningTestFor)}
                                title="Open the saved test in the editor"
                            >
                                <span>Open in editor</span>
                            </button>
                            <button
                                type="button"
                                className="hitl-btn primary"
                                onClick={() =>
                                    onRunSaved(
                                        messageId,
                                        decision.filePath as string,
                                        enriched.context.workflowId,
                                    )
                                }
                                disabled={Boolean(runningTestFor)}
                                title="Run this test now"
                            >
                                <span>
                                    {runningTestFor === messageId ? "Running…" : "Run test"}
                                </span>
                            </button>
                        </div>
                    )}
                </div>
            )}
            {decision?.status === "rejected" && (
                <p className="hitl-resolved hitl-resolved-warn">
                    {decision.error ? `⚠️ ${decision.error}` : "❌ Rejected — draft discarded."}
                </p>
            )}
            {decision?.status === "handled" && (
                <p className="hitl-resolved hitl-resolved-warn">Approval already handled.</p>
            )}
        </div>
    );
}
