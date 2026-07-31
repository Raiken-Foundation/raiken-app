import type { HitlWorkflowRecord } from "@raiken/shared";
import type { Message, RunApprovalResolution, SaveApprovalResolution } from "../types";
import { HitlLegacyCard } from "./hitl-legacy-card";
import { HitlRunCard, type HitlRunCardProps } from "./hitl-run-card";
import { HitlSaveCard, type HitlSaveCardProps } from "./hitl-save-card";
import { MessageContent, openCodeInEditor } from "./message-content";

interface MessageListProps {
    messages: Message[];
    messagesRef: React.RefObject<HTMLDivElement | null>;
    onScroll: () => void;
    isNearBottom: boolean;
    onScrollToBottom: () => void;
    isGenerating: boolean;
    workflows: HitlWorkflowRecord[];
    workflowsAuthoritative: boolean;
    sessionSaveApprovals: Record<string, SaveApprovalResolution>;
    sessionRunApprovals: Record<string, RunApprovalResolution>;
    pathEdits: Record<string, string>;
    setPathEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    saveTestMutation: { isPending: boolean };
    runningTestFor: string | null;
    onSaveApproval: HitlSaveCardProps["onSave"];
    onRunApproval: HitlRunCardProps["onRun"];
    onRunSavedTest: HitlSaveCardProps["onRunSaved"];
    onHITLAction: (actionId: string, context: { url?: string; files?: string[] }) => void;
    onFileSelect?: (filePath: string) => void;
}

export function MessageList({
    messages,
    messagesRef,
    onScroll,
    isNearBottom,
    onScrollToBottom,
    isGenerating,
    workflows,
    workflowsAuthoritative,
    sessionSaveApprovals,
    sessionRunApprovals,
    pathEdits,
    setPathEdits,
    saveTestMutation,
    runningTestFor,
    onSaveApproval,
    onRunApproval,
    onRunSavedTest,
    onHITLAction,
    onFileSelect,
}: MessageListProps) {
    return (
        <>
            <div className="messages" ref={messagesRef} onScroll={onScroll}>
                {messages.map((msg) => (
                    <div key={msg.id} className={`message ${msg.isUser ? "user" : "assistant"}`}>
                        <div className="message-bubble">
                            {msg.isLoading ? (
                                <div className="agent-activity">
                                    {msg.activity && msg.activity.length > 0 ? (
                                        <ul className="activity-trail">
                                            {msg.activity.map((label, i, arr) => (
                                                <li
                                                    key={`${msg.id}-act-${i}`}
                                                    className={
                                                        i === arr.length - 1
                                                            ? "activity-current"
                                                            : "activity-done"
                                                    }
                                                >
                                                    {label}
                                                </li>
                                            ))}
                                        </ul>
                                    ) : null}
                                    <div className="typing-indicator">
                                        <span></span>
                                        <span></span>
                                        <span></span>
                                    </div>
                                </div>
                            ) : msg.hitlData?.kind === "save_approval" ? (
                                <HitlSaveCard
                                    messageId={msg.id}
                                    hitl={msg.hitlData}
                                    workflows={workflows}
                                    workflowsAuthoritative={workflowsAuthoritative}
                                    sessionSaveApprovals={sessionSaveApprovals}
                                    pathEdits={pathEdits}
                                    setPathEdits={setPathEdits}
                                    isSaving={saveTestMutation.isPending}
                                    runningTestFor={runningTestFor}
                                    onSave={onSaveApproval}
                                    onRunSaved={onRunSavedTest}
                                    onFileSelect={onFileSelect}
                                />
                            ) : msg.hitlData?.kind === "run_approval" ? (
                                <HitlRunCard
                                    messageId={msg.id}
                                    hitl={msg.hitlData}
                                    workflows={workflows}
                                    workflowsAuthoritative={workflowsAuthoritative}
                                    sessionRunApprovals={sessionRunApprovals}
                                    runningTestFor={runningTestFor}
                                    onRun={onRunApproval}
                                />
                            ) : msg.hitlData ? (
                                <HitlLegacyCard
                                    hitl={msg.hitlData}
                                    isGenerating={isGenerating}
                                    onAction={onHITLAction}
                                />
                            ) : (
                                <MessageContent
                                    content={msg.content}
                                    isUser={msg.isUser}
                                    onOpenInEditor={(code, lang) =>
                                        openCodeInEditor(code, lang, onFileSelect)
                                    }
                                />
                            )}
                        </div>
                        <span className="message-time">{msg.timestamp}</span>
                    </div>
                ))}
            </div>

            {!isNearBottom && (
                <button
                    type="button"
                    className="scroll-to-bottom"
                    onClick={onScrollToBottom}
                    aria-label="Scroll to latest message"
                    title="Scroll to latest message"
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                        focusable="false"
                    >
                        <path d="M12 5v14M19 12l-7 7-7-7" />
                    </svg>
                </button>
            )}
        </>
    );
}
