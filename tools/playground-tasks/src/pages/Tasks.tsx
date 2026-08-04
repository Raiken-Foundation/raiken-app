import { useState } from "react";
import Nav from "../Nav";

interface Task {
    id: string;
    title: string;
    project: string;
    status: string;
    priority: string;
}

const INITIAL_TASKS: Task[] = [
    {
        id: "t_orion_2",
        title: "Wire production analytics events",
        project: "Orion Launch",
        status: "in_progress",
        priority: "urgent",
    },
    {
        id: "t_orion_3",
        title: "QA sign-off on checkout flow",
        project: "Orion Launch",
        status: "todo",
        priority: "high",
    },
    {
        id: "t_atlas_2",
        title: "Dry-run on staging",
        project: "Atlas Migration",
        status: "in_progress",
        priority: "urgent",
    },
    {
        id: "t_atlas_3",
        title: "Rollback plan",
        project: "Atlas Migration",
        status: "todo",
        priority: "high",
    },
    {
        id: "t_helix_2",
        title: "Component library update",
        project: "Helix Redesign",
        status: "in_progress",
        priority: "high",
    },
    {
        id: "t_orion_4",
        title: "Update landing page copy",
        project: "Orion Launch",
        status: "todo",
        priority: "normal",
    },
];

const PROJECTS = ["Orion Launch", "Atlas Migration", "Helix Redesign"];
const STATUSES = ["todo", "in_progress", "done"];
const PRIORITIES = ["normal", "high", "urgent"];

const STATUS_LABELS: Record<string, string> = {
    todo: "Todo",
    in_progress: "In progress",
    done: "Done",
};

export default function Tasks() {
    const [tasks, setTasks] = useState<Task[]>(INITIAL_TASKS);
    const [filter, setFilter] = useState("all");
    const [showForm, setShowForm] = useState(false);
    const [title, setTitle] = useState("");
    const [project, setProject] = useState(PROJECTS[0]);
    const [status, setStatus] = useState("todo");
    const [priority, setPriority] = useState("normal");
    const [error, setError] = useState<string | null>(null);

    const visible = tasks.filter((t) => filter === "all" || t.status === filter);

    function handleAdd(event: React.FormEvent) {
        event.preventDefault();
        if (!title.trim()) {
            setError("Title is required.");
            return;
        }
        const task: Task = {
            id: `t_new_${Date.now()}`,
            title: title.trim(),
            project,
            status,
            priority,
        };
        setTasks((current) => [...current, task]);
        setTitle("");
        setShowForm(false);
        setError(null);
    }

    return (
        <div className="app-shell" data-testid="tasks-page">
            <Nav />
            <main className="main-content">
                <div className="page-header">
                    <h1>Tasks</h1>
                    <p>All open tasks across projects.</p>
                    <button
                        type="button"
                        className="btn-primary"
                        data-testid="new-task-button"
                        onClick={() => setShowForm((open) => !open)}
                    >
                        {showForm ? "Cancel" : "New task"}
                    </button>
                </div>

                {showForm && (
                    <form
                        className="card task-form"
                        data-testid="new-task-form"
                        onSubmit={handleAdd}
                    >
                        <div className="form-row">
                            <label htmlFor="task-title">Title</label>
                            <input
                                id="task-title"
                                type="text"
                                data-testid="task-title-input"
                                value={title}
                                onChange={(event) => setTitle(event.target.value)}
                            />
                        </div>
                        <div className="form-row">
                            <label htmlFor="task-project">Project</label>
                            <select
                                id="task-project"
                                data-testid="task-project-select"
                                value={project}
                                onChange={(event) => setProject(event.target.value)}
                            >
                                {PROJECTS.map((candidate) => (
                                    <option key={candidate} value={candidate}>
                                        {candidate}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="form-row">
                            <label htmlFor="task-status">Status</label>
                            <select
                                id="task-status"
                                data-testid="task-status-select"
                                value={status}
                                onChange={(event) => setStatus(event.target.value)}
                            >
                                {STATUSES.map((candidate) => (
                                    <option key={candidate} value={candidate}>
                                        {STATUS_LABELS[candidate]}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="form-row">
                            <label htmlFor="task-priority">Priority</label>
                            <select
                                id="task-priority"
                                data-testid="task-priority-select"
                                value={priority}
                                onChange={(event) => setPriority(event.target.value)}
                            >
                                {PRIORITIES.map((candidate) => (
                                    <option key={candidate} value={candidate}>
                                        {candidate}
                                    </option>
                                ))}
                            </select>
                        </div>
                        {error && (
                            <p className="form-error" data-testid="task-form-error">
                                {error}
                            </p>
                        )}
                        <button type="submit" className="btn-primary" data-testid="task-submit">
                            Add task
                        </button>
                    </form>
                )}

                <div style={{ display: "flex", gap: ".5rem", marginBottom: "1rem" }}>
                    {["all", ...STATUSES].map((s) => (
                        <button
                            key={s}
                            data-testid={`filter-${s.replace("_", "-")}`}
                            onClick={() => setFilter(s)}
                            type="button"
                            style={{
                                padding: ".35rem .75rem",
                                border: "1px solid var(--border)",
                                borderRadius: "var(--radius)",
                                background: filter === s ? "var(--accent)" : "white",
                                color: filter === s ? "white" : "var(--muted)",
                                cursor: "pointer",
                                fontSize: ".8rem",
                            }}
                        >
                            {s === "all" ? "All" : STATUS_LABELS[s]}
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
                                        <span
                                            className={`badge badge-${t.status === "in_progress" ? "in-progress" : t.status}`}
                                        >
                                            {STATUS_LABELS[t.status] ?? t.status}
                                        </span>
                                    </td>
                                    <td>
                                        <span
                                            className={`badge badge-${t.priority === "urgent" ? "urgent" : "todo"}`}
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
