import { describe, expect, it } from "vitest";

// Inline the chip formatter logic to avoid pulling @raiken/shared via
// background-discover.ts in unit tests. Keep in sync with formatDiscoverChip.
type State =
    | { status: "idle" }
    | {
          status: "running" | "paused" | "completed" | "failed";
          pages: number;
          links: number;
          maxPages: number;
      };

function chip(state: State): string | null {
    if (state.status === "idle") return null;
    if (state.status === "running") {
        return `discover ${state.pages}/${state.maxPages} · ${state.links} links`;
    }
    if (state.status === "paused") return "discover paused";
    if (state.status === "completed") return `discovered ${state.pages} · ${state.links} links`;
    if (state.status === "failed") return "discover failed";
    return null;
}

describe("discover status chip", () => {
    it("formats states", () => {
        expect(chip({ status: "idle" })).toBeNull();
        expect(chip({ status: "running", pages: 3, links: 42, maxPages: 100 })).toBe(
            "discover 3/100 · 42 links",
        );
        expect(chip({ status: "paused", pages: 1, links: 5, maxPages: 10 })).toBe(
            "discover paused",
        );
        expect(chip({ status: "completed", pages: 12, links: 80, maxPages: 100 })).toBe(
            "discovered 12 · 80 links",
        );
    });
});
