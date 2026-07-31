import type { HITLConfirmation } from "../types";

export interface HitlLegacyCardProps {
    hitl: HITLConfirmation;
    isGenerating: boolean;
    onAction: (actionId: string, context: { url?: string; files?: string[] }) => void;
}

export function HitlLegacyCard({ hitl, isGenerating, onAction }: HitlLegacyCardProps) {
    return (
        <div className="hitl-confirmation">
            <div className="hitl-header">
                <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                >
                    <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <span>{hitl.title}</span>
            </div>
            <p className="hitl-message">{hitl.message}</p>
            {hitl.reasons.length > 0 && (
                <ul className="hitl-reasons">
                    {hitl.reasons.map((reason, i) => (
                        <li key={i}>{reason}</li>
                    ))}
                </ul>
            )}
            <div className="hitl-actions">
                {hitl.options.map((option) => (
                    <button
                        type="button"
                        key={option.id}
                        className={`hitl-btn ${option.id === "proceed" ? "primary" : "secondary"}`}
                        onClick={() => onAction(option.id, hitl.context ?? {})}
                        disabled={isGenerating}
                    >
                        {option.id === "proceed" ? (
                            <svg
                                aria-hidden="true"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <path d="M5 13l4 4L19 7" />
                            </svg>
                        ) : (
                            <svg
                                aria-hidden="true"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <path d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        )}
                        <span>{option.label}</span>
                    </button>
                ))}
            </div>
            <p className="hitl-hint">{hitl.options.find((o) => o.id === "proceed")?.description}</p>
        </div>
    );
}
