import { describe, expect, it } from "vitest";
import { classifyRunResult, shouldAutoBuildGraph } from "../testing-view";

describe("testing view re-exports", () => {
    it("re-exports classifyRunResult from the testing module", () => {
        expect(classifyRunResult({ success: false, cancelled: true })).toBe("cancelled");
    });

    it("re-exports shouldAutoBuildGraph from the testing module", () => {
        expect(shouldAutoBuildGraph(null, false, false)).toBe(true);
    });
});
