import type { NoteTag } from "../types";

const TAG_LABELS: Record<NoteTag, string> = {
    work: "Work",
    personal: "Personal",
    ideas: "Ideas",
    research: "Research",
};

export function TagPill({ tag }: { tag: NoteTag }) {
    return (
        <span className={`tag-pill tag-${tag}`} data-testid={`tag-${tag}`}>
            {TAG_LABELS[tag]}
        </span>
    );
}
