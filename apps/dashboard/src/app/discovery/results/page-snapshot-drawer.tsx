import { useEffect, useRef } from "react";

interface PageSnapshotDrawerProps {
    selectedPageUrl: string;
    loading: boolean;
    snapshotJson: string | null | undefined;
    meta: {
        url: string;
        depth: number;
        title?: string | null;
    } | null;
    onClose: () => void;
}

/**
 * The DOM snapshot drawer. Dialog semantics: focus moves into the drawer on
 * open and back to the invoker on close; Escape closes; the close control
 * carries a real accessible name (it is "Close snapshot", not a bare ×).
 */
export function PageSnapshotDrawer({
    loading,
    snapshotJson,
    meta,
    onClose,
}: PageSnapshotDrawerProps) {
    const closeRef = useRef<HTMLButtonElement>(null);
    const restoreFocusRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        restoreFocusRef.current = document.activeElement as HTMLElement | null;
        closeRef.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("keydown", onKey);
            restoreFocusRef.current?.focus();
        };
    }, [onClose]);

    return (
        <aside
            className="snapshot-drawer"
            role="dialog"
            aria-modal="false"
            aria-label="DOM snapshot"
        >
            <div className="snapshot-bar">
                <span className="snapshot-title">DOM Snapshot</span>
                <button
                    ref={closeRef}
                    type="button"
                    className="snapshot-close"
                    onClick={onClose}
                    aria-label="Close snapshot"
                    title="Close (Esc)"
                >
                    &times;
                </button>
            </div>
            {loading ? (
                <p className="empty">Loading snapshot…</p>
            ) : !snapshotJson ? (
                <p className="empty">No snapshot available for this page.</p>
            ) : (
                <>
                    <div className="snapshot-meta">
                        <span>{meta?.url}</span>
                        <span>Depth {meta?.depth}</span>
                        {meta?.title && <span>{meta.title}</span>}
                    </div>
                    <pre className="snapshot-pre" tabIndex={0} aria-label="Snapshot content">
                        {snapshotJson}
                    </pre>
                </>
            )}
        </aside>
    );
}
