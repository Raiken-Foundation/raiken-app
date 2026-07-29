import { useEffect, useId, useState } from "react";
import { ApiError, addComment, listComments } from "../../api";
import Modal from "../../components/Modal";
import { PriorityPill, TaskStatusPill } from "../../components/StatusPill";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import type { Comment, Task, User } from "../../types";

interface Props {
    task: Task;
    members: User[];
    readOnly: boolean;
    onClose: () => void;
    onCommentAdded: () => Promise<void> | void;
}

export default function TaskDetailsModal({
    task,
    members,
    readOnly,
    onClose,
    onCommentAdded,
}: Props) {
    const { user } = useAuth();
    const { push } = useToast();
    const commentId = useId();
    const [comments, setComments] = useState<Comment[]>([]);
    const [body, setBody] = useState("");
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        listComments(task.id)
            .then((items) => {
                if (!cancelled) setComments(items);
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(err instanceof ApiError ? err.message : "Failed to load comments");
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [task.id]);

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!user || !body.trim() || readOnly) return;
        setSubmitting(true);
        setError(null);
        try {
            const comment = await addComment({ taskId: task.id, body, actor: user });
            setComments((current) => [...current, comment]);
            setBody("");
            push("success", "Comment added");
            await onCommentAdded();
        } catch (err) {
            const message = err instanceof ApiError ? err.message : "Failed to add comment";
            setError(message);
            push("error", message);
        } finally {
            setSubmitting(false);
        }
    };

    const assignee = members.find((member) => member.id === task.assigneeId);
    return (
        <Modal
            open
            wide
            title={task.title}
            testId="task-details-modal"
            onClose={onClose}
            footer={
                <button type="button" className="btn btn-secondary" onClick={onClose}>
                    Close
                </button>
            }
        >
            <div className="task-detail-summary">
                <TaskStatusPill status={task.status} />
                <PriorityPill priority={task.priority} />
                <span>{assignee ? `Assigned to ${assignee.username}` : "Unassigned"}</span>
                <span>
                    {task.dueDate
                        ? `Due ${new Date(task.dueDate).toLocaleDateString()}`
                        : "No due date"}
                </span>
            </div>
            <p className="task-detail-description">
                {task.description || "No description was provided."}
            </p>

            <section className="comment-section" aria-labelledby={`${commentId}-heading`}>
                <h4 id={`${commentId}-heading`}>Comments</h4>
                {loading && <p aria-live="polite">Loading comments…</p>}
                {!loading && comments.length === 0 && (
                    <p className="muted" data-testid="comments-empty">
                        No comments yet.
                    </p>
                )}
                <ul className="comment-list" data-testid="comment-list">
                    {comments.map((comment) => {
                        const author = members.find((member) => member.id === comment.authorId);
                        return (
                            <li key={comment.id} className="comment-item">
                                <div>
                                    <strong>{author?.username ?? "Unknown user"}</strong>
                                    <time dateTime={comment.createdAt}>
                                        {new Date(comment.createdAt).toLocaleString()}
                                    </time>
                                </div>
                                <p>{comment.body}</p>
                            </li>
                        );
                    })}
                </ul>
                {readOnly ? (
                    <p className="alert alert-info" data-testid="comments-readonly">
                        Archived projects are read-only.
                    </p>
                ) : (
                    <form className="comment-form" onSubmit={submit}>
                        <label htmlFor={commentId}>Add a comment</label>
                        <textarea
                            id={commentId}
                            rows={3}
                            value={body}
                            onChange={(event) => setBody(event.target.value)}
                            data-testid="comment-input"
                        />
                        {error && (
                            <div className="form-error" role="alert">
                                {error}
                            </div>
                        )}
                        <button
                            type="submit"
                            className="btn btn-primary"
                            disabled={!body.trim() || submitting}
                            data-testid="comment-submit"
                        >
                            {submitting ? "Adding…" : "Add comment"}
                        </button>
                    </form>
                )}
            </section>
        </Modal>
    );
}
