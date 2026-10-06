import type { BoardRow } from "@raiken/shared";
import { describe, expect, it } from "vitest";
import { groupRows, statusGlyph, statusLabel, summarize, timeAgo } from "../helpers";

function row(overrides: Partial<BoardRow> = {}): BoardRow {
    return {
        requirementKey: "rk",
        text: 'adding a chore without a name shows "Chore needs a name"',
        status: "not-checked",
        ticket: null,
        neverRegress: false,
        sinceWhen: null,
        sinceCommit: null,
        evidence: null,
        factKey: null,
        ...overrides,
    };
}

describe("board grouping", () => {
    it("groups rows by ticket, with unticketed requirements in their own group", () => {
        const groups = groupRows([
            row({ requirementKey: "a", ticket: { id: "RAIK-1", provider: "github", url: null } }),
            row({ requirementKey: "b" }),
            row({
                requirementKey: "c",
                ticket: { id: "RAIK-1", provider: "github", url: null },
            }),
        ]);
        expect(groups.map((g) => g.key)).toEqual(["RAIK-1", "No ticket"]);
        expect(groups[0].rows).toHaveLength(2);
        expect(groups[1].rows).toHaveLength(1);
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
