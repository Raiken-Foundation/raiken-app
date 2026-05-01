import type { Project, Task, User } from "../../types";

interface Props {
    project: Project;
    tasks: Task[];
    members: User[];
}

export default function OverviewPanel({ project, tasks, members }: Props) {
    const owner = members.find((m) => m.id === project.ownerId);
    const open = tasks.filter((t) => t.status !== "done").length;
    const inProgress = tasks.filter((t) => t.status === "in_progress").length;
    const review = tasks.filter((t) => t.status === "review").length;
    const done = tasks.filter((t) => t.status === "done").length;
    const urgent = tasks.filter((t) => t.priority === "urgent" && t.status !== "done").length;

    return (
        <div className="overview-panel" data-testid="overview-panel">
            <section className="card" data-testid="overview-summary">
                <h3>Summary</h3>
                <dl className="definition-list">
                    <div>
                        <dt>Owner</dt>
                        <dd data-testid="overview-owner">{owner?.username ?? "—"}</dd>
                    </div>
                    <div>
                        <dt>Members</dt>
                        <dd data-testid="overview-member-count">{members.length}</dd>
                    </div>
                    <div>
                        <dt>Created</dt>
                        <dd>{new Date(project.createdAt).toLocaleDateString()}</dd>
                    </div>
                    <div>
                        <dt>Last update</dt>
                        <dd>{new Date(project.updatedAt).toLocaleDateString()}</dd>
                    </div>
                </dl>
            </section>

            <section className="card" data-testid="overview-tasks">
                <h3>Task breakdown</h3>
                <ul className="metric-list">
                    <li>
                        <span>Open</span>
                        <strong data-testid="metric-open">{open}</strong>
                    </li>
                    <li>
                        <span>In progress</span>
                        <strong data-testid="metric-in-progress">{inProgress}</strong>
                    </li>
                    <li>
                        <span>Review</span>
                        <strong data-testid="metric-review">{review}</strong>
                    </li>
                    <li>
                        <span>Done</span>
                        <strong data-testid="metric-done">{done}</strong>
                    </li>
                    <li className="metric-danger">
                        <span>Urgent open</span>
                        <strong data-testid="metric-urgent">{urgent}</strong>
                    </li>
                </ul>
            </section>
        </div>
    );
}
