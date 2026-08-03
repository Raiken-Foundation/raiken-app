import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createNote } from "../api/store";
import { FormField } from "../components/FormField";
import { useToast } from "../contexts/ToastContext";
import type { NoteTag } from "../types";

const TAGS: NoteTag[] = ["work", "personal", "ideas", "research"];

export function NewNotePage() {
    const navigate = useNavigate();
    const { pushToast } = useToast();
    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [tag, setTag] = useState<NoteTag>("personal");
    const [errors, setErrors] = useState<{ title?: string; body?: string }>({});

    useEffect(() => {
        document.title = "New note — Scrawl";
    }, []);

    function handleSubmit(event: React.FormEvent) {
        event.preventDefault();
        const nextErrors: typeof errors = {};
        if (!title.trim()) nextErrors.title = "Title is required.";
        if (!body.trim()) nextErrors.body = "Body is required.";
        setErrors(nextErrors);
        if (Object.keys(nextErrors).length > 0) return;

        const note = createNote({ title: title.trim(), body: body.trim(), tag });
        pushToast("success", "Note created.");
        navigate(`/note/${note.slug}`);
    }

    return (
        <section data-testid="new-note-page">
            <h1>New note</h1>
            <form className="note-form" data-testid="new-note-form" onSubmit={handleSubmit}>
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
                    <button type="submit" className="button primary" data-testid="create-note">
                        Create note
                    </button>
                </div>
            </form>
        </section>
    );
}
