import { useEffect, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { searchNotes } from "../api/store";
import { EmptyState } from "../components/EmptyState";
import { NoteCard } from "../components/NoteCard";
import type { NoteTag } from "../types";

const TAGS: Array<NoteTag | "all"> = ["all", "work", "personal", "ideas", "research"];

export function NotesPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const query = searchParams.get("q") ?? "";
    const tag = (searchParams.get("tag") as NoteTag | null) ?? "all";

    const notes = useMemo(() => searchNotes(query, tag), [query, tag]);

    useEffect(() => {
        document.title = "Notes — Scrawl";
    }, []);

    function setTag(next: NoteTag | "all") {
        const params = new URLSearchParams(searchParams);
        if (next === "all") {
            params.delete("tag");
        } else {
            params.set("tag", next);
        }
        setSearchParams(params);
    }

    return (
        <section data-testid="notes-page">
            <div className="page-header">
                <h1>Notes</h1>
                <Link to="/new" className="button primary" data-testid="new-note-button">
                    New note
                </Link>
            </div>

            <div className="toolbar">
                <input
                    type="search"
                    className="search-input"
                    placeholder="Search notes…"
                    aria-label="Search notes"
                    data-testid="notes-search"
                    value={query}
                    onChange={(event) => {
                        const params = new URLSearchParams(searchParams);
                        const value = event.target.value;
                        if (value) {
                            params.set("q", value);
                        } else {
                            params.delete("q");
                        }
                        setSearchParams(params);
                    }}
                />
                <fieldset className="tag-filters" aria-label="Filter by tag">
                    {TAGS.map((candidate) => (
                        <button
                            key={candidate}
                            type="button"
                            className={tag === candidate ? "tag-filter active" : "tag-filter"}
                            data-testid={`filter-${candidate}`}
                            onClick={() => setTag(candidate)}
                        >
                            {candidate === "all" ? "All" : candidate}
                        </button>
                    ))}
                </fieldset>
            </div>

            {notes.length === 0 ? (
                <EmptyState
                    title="No notes found"
                    message="Try a different search or tag filter."
                />
            ) : (
                <div className="note-grid" data-testid="notes-list">
                    {notes.map((note) => (
                        <NoteCard key={note.id} note={note} />
                    ))}
                </div>
            )}
        </section>
    );
}
