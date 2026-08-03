import { Link } from "react-router-dom";
import type { Note } from "../types";
import { TagPill } from "./TagPill";

export function NoteCard({ note }: { note: Note }) {
    return (
        <article className="note-card" data-testid={`note-card-${note.slug}`}>
            <div className="note-card-header">
                <Link to={`/note/${note.slug}`} data-testid={`note-link-${note.slug}`}>
                    <h3>{note.title}</h3>
                </Link>
                {note.pinned && (
                    <span className="pinned-badge" data-testid={`pinned-${note.slug}`}>
                        Pinned
                    </span>
                )}
            </div>
            <TagPill tag={note.tag} />
            <p className="note-card-body">{note.body}</p>
            <time className="note-card-date" dateTime={note.updatedAt}>
                Updated {new Date(note.updatedAt).toLocaleDateString()}
            </time>
        </article>
    );
}
