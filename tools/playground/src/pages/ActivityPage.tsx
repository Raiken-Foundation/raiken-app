import { useEffect, useState } from "react";
import { listActivity, listAllUsers, listProjects } from "../api";
import type { ActivityEntry, Project, User } from "../types";

export default function ActivityPage() {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [entries, setEntries] = useState<ActivityEntry[]>([]);
    const [users, setUsers] = useState<User[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);

    useEffect(() => {
        let cancelled = false;
        async function load() {
            setLoading(true);
            setError(null);
            try {
                const [a, u, p] = await Promise.all([
                    listActivity(),
                    listAllUsers(),
                    listProjects({ pageSize: 50 }),
                ]);
                if (cancelled) return;
                setEntries(a);
                setUsers(u);
                setProjects(p.items);
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : "Failed to load activity");
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        load();
        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <div className="page" data-testid="activity-page">
            <header className="page-header">
                <div>
                    <h1>Activity</h1>
                    <p className="page-subtitle">Latest events across every project.</p>
                </div>
            </header>

            {error && (
                <div className="alert alert-error" role="alert" data-testid="activity-error">
                    {error}
                </div>
            )}

            {loading ? (
                <p data-testid="activity-loading">Loading activity…</p>
            ) : entries.length === 0 ? (
                <p className="muted" data-testid="activity-empty">
                    No recent activity.
                </p>
            ) : (
                <ol className="activity-feed" data-testid="activity-feed">
                    {entries.map((entry) => {
                        const actor = users.find((u) => u.id === entry.actorId);
                        const project = projects.find((p) => p.id === entry.projectId);
                        return (
                            <li key={entry.id} className="activity-feed-row">
                                <span className="activity-actor">
                                    {actor?.username ?? "someone"}
                                </span>
                                <span className="activity-text">{entry.summary}</span>
                                {project && (
                                    <span className="activity-context">in {project.name}</span>
                                )}
                                <time className="activity-time">
                                    {new Date(entry.timestamp).toLocaleString()}
                                </time>
                            </li>
                        );
                    })}
                </ol>
            )}
        </div>
    );
}
