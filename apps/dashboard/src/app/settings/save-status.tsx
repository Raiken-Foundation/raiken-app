export function SaveBar({
    dirty,
    saved,
    isSaving,
    onDiscard,
    onSave,
}: {
    dirty: boolean;
    saved: boolean;
    isSaving: boolean;
    onDiscard: () => void;
    onSave: () => void;
}) {
    return (
        <div className="save-bar">
            {saved && <span className="save-toast">Saved</span>}
            <button type="button" className="btn-secondary" onClick={onDiscard} disabled={!dirty}>
                Discard
            </button>
            <button
                type="button"
                className="btn-primary"
                onClick={onSave}
                disabled={!dirty || isSaving}
            >
                {isSaving ? "Saving..." : "Save Changes"}
            </button>
        </div>
    );
}

export function SaveErrorBanner({ error, onDismiss }: { error: string; onDismiss: () => void }) {
    return (
        <div className="save-error-banner">
            <span>Save failed: {error}</span>
            <button type="button" className="save-error-dismiss" onClick={onDismiss}>
                ×
            </button>
        </div>
    );
}
