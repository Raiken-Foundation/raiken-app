import type { ActivityEntry, User } from "../../types";

interface Props {
    entries: ActivityEntry[];
    members: User[];
}

export default function ActivityPanel({ entries, members }: Props) {
    if (entries.length === 0) {
        return (
            <div className="empty-state" data-testid="activity-empty">
                No activity yet.
            </div>
        );
    }
    return (
        <ol className="activity-feed" data-testid="activity-panel">
            {entries.map((entry) => {
                const actor = members.find((m) => m.id === entry.actorId);
                return (
                    <li key={entry.id} className="activity-feed-row">
                        <span className="activity-actor">{actor?.username ?? "someone"}</span>
                        <span className="activity-text">{entry.summary}</span>
                        <time className="activity-time">
                            {new Date(entry.timestamp).toLocaleString()}
                        </time>
                    </li>
                );
            })}
        </ol>
    );
}
