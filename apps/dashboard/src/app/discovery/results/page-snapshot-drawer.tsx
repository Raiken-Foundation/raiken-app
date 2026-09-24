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

export function PageSnapshotDrawer({
    loading,
    snapshotJson,
    meta,
    onClose,
}: PageSnapshotDrawerProps) {
    return (
        <div className="snapshot-drawer">
            <div className="snapshot-bar">
                <span className="snapshot-title">DOM Snapshot</span>
                <button type="button" className="snapshot-close" onClick={onClose}>
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
                    <pre className="snapshot-pre">{snapshotJson}</pre>
                </>
            )}
        </div>
    );
}
