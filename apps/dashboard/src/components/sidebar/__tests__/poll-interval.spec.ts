import { describe, expect, it } from "vitest";
import {
    HITL_SYNC_POLL_MS,
    HITL_SYNC_POLL_SLOW_MS,
    resolveVisiblePollInterval,
    resolveVisiblePollIntervalInner,
} from "../constants";

describe("resolveVisiblePollIntervalInner", () => {
    it("returns the base interval when the tab is visible and idle", () => {
        expect(
            resolveVisiblePollIntervalInner(HITL_SYNC_POLL_MS, HITL_SYNC_POLL_SLOW_MS, false),
        ).toBe(HITL_SYNC_POLL_MS);
    });

    it("returns the slow interval while generation is in-flight", () => {
        expect(
            resolveVisiblePollIntervalInner(HITL_SYNC_POLL_MS, HITL_SYNC_POLL_SLOW_MS, true),
        ).toBe(HITL_SYNC_POLL_SLOW_MS);
    });

    it("returns false when polling is paused during a conflicting mutation", () => {
        expect(
            resolveVisiblePollIntervalInner(HITL_SYNC_POLL_MS, HITL_SYNC_POLL_SLOW_MS, false, true),
        ).toBe(false);
    });

    it("returns false when the dashboard tab is hidden", () => {
        expect(
            resolveVisiblePollIntervalInner(
                HITL_SYNC_POLL_MS,
                HITL_SYNC_POLL_SLOW_MS,
                false,
                false,
                true,
            ),
        ).toBe(false);
    });
});

describe("resolveVisiblePollInterval", () => {
    it("disables polling under Vitest to avoid runaway query timers", () => {
        expect(resolveVisiblePollInterval(HITL_SYNC_POLL_MS, HITL_SYNC_POLL_SLOW_MS, false)).toBe(
            false,
        );
    });
});
