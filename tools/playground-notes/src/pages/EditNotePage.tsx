import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getNote, updateNote } from "../api/store";
import { FormField } from "../components/FormField";
import { useToast } from "../contexts/ToastContext";
import type { NoteTag } from "../types";

const TAGS: NoteTag[] = ["work", "personal", "ideas", "research"];

export function EditNotePage() {
    const { slug } = useParams<{ slug: string }>();
    const navigate = useNavigate();
    const { pushToast } = useToast();
    const existing = slug ? getNote(slug) : undefined;

    const [title, setTitle] = useState(existing?.title ?? "");
    const [body, setBody] = useState(existing?.body ?? "");
    const [tag, setTag] = useState<NoteTag>(existing?.tag ?? "personal");
    const [errors, setErrors] = useState<{ title?: string; body?: string }>({});

    useEffect(() => {
        document.title = existing ? `Edit ${existing.title} — Scrawl` : "Edit note — Scrawl";
        if (!existing) {
            pushToast("error", "Note not found.");
            navigate("/", { replace: true });
        }
    }, [existing, navigate, pushToast]);

    if (!existing) return null;

    const current = existing;
    function handleSubmit(event: React.FormEvent) {
        event.preventDefault();
        const nextErrors: typeof errors = {};
        if (!title.trim()) nextErrors.title = "Title is required.";
        if (!body.trim()) nextErrors.body = "Body is required.";
        setErrors(nextErrors);
        if (Object.keys(nextErrors).length > 0) return;

        updateNote(current.slug, { title: title.trim(), body: body.trim(), tag });
        pushToast("success", "Note updated.");
        navigate(`/note/${current.slug}`);
    }

    return (
        <section data-testid="edit-note-page">
            <h1>Edit note</h1>
            <form className="note-form" data-testid="edit-note-form" onSubmit={handleSubmit}>
                <FormField label="Title" htmlFor="title-input" error={errors.title}>
                    <input
                        id="title-input"
                        type="text"
                        data-testid="title-input"
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                    />
                </FormField>
                <FormField label="Body" htmlFor="body-input" error={errors.body}>
                    <textarea
                        id="body-input"
                        data-testid="body-input"
                        rows={6}
                        value={body}
                        onChange={(event) => setBody(event.target.value)}
                    />
                </FormField>
                <FormField label="Tag" htmlFor="tag-select">
                    <select
                        id="tag-select"
                        data-testid="tag-select"
                        value={tag}
                        onChange={(event) => setTag(event.target.value as NoteTag)}
                    >
                        {TAGS.map((candidate) => (
                            <option key={candidate} value={candidate}>
                                {candidate}
                            </option>
                        ))}
                    </select>
                </FormField>
                <div className="form-actions">
                    <button type="submit" className="button primary" data-testid="save-note">
                        Save changes
                    </button>
                </div>
            </form>
        </section>
    );
}
