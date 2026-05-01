import { useId, useMemo, useState } from "react";
import { ApiError, createTask } from "../../api";
import Modal from "../../components/Modal";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import type { Project, TaskPriority, User } from "../../types";

interface Props {
    project: Project;
    members: User[];
    onClose: () => void;
    onCreated: () => void | Promise<void>;
}

const PRIORITIES: TaskPriority[] = ["low", "medium", "high", "urgent"];

export default function TaskFormModal({ project, members, onClose, onCreated }: Props) {
    const { user } = useAuth();
    const { push } = useToast();

    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [priority, setPriority] = useState<TaskPriority>("medium");
    const [assigneeId, setAssigneeId] = useState<string>("");
    const [dueDate, setDueDate] = useState<string>("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const titleId = useId();
    const descId = useId();
    const priorityId = useId();
    const assigneeId_ = useId();
    const dueId = useId();

    const canSubmit = useMemo(() => title.trim().length >= 3, [title]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!user) return;
        setSubmitting(true);
        setError(null);
        try {
            await createTask({
                projectId: project.id,
                title,
                description,
                priority,
                assigneeId: assigneeId || null,
                dueDate: dueDate ? new Date(dueDate).toISOString() : null,
                actor: user,
            });
            push("success", `Created "${title.trim()}"`);
            await onCreated();
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Failed to create task";
            setError(message);
            push("error", message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            open
            title="New task"
            onClose={onClose}
            wide
            testId="task-modal"
            footer={
                <>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={onClose}
                        data-testid="task-form-cancel"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        form="task-form"
                        className="btn btn-primary"
                        disabled={!canSubmit || submitting}
                        data-testid="task-form-submit"
                    >
                        {submitting ? "Creating…" : "Create task"}
                    </button>
                </>
            }
        >
            <form id="task-form" className="modal-form" onSubmit={submit}>
                <div className="form-group">
                    <label htmlFor={titleId}>Title</label>
                    <input
                        id={titleId}
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        minLength={3}
                        required
                        data-testid="task-form-title"
                    />
                </div>
                <div className="form-group">
                    <label htmlFor={descId}>Description</label>
                    <textarea
                        id={descId}
                        rows={3}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        data-testid="task-form-description"
                    />
                </div>
                <div className="form-row">
                    <div className="form-group">
                        <label htmlFor={priorityId}>Priority</label>
                        <select
                            id={priorityId}
                            value={priority}
                            onChange={(e) => setPriority(e.target.value as TaskPriority)}
                            data-testid="task-form-priority"
                        >
                            {PRIORITIES.map((p) => (
                                <option key={p} value={p}>
                                    {p}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="form-group">
                        <label htmlFor={assigneeId_}>Assignee</label>
                        <select
                            id={assigneeId_}
                            value={assigneeId}
                            onChange={(e) => setAssigneeId(e.target.value)}
                            data-testid="task-form-assignee"
                        >
                            <option value="">Unassigned</option>
                            {members.map((m) => (
                                <option key={m.id} value={m.id}>
                                    {m.username}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="form-group">
                        <label htmlFor={dueId}>Due date</label>
                        <input
                            id={dueId}
                            type="date"
                            value={dueDate}
                            onChange={(e) => setDueDate(e.target.value)}
                            data-testid="task-form-due"
                        />
                    </div>
                </div>
                {error && (
                    <div className="form-error" role="alert" data-testid="task-form-error">
                        {error}
                    </div>
                )}
            </form>
        </Modal>
    );
}
