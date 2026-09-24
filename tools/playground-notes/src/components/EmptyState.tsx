import type { ReactNode } from "react";

interface EmptyStateProps {
    title: string;
    message: string;
    action?: ReactNode;
}

export function EmptyState({ title, message, action }: EmptyStateProps) {
    return (
        <div className="empty-state" data-testid="empty-state">
            <h2>{title}</h2>
            <p>{message}</p>
            {action}
        </div>
    );
}
