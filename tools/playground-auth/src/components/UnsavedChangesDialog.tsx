import ConfirmDialog from "./ConfirmDialog";

interface UnsavedChangesDialogProps {
    onStay: () => void;
    onDiscard: () => void;
}

export default function UnsavedChangesDialog({ onStay, onDiscard }: UnsavedChangesDialogProps) {
    return (
        <ConfirmDialog
            testId="unsaved-changes-dialog"
            title="Unsaved changes"
            description="You have unsaved settings. Stay on this page or discard your changes?"
            confirmLabel="Discard changes"
            cancelLabel="Stay"
            onConfirm={onDiscard}
            onCancel={onStay}
        />
    );
}
