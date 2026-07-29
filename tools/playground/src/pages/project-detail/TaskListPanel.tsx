import { useId, useMemo, useState } from "react";
import { PriorityPill, TaskStatusPill } from "../../components/StatusPill";
import { useAuth } from "../../contexts/AuthContext";
import type { Project, Task, TaskStatus, User } from "../../types";
import TaskDetailsModal from "./TaskDetailsModal";
import TaskFormModal from "./TaskFormModal";

interface Props {
    project: Project;
    tasks: Task[];
    members: User[];
    onCreated: () => Promise<void> | void;
    onActivityChanged: () => Promise<void> | void;
    onStatusChange: (taskId: string, status: TaskStatus) => Promise<void>;
    onDelete: (taskId: string) => Promise<void>;
}

const STATUS_ORDER: TaskStatus[] = ["todo", "in_progress", "review", "done"];

export default function TaskListPanel({
    project,
    tasks,
    members,
    onCreated,
    onActivityChanged,
    onStatusChange,
    onDelete,
}: Props) {
    const { isAdmin } = useAuth();
    const [showCreate, setShowCreate] = useState(false);
    const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
    const [search, setSearch] = useState("");
    const [selectedTask, setSelectedTask] = useState<Task | null>(null);
    const searchId = useId();
    const filterId = useId();

    const filtered = useMemo(() => {
        return tasks
            .filter((t) => (statusFilter === "all" ? true : t.status === statusFilter))
            .filter((t) =>
                search.trim()
                    ? t.title.toLowerCase().includes(search.toLowerCase()) ||
                      t.description.toLowerCase().includes(search.toLowerCase())
                    : true,
            );
    }, [tasks, statusFilter, search]);

    return (
        <div className="task-panel" data-testid="task-panel">
            <div className="task-toolbar">
                <div className="toolbar-field">
                    <label htmlFor={searchId}>Search</label>
                    <input
                        id={searchId}
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Find a task"
                        data-testid="task-search"
                    />
                </div>
                <div className="toolbar-field">
                    <label htmlFor={filterId}>Status</label>
                    <select
                        id={filterId}
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value as TaskStatus | "all")}
                        data-testid="task-status-filter"
                    >
                        <option value="all">All</option>
                        {STATUS_ORDER.map((s) => (
                            <option key={s} value={s}>
                                {s.replace("_", " ")}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="task-toolbar-actions">
                    {project.status !== "archived" && (
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => setShowCreate(true)}
                            data-testid="open-create-task"
                        >
                            + New task
                        </button>
                    )}
                </div>
            </div>

            {project.status === "archived" && (
                <div className="alert alert-info" data-testid="project-readonly">
                    This project is archived. Tasks and comments are read-only.
                </div>
            )}

            {filtered.length === 0 ? (
                <div className="empty-state" data-testid="tasks-empty">
                    No tasks match these filters.
                </div>
            ) : (
                <ul className="task-table" data-testid="task-table">
                    {filtered.map((task) => {
                        const assignee = members.find((m) => m.id === task.assigneeId);
                        return (
                            <li
                                key={task.id}
                                className="task-row"
                                data-testid={`task-row-${task.id}`}
                            >
                                <div className="task-row-main">
                                    <div className="task-row-title">
                                        <button
                                            type="button"
                                            className="task-title-button"
                                            onClick={() => setSelectedTask(task)}
                                            data-testid={`task-title-${task.id}`}
                                        >
                                            {task.title}
                                        </button>
                                        <PriorityPill priority={task.priority} />
                                    </div>
                                    {task.description && (
                                        <p className="task-row-desc">{task.description}</p>
                                    )}
                                    <div className="task-row-meta">
                                        <TaskStatusPill status={task.status} />
                                        <span>
                                            {assignee
                                                ? `Assigned to ${assignee.username}`
                                                : "Unassigned"}
                                        </span>
                                        {task.dueDate && (
                                            <span>
                                                Due {new Date(task.dueDate).toLocaleDateString()}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <div className="task-row-actions">
                                    <label
                                        className="visually-hidden"
                                        htmlFor={`status-${task.id}`}
                                    >
                                        Change status
                                    </label>
                                    <select
                                        id={`status-${task.id}`}
                                        value={task.status}
                                        onChange={(e) =>
                                            onStatusChange(task.id, e.target.value as TaskStatus)
                                        }
                                        disabled={project.status === "archived"}
                                        data-testid={`status-select-${task.id}`}
                                    >
                                        {STATUS_ORDER.map((s) => (
                                            <option key={s} value={s}>
                                                {s.replace("_", " ")}
                                            </option>
                                        ))}
                                    </select>
                                    {isAdmin && project.status !== "archived" && (
                                        <button
                                            type="button"
                                            className="btn btn-ghost btn-sm"
                                            onClick={() => onDelete(task.id)}
                                            data-testid={`delete-task-${task.id}`}
                                        >
                                            Delete
                                        </button>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            {showCreate && (
                <TaskFormModal
                    project={project}
                    members={members}
                    onClose={() => setShowCreate(false)}
                    onCreated={async () => {
                        setShowCreate(false);
                        await onCreated();
                    }}
                />
            )}
            {selectedTask && (
                <TaskDetailsModal
                    task={selectedTask}
                    members={members}
                    readOnly={project.status === "archived"}
                    onClose={() => setSelectedTask(null)}
                    onCommentAdded={onActivityChanged}
                />
            )}
        </div>
    );
}
