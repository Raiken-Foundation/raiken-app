/**
 * `printIfActionable` regression spec (disc-6, CLI side).
 *
 * Wall-clock-cap pause semantics (disc-7) live in
 * `libs/core/src/application/__tests__/discovery-application.spec.ts` because
 * background discovery now delegates to DiscoveryApplication.
 */

import type { DiscoveryEvent } from "@raiken/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const { printIfActionable, __resetBackgroundDiscoverForTests } = await import(
    "../background-discover"
);

function makeWarningEvent(data: Record<string, unknown>): DiscoveryEvent {
    return {
        type: "warning" as DiscoveryEvent["type"],
        data: data as unknown as DiscoveryEvent["data"],
        timestamp: Date.now(),
    };
}

describe("background-discover printIfActionable (disc-6)", () => {
    afterEach(() => {
        __resetBackgroundDiscoverForTests();
    });

    it("prints checkpoint_failed warnings to stderr", () => {
        const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            printIfActionable(
                makeWarningEvent({ code: "checkpoint_failed", message: "disk full" }),
            );
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy.mock.calls[0]?.[0]).toContain("disk full");
        } finally {
            spy.mockRestore();
        }
    });

    it("stays silent for routine per-request warnings (no code)", () => {
        const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            printIfActionable(
                makeWarningEvent({
                    url: "https://example.test",
                    message: "Request failed: timeout",
                }),
            );
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    it("stays silent for other known warning codes", () => {
        const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            printIfActionable(
                makeWarningEvent({
                    code: "off_origin_redirect",
                    message: "Followed off-origin redirect",
                }),
            );
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});
