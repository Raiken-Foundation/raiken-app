import { Link, useParams } from "react-router-dom";
import Nav from "../Nav";

const PROJECT_DATA: Record<
    string,
    {
        name: string;
        description: string;
        tasks: { id: string; title: string; status: string; priority: string }[];
    }
> = {
    "orion-launch": {
        name: "Orion Launch",
        description: "Q2 product launch campaign across all channels.",
        tasks: [
            { id: "t_orion_1", title: "Write press release", status: "done", priority: "high" },
            {
                id: "t_orion_2",
                title: "Wire production analytics events",
                status: "in_progress",
                priority: "urgent",
            },
            {
                id: "t_orion_3",
                title: "QA sign-off on checkout flow",
                status: "todo",
                priority: "high",
            },
            {
                id: "t_orion_4",
                title: "Update landing page copy",
                status: "todo",
                priority: "normal",
            },
        ],
    },
    "atlas-migration": {
        name: "Atlas Migration",
        description: "Database migration from Postgres 13 to Aurora.",
        tasks: [
            { id: "t_atlas_1", title: "Schema diff review", status: "done", priority: "high" },
            {
                id: "t_atlas_2",
                title: "Dry-run on staging",
                status: "in_progress",
                priority: "urgent",
            },
            { id: "t_atlas_3", title: "Rollback plan", status: "todo", priority: "high" },
        ],
    },
    "helix-redesign": {
        name: "Helix Redesign",
        description: "Full visual refresh of the customer-facing portal.",
        tasks: [
            { id: "t_helix_1", title: "Design token audit", status: "done", priority: "normal" },
            {
                id: "t_helix_2",
                title: "Component library update",
                status: "in_progress",
                priority: "high",
            },
        ],
    },
};

export default function ProjectDetail() {
    const { id = "" } = useParams<{ id: string }>();
    const project = PROJECT_DATA[id];

    if (!project) {
        return (
            <div className="app-shell">
                <Nav />
                <main className="main-content">
                    <p>
                        Project not found. <Link to="/projects">Back to projects</Link>
                    </p>
                </main>
            </div>
        );
    }

    return (
        <div className="app-shell" data-testid="project-detail-page">
            <Nav />
            <main className="main-content">
                <div className="page-header">
                    <div
                        style={{ fontSize: ".8rem", color: "var(--muted)", marginBottom: ".25rem" }}
                    >
                        <Link to="/projects">Projects</Link> / {project.name}
                    </div>
                    <h1>{project.name}</h1>
                    <p>{project.description}</p>
                </div>

                <div className="card">
                    <div
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: "1rem",
                        }}
                    >
                        <h2 style={{ fontSize: "1rem" }}>Tasks</h2>
                        <button
                            data-testid="open-create-task"
                            className="btn-primary"
                            style={{ width: "auto", padding: ".35rem .875rem", fontSize: ".8rem" }}
                            type="button"
                        >
                            Add task
                        </button>
                    </div>
                    <table data-testid="task-table">
                        <thead>
                            <tr>
                                <th>Title</th>
                                <th>Status</th>
                                <th>Priority</th>
                            </tr>
                        </thead>
                        <tbody>
                            {project.tasks.map((t) => (
                                <tr key={t.id} data-testid={`task-row-${t.id}`}>
                                    <td>{t.title}</td>
                                    <td>
                                        <select
                                            data-testid={`status-select-${t.id}`}
                                            defaultValue={t.status}
                                            style={{
                                                fontSize: ".8rem",
                                                border: "1px solid var(--border)",
                                                borderRadius: "var(--radius)",
                                                padding: ".2rem .4rem",
                                            }}
                                        >
                                            <option value="todo">todo</option>
                                            <option value="in_progress">in_progress</option>
                                            <option value="done">done</option>
                                        </select>
                                    </td>
                                    <td>
                                        <span
                                            className={`badge badge-${t.priority === "urgent" ? "urgent" : t.priority === "high" ? "in-progress" : "todo"}`}
                                        >
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
