import { Link } from "react-router-dom";
import Nav from "../Nav";

const RECENT_PROJECTS = [
    { id: "orion-launch", name: "Orion Launch", status: "active" },
    { id: "atlas-migration", name: "Atlas Migration", status: "active" },
    { id: "helix-redesign", name: "Helix Redesign", status: "active" },
];

const ACTIVITY = [
    { text: "Alice created task 'Update API docs'", time: "2 min ago" },
    { text: "Bob closed project 'Legacy Reporting'", time: "1 hr ago" },
    { text: "Carol added member dave@acme.com", time: "3 hr ago" },
    { text: "Orion Launch moved to in-progress", time: "Yesterday" },
];

export default function Dashboard() {
    return (
        <div className="app-shell" data-testid="dashboard-page">
            <Nav />
            <main className="main-content">
                <div className="page-header">
                    <h1>Dashboard</h1>
                    <p>Overview of Acme Corp projects and activity.</p>
                </div>

                <div className="card-grid">
                    <div className="stat-card" data-testid="stat-projects">
                        <div className="stat-label">Total Projects</div>
                        <div className="stat-value">12</div>
                    </div>
                    <div className="stat-card" data-testid="stat-active">
                        <div className="stat-label">Active</div>
                        <div className="stat-value">8</div>
                    </div>
                    <div className="stat-card" data-testid="stat-tasks">
                        <div className="stat-label">Open Tasks</div>
                        <div className="stat-value">34</div>
                    </div>
                    <div className="stat-card" data-testid="stat-members">
                        <div className="stat-label">Members</div>
                        <div className="stat-value">6</div>
                    </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                    <div className="card">
                        <h2 style={{ fontSize: "1rem", marginBottom: "1rem" }}>Recent Projects</h2>
                        <div data-testid="recent-projects" style={{ display: "flex", flexDirection: "column", gap: ".5rem" }}>
                            {RECENT_PROJECTS.map((p) => (
                                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <Link
                                        to={`/projects/${p.id}`}
                                        data-testid={`project-link-${p.id}`}
                                    >
                                        {p.name}
                                    </Link>
                                    <span className={`badge badge-${p.status}`}>{p.status}</span>
                                </div>
                            ))}
                            <Link to="/projects" data-testid="view-all-projects" style={{ fontSize: ".8rem", marginTop: ".5rem" }}>
                                View all projects →
                            </Link>
                        </div>
                    </div>

                    <div className="card">
                        <h2 style={{ fontSize: "1rem", marginBottom: "1rem" }}>Recent Activity</h2>
                        <div className="activity-list" data-testid="recent-activity">
                            {ACTIVITY.map((a, i) => (
                                <div key={i} className="activity-item">
                                    <div className="activity-dot" />
                                    <div>
                                        <div className="activity-text">{a.text}</div>
                                        <div className="activity-time">{a.time}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <Link to="/tasks" data-testid="recent-activity-all" style={{ fontSize: ".8rem", marginTop: ".75rem", display: "block" }}>
                            View all tasks →
                        </Link>
                    </div>
                </div>
            </main>
        </div>
    );
}
