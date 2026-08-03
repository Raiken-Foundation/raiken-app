import { useEffect, useRef } from "react";

interface ConfirmDialogProps {
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel: string;
    testId: string;
    onConfirm: () => void;
    onCancel: () => void;
    destructive?: boolean;
}

export default function ConfirmDialog({
    title,
    description,
    confirmLabel,
    cancelLabel,
    testId,
    onConfirm,
    onCancel,
    destructive = false,
}: ConfirmDialogProps) {
    const cancelRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        const previouslyFocused = document.activeElement as HTMLElement | null;
        cancelRef.current?.focus();
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onCancel();
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            previouslyFocused?.focus();
        };
    }, [onCancel]);

    return (
        <div className="modal-overlay" data-testid={`${testId}-overlay`}>
            <div
                className="modal-card"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={`${testId}-title`}
                aria-describedby={`${testId}-desc`}
                data-testid={testId}
            >
                <h2 id={`${testId}-title`}>{title}</h2>
                <p id={`${testId}-desc`} className="modal-desc">
                    {description}
                </p>
                <div className="modal-actions">
                    <button
                        ref={cancelRef}
                        type="button"
                        className="btn-secondary"
                        data-testid={`${testId}-cancel`}
                        onClick={onCancel}
                    >
                        {cancelLabel}
                    </button>
                    <button
                        type="button"
                        className={destructive ? "btn-danger" : "btn-primary"}
                        data-testid={`${testId}-confirm`}
                        onClick={onConfirm}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
