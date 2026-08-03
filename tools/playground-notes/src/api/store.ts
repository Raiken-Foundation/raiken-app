import type { Note } from "../types";
import { seedNotes } from "./seed";

interface NotesState {
    notes: Note[];
}

const state: NotesState = { notes: seedNotes() };

function slugify(title: string): string {
    return (
        title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 48) || "note"
    );
}

export function listNotes(): Note[] {
    return [...state.notes].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt.localeCompare(a.updatedAt);
    });
}

export function getNote(slug: string): Note | undefined {
    return state.notes.find((note) => note.slug === slug);
}

export function createNote(input: { title: string; body: string; tag: Note["tag"] }): Note {
    const now = new Date().toISOString();
    const note: Note = {
        id: String(state.notes.length + 1),
        slug: slugify(input.title),
        title: input.title,
        body: input.body,
        tag: input.tag,
        pinned: false,
        updatedAt: now,
    };
    state.notes.push(note);
    return note;
}

export function updateNote(
    slug: string,
    input: { title: string; body: string; tag: Note["tag"] },
): Note | undefined {
    const note = getNote(slug);
    if (!note) return undefined;
    note.title = input.title;
    note.body = input.body;
    note.tag = input.tag;
    note.updatedAt = new Date().toISOString();
    return note;
}

export function deleteNote(slug: string): boolean {
    const index = state.notes.findIndex((note) => note.slug === slug);
    if (index === -1) return false;
    state.notes.splice(index, 1);
    return true;
}

export function togglePin(slug: string): Note | undefined {
    const note = getNote(slug);
    if (!note) return undefined;
    note.pinned = !note.pinned;
    note.updatedAt = new Date().toISOString();
    return note;
}

export function searchNotes(query: string, tag: Note["tag"] | "all"): Note[] {
    const q = query.trim().toLowerCase();
    return listNotes().filter((note) => {
        const matchesTag = tag === "all" || note.tag === tag;
        if (!matchesTag) return false;
        if (!q) return true;
        return note.title.toLowerCase().includes(q) || note.body.toLowerCase().includes(q);
    });
}
