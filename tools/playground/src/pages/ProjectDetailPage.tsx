import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import * as api from "../api";
import type { ActivityEntry, Comment, Project, Task, TaskPriority, User } from "../types";
import { Tabs } from "../components/Tabs";
import { StatusPill, PriorityBadge } from "../components/StatusPill";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { FormField } from "../components/FormField";
import { Avatar } from "../components/Avatar";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";

type TabId = "overview" | "tasks" | "activity";

export function ProjectDetailPage() {
    const { slug = "" } = useParams();
    const { user, can } = useAuth();
    const { push } = useToast();
    const [project, setProject] = useState<Project | null>(null);
    const [tasks, setTasks] = useState<Task[] | null>(null);
    const [members, setMembers] = useState<User[]>([]);
    const [activity, setActivity] = useState<ActivityEntry[]>([]);
    const [commentsByTask, setCommentsByTask] = useState<Record<string, Comment[]>>({});
    const [tab, setTab] = useState<TabId>(
        () => (new URLSearchParams(window.location.search).get("tab") as TabId) || "overview",
    );
    const [creating, setCreating] = useState(false);
    const [archiving, setArchiving] = useState(false);
    const [expandedTask, setExpandedTask] = useState<Task | null>(null);
    const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});

    const reload = useCallback(async () => {
        const found = await api.getProject(slug);
        if (!found) return;
        setProject(found);
        const [taskList, users, entries] = await Promise.all([
            api.listTasks(found.slug),
            api.listUsers(),
            api.listActivity(),
        ]);
        setTasks(taskList);
        setMembers(users.filter((u) => found.teamIds.includes(u.id)));
        setActivity(entries.filter((e) => e.projectId === found.id));
    }, [slug]);

    useEffect(() => {
        setProject(null);
        setTasks(null);
        void reload();
    }, [reload]);

    useEffect(() => {
        if (!expandedTask) return;
        void api.listComments(expandedTask.id).then((comments) => {
            setCommentsByTask((current) => ({ ...current, [expandedTask.id]: comments }));
        });
    }, [expandedTask]);

    const changeTab = (next: string) => {
        setTab(next as TabId);
        const url = new URL(window.location.href);
        if (next === "overview") url.searchParams.delete("tab");
        else url.searchParams.set("tab", next);
        window.history.replaceState(null, "", url.toString());
    };

    const taskCounts = useMemo(() => {
        if (!tasks) return { todo: 0, in_progress: 0, review: 0, done: 0 };
        return {
            todo: tasks.filter((t) => t.status === "todo").length,
            in_progress: tasks.filter((t) => t.status === "in_progress").length,
            review: tasks.filter((t) => t.status === "review").length,
            done: tasks.filter((t) => t.status === "done").length,
        };
    }, [tasks]);

    const openTask = (task: Task) => {
        setExpandedTask(task);
    };

    const handleStatusChange = async (task: Task, status: Task["status"]) => {
        try {
            const updated = await api.updateTaskStatus(task.id, status, user!);
            setTasks((current) =>
                (current ?? []).map((t) => (t.id === task.id ? updated : t)),
            );
            push("success", `Moved "${task.title}" to ${api.statusLabel(status)}`);
        } catch (err) {
            push("error", err instanceof Error ? err.message : "Could not update the task.");
        }
    };

    const handleAssigneeChange = async (task: Task, assigneeId: string) => {
        try {
            const updated = await api.updateTaskAssignee(task.id, assigneeId || null, user!);
            setTasks((current) =>
                (current ?? []).map((t) => (t.id === task.id ? updated : t)),
            );
            push("success", "Assignee updated");
        } catch (err) {
            push("error", err instanceof Error ? err.message : "Could not update the assignee.");
        }
    };

    const handleArchive = async () => {
        if (!project) return;
        try {
            await api.archiveProject(project.slug, user!);
            push("success", `Archived ${project.name}`);
            await reload();
            setArchiving(false);
        } catch (err) {
            push("error", err instanceof Error ? err.message : "Could not archive the project.");
            setArchiving(false);
        }
    };

    const handleAddComment = async (taskId: string) => {
        const body = (commentDrafts[taskId] ?? "").trim();
        if (!body) return;
        try {
            const comment = await api.addComment({ taskId, body, actor: user! });
            setCommentsByTask((current) => ({
                ...current,
                [taskId]: [...(current[taskId] ?? []), comment],
            }));
            setCommentDrafts((current) => ({ ...current, [taskId]: "" }));
            push("success", "Comment added");
        } catch (err) {
            push("error", err instanceof Error ? err.message : "Could not add the comment.");
        }
    };

    if (!project || !tasks) {
        return (
            <main className="page">
                <Skeleton lines={6} />
            </main>
        );
    }

    return (
        <main className="page" data-testid="project-detail-page">
            <header className="page-header">
                <div>
                    <Link to="/projects" className="link">
                        ← Projects
                    </Link>
                    <h1 data-testid="project-name">{project.name}</h1>
                    <p className="muted" data-testid="project-description">
                        {project.description}
                    </p>
                </div>
                <div className="page-header-actions">
                    {can("manage") && project.status !== "archived" ? (
                        <button
                            type="button"
                            className="button button-danger-outline"
                            data-testid="archive-project"
                            onClick={() => setArchiving(true)}
                        >
                            Archive project
                        </button>
                    ) : null}
                </div>
            </header>

            <Tabs
                tabs={[
                    { id: "overview", label: "Overview" },
                    { id: "tasks", label: "Tasks", badge: tasks.length },
                    { id: "activity", label: "Activity", badge: activity.length },
                ]}
                active={tab}
                onChange={changeTab}
            />

            {tab === "overview" ? (
                <section className="card" data-testid="overview-panel">
                    <h2>About this project</h2>
                    <p>{project.description}</p>
                    <h3>Team ({members.length})</h3>
                    <ul className="member-list" data-testid="member-list">
                        {members.map((member) => (
                            <li key={member.id} className="member-row">
                                <Avatar name={member.displayName} size="sm" />
                                <span>{member.displayName}</span>
                                <span className="muted">({member.role})</span>
                            </li>
                        ))}
                    </ul>
                    <div className="task-summary">
                        <span data-testid="count-todo">{taskCounts.todo} to do</span>
                        <span data-testid="count-in-progress">
                            {taskCounts.in_progress} in progress
                        </span>
                        <span data-testid="count-review">{taskCounts.review} in review</span>
                        <span data-testid="count-done">{taskCounts.done} done</span>
                    </div>
                </section>
            ) : null}

            {tab === "tasks" ? (
                <section data-testid="tasks-panel">
                    <div className="toolbar">
                        <h2 className="toolbar-title">Tasks</h2>
                        {can("write") ? (
                            <button
                                type="button"
                                className="button button-primary"
                                data-testid="create-task"
                                onClick={() => setCreating(true)}
                            >
                                New task
                            </button>
                        ) : null}
                    </div>
                    {tasks.length === 0 ? (
                        <EmptyState
                            title="No tasks yet"
                            hint="Create the first task to get the board moving."
                        />
                    ) : (
                        <ul className="task-list" data-testid="task-list">
                            {tasks.map((task) => (
                                <li
                                    key={task.id}
                                    className="card task-row"
                                    data-testid={`task-row-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                                >
                                    <button
                                        type="button"
                                        className="task-row-main"
                                        data-testid={`task-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                                        onClick={() => openTask(task)}
                                    >
                                        <span className="task-row-title">{task.title}</span>
                                        <span className="muted task-row-description">
                                            {task.description}
                                        </span>
                                    </button>
                                    <div className="task-row-side">
                                        <PriorityBadge priority={task.priority} />
                                        <StatusPill status={task.status} />
                                        {can("write") ? (
                                            <select
                                                className="input select-sm"
                                                aria-label={`Status for ${task.title}`}
                                                value={task.status}
                                                data-testid={`status-${task.id}`}
                                                onChange={(event) =>
                                                    void handleStatusChange(
                                                        task,
                                                        event.target.value as Task["status"],
                                                    )
                                                }
                                            >
                                                <option value="todo">To do</option>
                                                <option value="in_progress">In progress</option>
                                                <option value="review">In review</option>
                                                <option value="done">Done</option>
                                            </select>
                                        ) : null}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            ) : null}

            {tab === "activity" ? (
                <section className="card" data-testid="activity-panel">
                    <h2>Activity</h2>
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
            ) : null}

            {creating ? (
                <TaskFormModal
                    project={project}
                    members={members}
                    onClose={() => setCreating(false)}
                    onCreated={async (task) => {
                        setTasks((current) => [...(current ?? []), task]);
                        push("success", `Created task "${task.title}"`);
                        setCreating(false);
                        await reload();
                    }}
                />
            ) : null}

            {expandedTask ? (
                <TaskDetailModal
                    task={expandedTask}
                    members={members}
                    comments={commentsByTask[expandedTask.id] ?? []}
                    canWrite={can("write")}
                    canManage={can("manage")}
                    commentDraft={commentDrafts[expandedTask.id] ?? ""}
                    onDraftChange={(value) =>
                        setCommentDrafts((current) => ({
                            ...current,
                            [expandedTask.id]: value,
                        }))
                    }
                    onAddComment={() => void handleAddComment(expandedTask.id)}
                    onStatusChange={(status) => void handleStatusChange(expandedTask, status)}
                    onAssigneeChange={(assigneeId) =>
                        void handleAssigneeChange(expandedTask, assigneeId)
                    }
                    onClose={() => setExpandedTask(null)}
                />
            ) : null}

            {archiving ? (
                <ConfirmDialog
                    title={`Archive ${project.name}?`}
                    body="Archived projects disappear from the active list but keep their history."
                    confirmLabel="Archive project"
                    onConfirm={() => void handleArchive()}
                    onCancel={() => setArchiving(false)}
                />
            ) : null}
        </main>
    );
}

// ---------------------------------------------------------------------------
// Task form / detail modals
// ---------------------------------------------------------------------------

function TaskFormModal({
    project,
    members,
    onClose,
    onCreated,
}: {
    project: Project;
    members: User[];
    onClose: () => void;
    onCreated: (task: Task) => void;
}) {
    const { user } = useAuth();
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [priority, setPriority] = useState<TaskPriority>("medium");
    const [assigneeId, setAssigneeId] = useState<string>(user?.id ?? "");
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async () => {
        setError(null);
        if (!title.trim()) {
            setError("Task title is required.");
            return;
        }
        if (title.trim().length < 4) {
            setError("Task title must be at least 4 characters.");
            return;
        }
        try {
            const task = await api.createTask({
                projectSlug: project.slug,
                title: title.trim(),
                description: description.trim(),
                priority,
                assigneeId: assigneeId || null,
                actor: user!,
            });
            onCreated(task);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not create the task.");
        }
    };

    return (
        <Modal
            title={`New task in ${project.name}`}
            onClose={onClose}
            footer={
                <>
                    <button type="button" className="button button-ghost" onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="button button-primary"
                        data-testid="create-task-submit"
                        onClick={() => void handleSubmit()}
                    >
                        Create task
                    </button>
                </>
            }
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void handleSubmit();
                }}
            >
                <FormField label="Title" htmlFor="task-title-input" error={error}>
                    <input
                        id="task-title-input"
                        className="input"
                        type="text"
                        value={title}
                        data-testid="task-title-input"
                        onChange={(event) => setTitle(event.target.value)}
                    />
                </FormField>
                <FormField label="Description" htmlFor="task-description-input">
                    <textarea
                        id="task-description-input"
                        className="input"
                        rows={3}
                        value={description}
                        data-testid="task-description-input"
                        onChange={(event) => setDescription(event.target.value)}
                    />
                </FormField>
                <div className="form-row">
                    <FormField label="Priority" htmlFor="task-priority-input">
                        <select
                            id="task-priority-input"
                            className="input"
                            value={priority}
                            data-testid="task-priority-input"
                            onChange={(event) =>
                                setPriority(event.target.value as TaskPriority)
                            }
                        >
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                            <option value="urgent">Urgent</option>
                        </select>
                    </FormField>
                    <FormField label="Assignee" htmlFor="task-assignee-input">
                        <select
                            id="task-assignee-input"
                            className="input"
                            value={assigneeId}
                            data-testid="task-assignee-input"
                            onChange={(event) => setAssigneeId(event.target.value)}
                        >
                            <option value="">Unassigned</option>
                            {members.map((member) => (
                                <option key={member.id} value={member.id}>
                                    {member.displayName}
                                </option>
                            ))}
                        </select>
                    </FormField>
                </div>
            </form>
        </Modal>
    );
}

function TaskDetailModal({
    task,
    members,
    comments,
    canWrite,
    commentDraft,
    onDraftChange,
    onAddComment,
    onStatusChange,
    onAssigneeChange,
    onClose,
}: {
    task: Task;
    members: User[];
    comments: Comment[];
    canWrite: boolean;
    canManage: boolean;
    commentDraft: string;
    onDraftChange: (value: string) => void;
    onAddComment: () => void;
    onStatusChange: (status: Task["status"]) => void;
    onAssigneeChange: (assigneeId: string) => void;
    onClose: () => void;
}) {
    return (
        <Modal
            title={task.title}
            onClose={onClose}
            footer={
                <button type="button" className="button button-ghost" onClick={onClose}>
                    Close
                </button>
            }
        >
            <p className="muted">{task.description || "No description."}</p>
            <div className="form-row">
                {canWrite ? (
                    <FormField label="Status" htmlFor="task-detail-status">
                        <select
                            id="task-detail-status"
                            className="input"
                            value={task.status}
                            data-testid="task-detail-status"
                            onChange={(event) =>
                                onStatusChange(event.target.value as Task["status"])
                            }
                        >
                            <option value="todo">To do</option>
                            <option value="in_progress">In progress</option>
                            <option value="review">In review</option>
                            <option value="done">Done</option>
                        </select>
                    </FormField>
                ) : null}
                {canWrite ? (
                    <FormField label="Assignee" htmlFor="task-detail-assignee">
                        <select
                            id="task-detail-assignee"
                            className="input"
                            value={task.assigneeId ?? ""}
                            data-testid="task-detail-assignee"
                            onChange={(event) => onAssigneeChange(event.target.value)}
                        >
                            <option value="">Unassigned</option>
                            {members.map((member) => (
                                <option key={member.id} value={member.id}>
                                    {member.displayName}
                                </option>
                            ))}
                        </select>
                    </FormField>
                ) : null}
            </div>
            <section className="comment-section" data-testid="comment-section">
                <h3>Comments ({comments.length})</h3>
                {comments.length === 0 ? (
                    <p className="muted">No comments yet.</p>
                ) : (
                    <ul className="comment-list">
                        {comments.map((comment) => (
                            <li key={comment.id} className="comment-row">
                                <Avatar name={comment.authorId} size="sm" />
                                <p>{comment.body}</p>
                            </li>
                        ))}
                    </ul>
                )}
                {canWrite ? (
                    <div className="comment-compose">
                        <textarea
                            className="input"
                            rows={2}
                            placeholder="Add a comment…"
                            value={commentDraft}
                            data-testid="comment-input"
                            onChange={(event) => onDraftChange(event.target.value)}
                        />
                        <button
                            type="button"
                            className="button button-primary button-sm"
                            disabled={!commentDraft.trim()}
                            data-testid="comment-submit"
                            onClick={onAddComment}
                        >
                            Comment
                        </button>
                    </div>
                ) : null}
            </section>
        </Modal>
    );
}
