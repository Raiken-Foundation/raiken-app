import { describe, expect, it } from "vitest";

import { formatDiscoverChip } from "../background-discover";

describe("discover status chip", () => {
    it("returns null when idle", () => {
        expect(formatDiscoverChip({ status: "idle" })).toBeNull();
    });

    it("formats a running chip with page count and link count", () => {
        expect(formatDiscoverChip({ status: "running", pages: 3, links: 42, maxPages: 100 })).toBe(
            "discover 3/100 · 42 links",
        );
    });

    it("formats a paused chip without counts", () => {
        expect(formatDiscoverChip({ status: "paused", pages: 1, links: 5, maxPages: 10 })).toBe(
            "discover paused",
        );
    });

    it("formats a completed chip with discovered totals", () => {
        expect(
            formatDiscoverChip({ status: "completed", pages: 12, links: 80, maxPages: 100 }),
        ).toBe("discovered 12 · 80 links");
    });

    it("formats a failed chip without counts", () => {
        expect(formatDiscoverChip({ status: "failed", pages: 0, links: 0, maxPages: 10 })).toBe(
            "discover failed",
        );
    });
});
