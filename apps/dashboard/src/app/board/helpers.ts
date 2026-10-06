import type { BoardReport, BoardRow, BoardStatus } from "@raiken/shared";

/**
 * Pure presentation logic for the board — everything a behavior spec can
 * pin without a DOM. The board's language rules live here: statuses are
 * words, never scores; groups follow the ticket structure; the summary is
 * a sentence a stakeholder can read aloud.
 */

export interface BoardGroup {
    /** Ticket id, or the label for requirements with no ticket. */
    key: string;
    label: string;
    ticketUrl: string | null;
    rows: BoardRow[];
}

/** Plain-language group labels — the Reader never sees "no ticket" as a bucket. */
function groupFor(row: BoardRow): { key: string; label: string; ticketUrl: string | null } {
    if (row.ticket) {
        return {
            key: row.ticket.id,
            label: `Ticket ${row.ticket.id}`,
            ticketUrl: row.ticket.url,
        };
    }
    if (row.source === "file") {
        return { key: "file", label: "From the requirements file", ticketUrl: null };
    }
    if (row.source === "manual") {
        return { key: "manual", label: "Added by hand", ticketUrl: null };
    }
    return { key: "untracked", label: "Not linked to a ticket", ticketUrl: null };
}

export function groupRows(rows: BoardRow[]): BoardGroup[] {
    const groups = new Map<string, BoardGroup>();
    for (const row of rows) {
        const { key, label, ticketUrl } = groupFor(row);
        let group = groups.get(key);
        if (!group) {
            group = { key, label, ticketUrl, rows: [] };
            groups.set(key, group);
        }
        group.rows.push(row);
    }
    // Broken first, then not-checked, then working — attention ordering.
    const rank: Record<BoardStatus, number> = { broken: 0, "not-checked": 1, works: 2 };
    for (const group of groups.values()) {
        group.rows.sort((a, b) => rank[a.status] - rank[b.status]);
    }
    return [...groups.values()].sort((a, b) => {
        const aBroken = a.rows.some((r) => r.status === "broken") ? 0 : 1;
        const bBroken = b.rows.some((r) => r.status === "broken") ? 0 : 1;
        return aBroken - bBroken;
    });
}

export function statusLabel(status: BoardStatus): string {
    switch (status) {
        case "works":
            return "Works";
        case "broken":
            return "Broken";
        case "not-checked":
            return "Not checked";
    }
}

export function statusGlyph(status: BoardStatus): string {
    switch (status) {
        case "works":
            return "✓";
        case "broken":
            return "✗";
        case "not-checked":
            return "○";
    }
}

/** A read-aloud summary; numbers as words-of-status, never percentages. */
export function summarize(counts: BoardReport["counts"]): string {
    const parts = [
        counts.broken === 1 ? "1 promise broken" : `${counts.broken} promises broken`,
        counts.works === 1 ? "1 working" : `${counts.works} working`,
        counts.notChecked === 1 ? "1 not checked" : `${counts.notChecked} not checked`,
    ];
    return parts.join(" · ");
}

export function timeAgo(epochMs: number | null, now = Date.now()): string {
    if (!epochMs) return "";
    const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return days === 1 ? "yesterday" : `${days} days ago`;
}
