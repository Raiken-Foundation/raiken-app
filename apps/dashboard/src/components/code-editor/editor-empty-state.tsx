import { MOD } from "./constants";

export function EditorEmptyState({ onNewFile }: { onNewFile?: () => void }) {
    return (
        <div className="ce-shell">
            <div className="ce-empty">
                <pre className="ce-empty-prompt" aria-hidden="true">
                    $ raiken — no file open
                </pre>
                <p className="ce-empty-hint">
                    Open a spec from the sidebar
                    {onNewFile && (
                        <>
                            {" "}
                            or{" "}
                            <button type="button" className="ce-empty-link" onClick={onNewFile}>
                                create a new file
                            </button>
                        </>
                    )}
                    .
                </p>
            </div>
        </div>
    );
}

export function EditorSelectFileHint() {
    return (
        <div className="ce-empty">
            <p className="ce-empty-hint">Select a file from the tabs above.</p>
        </div>
    );
}

export function EditorLoadingOverlay({ label }: { label: string }) {
    return (
        <div className="ce-loading">
            <span className="ce-loading-spin" aria-hidden="true" />
            <span>{label}</span>
        </div>
    );
}

export { MOD };
