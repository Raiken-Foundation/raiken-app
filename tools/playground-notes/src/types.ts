/** Domain types for the Scrawl notes fixture — deterministic like Bazaar. */

export type NoteTag = "work" | "personal" | "ideas" | "research";

export interface Note {
    id: string;
    slug: string;
    title: string;
    body: string;
    tag: NoteTag;
    pinned: boolean;
    updatedAt: string;
}

export interface NewNoteInput {
    title: string;
    body: string;
    tag: NoteTag;
}
