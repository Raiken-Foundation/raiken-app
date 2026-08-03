import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../api";
import type { ActivityEntry, Project, ProjectStats } from "../types";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { Avatar } from "../components/Avatar";
import { useAuth } from "../contexts/AuthContext";

export function DashboardPage() {
    const { user } = useAuth();
    const [stats, setStats] = useState<ProjectStats | null>(null);
    const [recentProjects, setRecentProjects] = useState<Project[]>([]);
    const [activity, setActivity] = useState<ActivityEntry[]>([]);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [statsResult, projects, entries] = await Promise.all([
                api.getStats(),
                api.listProjects(),
                api.listActivity(),
            ]);
            if (cancelled) return;
            setStats(statsResult);
            setRecentProjects(
                [...projects]
                    .filter((p) => p.status !== "archived")
                    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                    .slice(0, 4),
            );
            setActivity(entries.slice(0, 6));
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    if (!stats) {
        return (
            <main className="page">
                <Skeleton lines={6} />
            </main>
        );
    }

    return (
        <main className="page" data-testid="dashboard-page">
            <header className="page-header">
                <h1>Dashboard</h1>
                <p className="muted">Welcome back, {user?.displayName}.</p>
            </header>

            <section className="stat-grid" data-testid="stat-grid">
                <div className="stat" data-testid="stat-projects">
                    <span className="stat-value">{stats.projects}</span>
                    <span className="stat-label">Projects</span>
                </div>
                <div className="stat" data-testid="stat-active">
                    <span className="stat-value">{stats.activeProjects}</span>
                    <span className="stat-label">Active</span>
                </div>
                <div className="stat" data-testid="stat-open">
                    <span className="stat-value">{stats.openTasks}</span>
                    <span className="stat-label">Open tasks</span>
                </div>
                <div className="stat" data-testid="stat-stale">
                    <span className="stat-value">{stats.overdueTasks}</span>
                    <span className="stat-label">Stale open tasks</span>
                </div>
            </section>

            <div className="dashboard-grid">
                <section className="card" data-testid="recent-projects">
                    <header className="card-header">
                        <h2>Recently updated</h2>
                        <Link to="/projects" className="link" data-testid="recent-projects-all">
                            All projects
                        </Link>
                    </header>
                    {recentProjects.length === 0 ? (
                        <EmptyState title="No projects yet" hint="Create one to get started." />
                    ) : (
                        <ul className="project-list">
                            {recentProjects.map((project) => (
                                <li key={project.id}>
                                    <Link to={`/projects/${project.slug}`} className="project-row">
                                        <span className="project-row-name">{project.name}</span>
                                        <span className="muted">{project.status}</span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <section className="card" data-testid="recent-activity">
                    <header className="card-header">
                        <h2>Recent activity</h2>
                    </header>
                    {activity.length === 0 ? (
                        <EmptyState title="No activity yet" />
                    ) : (
                        <ul className="activity-list">
                            {activity.map((entry) => (
                                <li key={entry.id} className="activity-row">
                                    <Avatar name={entry.actorId} size="sm" />
                                    <span>{entry.message}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>
        </main>
    );
}
