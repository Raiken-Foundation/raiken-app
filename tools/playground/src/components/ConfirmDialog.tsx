import Modal from "./Modal";

interface ConfirmDialogProps {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

export default function ConfirmDialog({
    open,
    title,
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    return (
        <Modal
            open={open}
            title={title}
            onClose={onCancel}
            testId="confirm-dialog"
            footer={
                <>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={onCancel}
                        data-testid="confirm-cancel"
                    >
                        {cancelLabel}
                    </button>
                    <button
                        type="button"
                        className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
                        onClick={onConfirm}
                        data-testid="confirm-accept"
                    >
                        {confirmLabel}
                    </button>
                </>
            }
        >
            <p className="confirm-message">{message}</p>
        </Modal>
    );
}
