import type { Note } from "../types";

/** Deterministic seed content — fixed slugs so hand-written and generated tests agree. */
export function seedNotes(): Note[] {
    const base = "2026-07-01T09:00:00.000Z";
    return [
        {
            id: "1",
            slug: "welcome-to-scrawl",
            title: "Welcome to Scrawl",
            body: "Scrawl is a scratchpad for quick thoughts. Pin the notes you care about, tag the rest.",
            tag: "personal",
            pinned: true,
            updatedAt: base,
        },
        {
            id: "2",
            slug: "roadmap-notes",
            title: "Roadmap notes",
            body: "Q3: ship the import/export feature, add keyboard shortcuts, and retire the legacy sync endpoint.",
            tag: "work",
            pinned: true,
            updatedAt: base,
        },
        {
            id: "3",
            slug: "book-recommendations",
            title: "Book recommendations",
            body: "Someone recommended 'The Design of Everyday Things' and a biography of Ada Lovelace.",
            tag: "ideas",
            pinned: false,
            updatedAt: base,
        },
        {
            id: "4",
            slug: "meeting-agenda",
            title: "Meeting agenda",
            body: "1. Review sprint goals. 2. Decide on the API versioning strategy. 3. Demo the search improvements.",
            tag: "work",
            pinned: false,
            updatedAt: base,
        },
        {
            id: "5",
            slug: "research-links",
            title: "Research links",
            body: "Keep a running list of papers on retrieval evaluation and grounded generation for the eval project.",
            tag: "research",
            pinned: false,
            updatedAt: base,
        },
        {
            id: "6",
            slug: "grocery-list",
            title: "Grocery list",
            body: "Oats, coffee beans, olive oil, lemons, and a block of parmesan.",
            tag: "personal",
            pinned: false,
            updatedAt: base,
        },
    ];
}
