import { describe, expect, it } from "vitest";
import { HITL_RESUME_BACKOFF_MS } from "../constants";
import {
    markHitlResumeFailure,
    markHitlResumeSuccess,
    shouldAttemptHitlResume,
} from "../hitl/resume-state";

describe("shouldAttemptHitlResume", () => {
    it("allows a repairing workflow that has not been resumed yet", () => {
        expect(
            shouldAttemptHitlResume(
                { id: "wf-1", status: "repairing" },
                new Set(),
                new Map(),
                1000,
            ),
        ).toBe(true);
    });

    it("blocks while a resume attempt is in flight", () => {
        expect(
            shouldAttemptHitlResume(
                { id: "wf-1", status: "repairing" },
                new Set(["wf-1"]),
                new Map(),
                1000,
            ),
        ).toBe(false);
    });

    it("blocks until backoff expires after a failure", () => {
        const retryAfter = new Map([["wf-1", 5000]]);
        expect(
            shouldAttemptHitlResume(
                { id: "wf-1", status: "repairing" },
                new Set(),
                retryAfter,
                4000,
            ),
        ).toBe(false);
        expect(
            shouldAttemptHitlResume(
                { id: "wf-1", status: "repairing" },
                new Set(),
                retryAfter,
                5000,
            ),
        ).toBe(true);
    });
});

describe("markHitlResumeFailure", () => {
    it("clears the in-flight guard and schedules retry", () => {
        const resumed = new Set(["wf-1"]);
        const retryAfter = new Map<string, number>();
        markHitlResumeFailure("wf-1", resumed, retryAfter, 1000, HITL_RESUME_BACKOFF_MS);
        expect(resumed.has("wf-1")).toBe(false);
        expect(retryAfter.get("wf-1")).toBe(1000 + HITL_RESUME_BACKOFF_MS);
    });
});

describe("markHitlResumeSuccess", () => {
    it("clears retry backoff after a successful resume", () => {
        const retryAfter = new Map([["wf-1", 9000]]);
        markHitlResumeSuccess("wf-1", retryAfter);
        expect(retryAfter.has("wf-1")).toBe(false);
    });
});
