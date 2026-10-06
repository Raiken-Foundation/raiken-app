import type { BoardRow } from "@raiken/shared";
import { describe, expect, it } from "vitest";
import {
    explainCall,
    groupRows,
    plainObservable,
    statusGlyph,
    statusLabel,
    summarize,
    timeAgo,
} from "../helpers";

function row(overrides: Partial<BoardRow> = {}): BoardRow {
    return {
        requirementKey: "rk",
        text: 'adding a chore without a name shows "Chore needs a name"',
        status: "not-checked",
        ticket: null,
        source: "file",
        neverRegress: false,
        sinceWhen: null,
        sinceCommit: null,
        evidence: null,
        factKey: null,
        ...overrides,
    };
}

describe("board grouping", () => {
    it("groups rows by ticket, with unticketed requirements in their own plain-language group", () => {
        const groups = groupRows([
            row({ requirementKey: "a", ticket: { id: "RAIK-1", provider: "github", url: null } }),
            row({ requirementKey: "b" }),
            row({
                requirementKey: "c",
                ticket: { id: "RAIK-1", provider: "github", url: null },
            }),
        ]);
        expect(groups.map((g) => g.key)).toEqual(["RAIK-1", "file"]);
        expect(groups[0].rows).toHaveLength(2);
        expect(groups[1].rows).toHaveLength(1);
        expect(groups[1].label).toBe("From the requirements file");
    });

    it("never labels a bucket 'No ticket' — the Reader sees where the promise came from", () => {
        for (const source of ["file", "manual"] as const) {
            expect(groupRows([row({ source })])[0].label.toLowerCase()).not.toContain("no ticket");
        }
        expect(groupRows([row({ source: "manual" })])[0].label).toBe("Added by hand");
    });

    it("sorts broken rows first within groups, and broken groups first overall", () => {
        const groups = groupRows([
            row({ requirementKey: "works", status: "works" }),
            row({ requirementKey: "broken", status: "broken" }),
            row({ requirementKey: "unchecked" }),
        ]);
        expect(groups[0].rows.map((r) => r.status)).toEqual(["broken", "not-checked", "works"]);

        const two = groupRows([
            row({
                requirementKey: "a-ok",
                status: "works",
                ticket: { id: "T-2", provider: "jira", url: null },
            }),
            row({
                requirementKey: "b-bad",
                status: "broken",
                ticket: { id: "T-1", provider: "jira", url: null },
            }),
        ]);
        expect(two[0].key).toBe("T-1");
    });

    it("carries the ticket url through for the group heading link", () => {
        const groups = groupRows([
            row({ ticket: { id: "RAIK-9", provider: "github", url: "https://x/9" } }),
        ]);
        expect(groups[0].ticketUrl).toBe("https://x/9");
        expect(groups[0].label).toBe("Ticket RAIK-9");
    });
});

describe("board language", () => {
    it("labels statuses in words — never scores, never percentages", () => {
        expect(statusLabel("works")).toBe("Works");
        expect(statusLabel("broken")).toBe("Broken");
        expect(statusLabel("not-checked")).toBe("Not checked");
        for (const s of ["works", "broken", "not-checked"] as const) {
            expect(statusLabel(s)).not.toMatch(/%|\d/);
        }
    });

    it("pairs every glyph with its word form (color never carries meaning alone)", () => {
        expect(statusGlyph("works")).toBe("✓");
        expect(statusGlyph("broken")).toBe("✗");
        expect(statusGlyph("not-checked")).toBe("○");
    });

    it("summarizes as a read-aloud sentence", () => {
        expect(summarize({ works: 2, broken: 1, notChecked: 4 })).toBe(
            "1 promise broken · 2 working · 4 not checked",
        );
        expect(summarize({ works: 0, broken: 0, notChecked: 0 })).toBe(
            "0 promises broken · 0 working · 0 not checked",
        );
    });
});

describe("board timestamps", () => {
    const now = 1_000_000;
    it("reads naturally at the usual ranges", () => {
        expect(timeAgo(null, now)).toBe("");
        expect(timeAgo(now - 30_000, now)).toBe("just now");
        expect(timeAgo(now - 5 * 60_000, now)).toBe("5 min ago");
        expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
        expect(timeAgo(now - 26 * 3_600_000, now)).toBe("yesterday");
    });
});

describe("plainObservable — observable notation in English", () => {
    it("translates the three observable shapes a Reader will meet", () => {
        expect(plainObservable('shows "Tool name is required"')).toBe(
            'show "Tool name is required"',
        );
        expect(plainObservable('shows heading "ToolCrib"')).toBe('show the heading "ToolCrib"');
        expect(
            plainObservable("exposes inputs [Tool name, Borrower, Days] and submit [Record loan]"),
        ).toBe('have Tool name, Borrower and Days fields, and a "Record loan" button');
    });

    it("handles a single field without pluralising it", () => {
        expect(plainObservable("exposes inputs [Email]")).toBe("have Email field");
    });

    it("passes anything it does not recognise through untouched", () => {
        expect(plainObservable("does something new")).toBe("does something new");
    });
});

describe("explainCall — the Reader's decision, stated plainly", () => {
    const call = {
        reviewId: 1,
        requirementText: 'recording a loan without a tool shows "Tool name is required"',
        route: "http://localhost:9500/lend",
        was: 'shows "Tool name is required"',
        observed: 'expected shows "Tool name is required" — no longer present',
        sinceWhen: 5,
    };

    it("asks about the promise with no jargon in the sentence", () => {
        const plain = explainCall(call);
        expect(plain.title).toBe(call.requirementText);
        expect(plain.before).toBe('It used to show "Tool name is required".');
        expect(plain.now).toBe("It no longer does that.");
        expect(JSON.stringify(plain)).not.toMatch(/exposes inputs|observable|factKey/);
    });

    it("falls back to the page when no ticket covers the change", () => {
        const plain = explainCall({ ...call, requirementText: null });
        expect(plain.title).toBe("An observed behavior on /lend");
    });
});
