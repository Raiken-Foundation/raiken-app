import { describe, expect, it } from "vitest";
import { classifyRunResult, shouldAutoBuildGraph } from "../testing-view";

describe("testing view run disposition", () => {
    it("does not classify a cancelled run as failed", () => {
        expect(classifyRunResult({ success: false, cancelled: true })).toBe("cancelled");
    });

    it("prioritizes a busy rejection over success state", () => {
        expect(classifyRunResult({ success: false, busy: true })).toBe("busy");
    });
});

describe("testing view graph initialization", () => {
    it("builds once when a fresh project has no graph stats", () => {
        expect(shouldAutoBuildGraph(null, false, false)).toBe(true);
        expect(shouldAutoBuildGraph(null, true, false)).toBe(false);
    });

    it("does not loop when a completed build indexed zero files", () => {
        expect(shouldAutoBuildGraph({ totalFiles: 0 }, true, false)).toBe(false);
    });

    it("waits for the stats query before deciding", () => {
        expect(shouldAutoBuildGraph(undefined, false, false)).toBe(false);
    });
});
