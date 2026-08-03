import { useState } from "react";
import { Modal } from "./Modal";

export interface ConfirmDialogProps {
    title: string;
    body: string;
    confirmLabel: string;
    tone?: "danger" | "primary";
    onConfirm: () => Promise<void> | void;
    onCancel: () => void;
}

/** Destructive-action gate: every archive/remove in the fixture goes through this. */
export function ConfirmDialog({
    title,
    body,
    confirmLabel,
    tone = "danger",
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    const [busy, setBusy] = useState(false);

    const handleConfirm = async () => {
        setBusy(true);
        try {
            await onConfirm();
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            title={title}
            onClose={onCancel}
            footer={
                <>
                    <button type="button" className="button button-ghost" onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className={`button ${tone === "danger" ? "button-danger" : "button-primary"}`}
                        data-testid="confirm-dialog-confirm"
                        disabled={busy}
                        onClick={handleConfirm}
                    >
                        {confirmLabel}
                    </button>
                </>
            }
        >
            <p className="muted">{body}</p>
        </Modal>
    );
}
