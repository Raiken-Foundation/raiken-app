import { useState } from "react";
import Nav from "../Nav";

const ALL_TASKS = [
    { id: "t_orion_2", title: "Wire production analytics events", project: "Orion Launch", status: "in_progress", priority: "urgent" },
    { id: "t_orion_3", title: "QA sign-off on checkout flow", project: "Orion Launch", status: "todo", priority: "high" },
    { id: "t_atlas_2", title: "Dry-run on staging", project: "Atlas Migration", status: "in_progress", priority: "urgent" },
    { id: "t_atlas_3", title: "Rollback plan", project: "Atlas Migration", status: "todo", priority: "high" },
    { id: "t_helix_2", title: "Component library update", project: "Helix Redesign", status: "in_progress", priority: "high" },
    { id: "t_orion_4", title: "Update landing page copy", project: "Orion Launch", status: "todo", priority: "normal" },
];

export default function Tasks() {
    const [filter, setFilter] = useState("all");

    const visible = ALL_TASKS.filter((t) => filter === "all" || t.status === filter);

    return (
        <div className="app-shell" data-testid="tasks-page">
            <Nav />
            <main className="main-content">
                <div className="page-header">
                    <h1>Tasks</h1>
                    <p>All open tasks across projects.</p>
                </div>

                <div style={{ display: "flex", gap: ".5rem", marginBottom: "1rem" }}>
                    {["all", "todo", "in_progress", "done"].map((s) => (
                        <button
                            key={s}
                            data-testid={`filter-${s.replace("_", "-")}`}
                            onClick={() => setFilter(s)}
                            type="button"
                            style={{
                                padding: ".35rem .75rem", border: "1px solid var(--border)",
                                borderRadius: "var(--radius)", background: filter === s ? "var(--accent)" : "white",
                                color: filter === s ? "white" : "var(--muted)", cursor: "pointer", fontSize: ".8rem",
                            }}
                        >
                            {s}
                        </button>
                    ))}
                </div>

                <div className="card">
                    <table data-testid="task-table">
                        <thead>
                            <tr>
                                <th>Title</th>
                                <th>Project</th>
                                <th>Status</th>
                                <th>Priority</th>
                            </tr>
                        </thead>
                        <tbody>
                            {visible.map((t) => (
                                <tr key={t.id} data-testid={`task-row-${t.id}`}>
                                    <td>{t.title}</td>
                                    <td>{t.project}</td>
                                    <td>
                                        <span className={`badge badge-${t.status === "in_progress" ? "in-progress" : t.status}`}>
                                            {t.status}
                                        </span>
                                    </td>
                                    <td>
                                        <span className={`badge badge-${t.priority === "urgent" ? "urgent" : "todo"}`}>
                                            {t.priority}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </main>
        </div>
    );
}
