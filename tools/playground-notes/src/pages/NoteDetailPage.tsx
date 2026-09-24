import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { deleteNote, getNote, togglePin } from "../api/store";
import { EmptyState } from "../components/EmptyState";
import { TagPill } from "../components/TagPill";
import { useToast } from "../contexts/ToastContext";

export function NoteDetailPage() {
    const { slug } = useParams<{ slug: string }>();
    const navigate = useNavigate();
    const { pushToast } = useToast();
    const [note, setNote] = useState(() => (slug ? getNote(slug) : undefined));
    const [confirming, setConfirming] = useState(false);

    useEffect(() => {
        document.title = note ? `${note.title} — Scrawl` : "Note not found — Scrawl";
    }, [note]);

    if (!note) {
        return (
            <EmptyState
                title="Note not found"
                message="This note may have been deleted."
                action={
                    <Link to="/" className="button" data-testid="back-to-notes">
                        Back to notes
                    </Link>
                }
            />
        );
    }

    // Narrowed copy for the hoisted handlers below: `note` is a state binding,
    // so TS can't prove it is defined inside function declarations.
    const current = note;
    function handlePin() {
        const updated = togglePin(current.slug);
        if (updated) setNote(updated);
    }

    function handleDelete() {
        if (!confirming) {
            setConfirming(true);
            return;
        }
        deleteNote(current.slug);
        pushToast("success", "Note deleted.");
        navigate("/");
    }

    return (
        <article className="note-detail" data-testid={`note-detail-${note.slug}`}>
            <header className="note-detail-header">
                <div className="note-detail-meta">
                    <TagPill tag={note.tag} />
                    <time dateTime={note.updatedAt} data-testid="note-updated">
                        Updated {new Date(note.updatedAt).toLocaleDateString()}
                    </time>
                </div>
                <h1 data-testid="note-title">{note.title}</h1>
            </header>
            <div className="note-detail-body" data-testid="note-body">
                {note.body.split("\n").map((line) => (
                    <p key={line}>{line}</p>
                ))}
            </div>
            <footer className="note-detail-actions">
                <Link to={`/note/${note.slug}/edit`} className="button" data-testid="edit-note">
                    Edit
                </Link>
                <button
                    type="button"
                    className="button secondary"
                    data-testid="pin-note"
                    onClick={handlePin}
                >
                    {note.pinned ? "Unpin" : "Pin"}
                </button>
                <button
                    type="button"
                    className="button danger"
                    data-testid="delete-note"
                    onClick={handleDelete}
                >
                    {confirming ? "Confirm delete" : "Delete"}
                </button>
            </footer>
        </article>
    );
}
