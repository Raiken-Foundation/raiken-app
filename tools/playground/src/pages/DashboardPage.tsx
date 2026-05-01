import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listActivity, listProjects, listTasks } from "../api";
import { PriorityPill, ProjectStatusPill, TaskStatusPill } from "../components/StatusPill";
import { useAuth } from "../contexts/AuthContext";
import type { ActivityEntry, Project, Task } from "../types";

interface Stats {
    projects: number;
    activeProjects: number;
    openTasks: number;
    urgentTasks: number;
}

export default function DashboardPage() {
    const { user } = useAuth();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [stats, setStats] = useState<Stats>({
        projects: 0,
        activeProjects: 0,
        openTasks: 0,
        urgentTasks: 0,
    });
    const [recentProjects, setRecentProjects] = useState<Project[]>([]);
    const [myTasks, setMyTasks] = useState<Task[]>([]);
    const [activity, setActivity] = useState<ActivityEntry[]>([]);

    useEffect(() => {
        let cancelled = false;
        async function load() {
            setLoading(true);
            setError(null);
            try {
                const [projectsPage, recent] = await Promise.all([
                    listProjects({ pageSize: 50 }),
                    listProjects({ pageSize: 4, sort: "updated", direction: "desc" }),
                ]);
                const allTasksPerProject = await Promise.all(
                    projectsPage.items.map((p) => listTasks({ projectId: p.id })),
                );
                const allTasks = allTasksPerProject.flat();
                const myOpen = user
                    ? allTasks.filter((t) => t.assigneeId === user.id && t.status !== "done")
                    : [];
                const recentActivity = await listActivity();

                if (cancelled) return;
                setStats({
                    projects: projectsPage.total,
                    activeProjects: projectsPage.items.filter((p) => p.status === "active").length,
                    openTasks: allTasks.filter((t) => t.status !== "done").length,
                    urgentTasks: allTasks.filter(
                        (t) => t.priority === "urgent" && t.status !== "done",
                    ).length,
                });
                setRecentProjects(recent.items);
                setMyTasks(myOpen.slice(0, 6));
                setActivity(recentActivity.slice(0, 6));
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : "Failed to load dashboard");
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        load();
        return () => {
            cancelled = true;
        };
    }, [user]);

    return (
        <div className="page" data-testid="dashboard-page">
            <header className="page-header">
                <div>
                    <h1>Dashboard</h1>
                    <p className="page-subtitle">
                        {user ? `Welcome back, ${user.username}.` : "Welcome to the Atlas Tracker."}
                    </p>
                </div>
                <Link
                    to="/projects"
                    className="btn btn-primary"
                    data-testid="dashboard-go-projects"
                >
                    Browse projects →
                </Link>
            </header>

            {error && (
                <div className="alert alert-error" role="alert" data-testid="dashboard-error">
                    {error}
                </div>
            )}

            <section className="stat-grid" data-testid="stat-grid">
                <Stat
                    label="Total projects"
                    value={stats.projects}
                    loading={loading}
                    testId="stat-projects"
                />
                <Stat
                    label="Active"
                    value={stats.activeProjects}
                    loading={loading}
                    testId="stat-active"
                />
                <Stat
                    label="Open tasks"
                    value={stats.openTasks}
                    loading={loading}
                    testId="stat-open"
                />
                <Stat
                    label="Urgent open"
                    value={stats.urgentTasks}
                    loading={loading}
                    tone={stats.urgentTasks > 0 ? "danger" : "default"}
                    testId="stat-urgent"
                />
            </section>

            <div className="dashboard-grid">
                <section className="card" data-testid="recent-projects">
                    <header className="card-header">
                        <h3>Recently updated projects</h3>
                        <Link to="/projects" className="link" data-testid="recent-projects-all">
                            All projects
                        </Link>
                    </header>
                    {loading ? (
                        <Skeleton rows={4} />
                    ) : recentProjects.length === 0 ? (
                        <p className="muted">No projects yet.</p>
                    ) : (
                        <ul className="card-list">
                            {recentProjects.map((p) => (
                                <li key={p.id}>
                                    <Link
                                        to={`/projects/${p.slug}`}
                                        className="card-list-item"
                                        data-testid={`project-link-${p.slug}`}
                                    >
                                        <span className="card-list-title">{p.name}</span>
                                        <ProjectStatusPill status={p.status} />
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <section className="card" data-testid="my-tasks">
                    <header className="card-header">
                        <h3>Your open tasks</h3>
                    </header>
                    {loading ? (
                        <Skeleton rows={4} />
                    ) : myTasks.length === 0 ? (
                        <p className="muted">
                            Nothing assigned to you. Pick something up from a project.
                        </p>
                    ) : (
                        <ul className="card-list">
                            {myTasks.map((t) => (
                                <li
                                    key={t.id}
                                    className="task-item"
                                    data-testid={`my-task-${t.id}`}
                                >
                                    <div className="task-item-main">
                                        <span className="task-item-title">{t.title}</span>
                                        <span className="task-item-meta">
                                            <TaskStatusPill status={t.status} />
                                            <PriorityPill priority={t.priority} />
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <section className="card card-wide" data-testid="recent-activity">
                    <header className="card-header">
                        <h3>Recent activity</h3>
                        <Link to="/activity" className="link" data-testid="recent-activity-all">
                            View all
                        </Link>
                    </header>
                    {loading ? (
                        <Skeleton rows={5} />
                    ) : activity.length === 0 ? (
                        <p className="muted">Nothing happening yet.</p>
                    ) : (
                        <ul className="activity-list">
                            {activity.map((entry) => (
                                <li key={entry.id} className="activity-row">
                                    <span className="activity-time">
                                        {formatRelative(entry.timestamp)}
                                    </span>
                                    <span className="activity-text">{entry.summary}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>
        </div>
    );
}

function Stat({
    label,
    value,
    loading,
    tone = "default",
    testId,
}: {
    label: string;
    value: number;
    loading: boolean;
    tone?: "default" | "danger";
    testId: string;
}) {
    return (
        <div className={`stat-card stat-${tone}`} data-testid={testId}>
            <span className="stat-label">{label}</span>
            <span className="stat-value">{loading ? "—" : value.toLocaleString()}</span>
        </div>
    );
}

function Skeleton({ rows }: { rows: number }) {
    return (
        <div className="skeleton" data-testid="skeleton">
            {Array.from({ length: rows }, (_, i) => `skeleton-${i}`).map((key) => (
                <span key={key} className="skeleton-row" />
            ))}
        </div>
    );
}

function formatRelative(iso: string): string {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diff = Math.max(0, now - then);
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
}
