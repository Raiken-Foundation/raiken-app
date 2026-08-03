export function EmptyState({
    title,
    hint,
    action,
}: {
    title: string;
    hint?: string;
    action?: React.ReactNode;
}) {
    return (
        <div className="empty-state" data-testid="empty-state">
            <p className="empty-state-title">{title}</p>
            {hint ? <p className="muted">{hint}</p> : null}
            {action ? <div className="empty-state-action">{action}</div> : null}
        </div>
    );
}
