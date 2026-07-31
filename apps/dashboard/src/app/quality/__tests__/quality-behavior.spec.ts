import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL, TOOLS } from "../constants";
import {
    buildContextCommandParts,
    buildCoverCommandParts,
    buildDoctorCommandParts,
    buildImpactCommandParts,
    buildTraceCommandParts,
    formatErrorMessage,
    getToolFromHash,
    shortSha,
} from "../helpers";

describe("quality hash routing", () => {
    it("defaults to doctor for unknown hash segments", () => {
        window.location.hash = "#/quality/unknown";
        expect(getToolFromHash()).toBe(DEFAULT_TOOL);
    });

    it("selects a valid tool from the hash", () => {
        window.location.hash = "#/quality/trace";
        expect(getToolFromHash()).toBe("trace");
    });

    it("lists five quality tools", () => {
        expect(TOOLS).toHaveLength(5);
        expect(TOOLS.map((t) => t.id)).toEqual(["doctor", "impact", "trace", "cover", "context"]);
    });
});

describe("quality command builders", () => {
    it("builds doctor command with optional test dir", () => {
        expect(buildDoctorCommandParts("")).toEqual(["doctor"]);
        expect(buildDoctorCommandParts("e2e")).toEqual(["doctor", "--test-dir", "e2e"]);
    });

    it("builds impact command with staged and confidence flags", () => {
        expect(
            buildImpactCommandParts({
                base: "",
                head: "",
                staged: true,
                threshold: "0.1",
            }),
        ).toEqual(["ci", "--skip-run", "--staged"]);

        expect(
            buildImpactCommandParts({
                base: "main",
                head: "feature",
                staged: false,
                threshold: "0.25",
            }),
        ).toEqual([
            "ci",
            "--skip-run",
            "--base",
            "main",
            "--head",
            "feature",
            "--confidence",
            "0.25",
        ]);
    });

    it("builds trace command with optional confidence floor", () => {
        expect(buildTraceCommandParts("0")).toEqual(["trace", "--stdin"]);
        expect(buildTraceCommandParts("0.5")).toEqual(["trace", "--stdin", "--confidence", "0.5"]);
    });

    it("builds cover command with target, ticket, and dry-run", () => {
        expect(buildCoverCommandParts({ target: "", ticketId: "", dryRun: false })).toEqual([
            "cover",
            "<target>",
        ]);
        expect(
            buildCoverCommandParts({
                target: "Login flow",
                ticketId: "ENG-1",
                dryRun: true,
            }),
        ).toEqual(["cover", '"Login flow"', "--ticket", "ENG-1", "--dry-run"]);
    });

    it("builds context command with max rows and impact toggle", () => {
        expect(buildContextCommandParts({ maxRows: "25", includeImpact: true })).toEqual([
            "context",
        ]);
        expect(buildContextCommandParts({ maxRows: "50", includeImpact: false })).toEqual([
            "context",
            "--max-rows",
            "50",
            "--no-impact",
        ]);
    });
});

describe("quality helpers", () => {
    it("shortens git shas for display", () => {
        expect(shortSha("abcdef1234567890")).toBe("abcdef1");
        expect(shortSha("")).toBe("—");
    });

    it("formats errors from Error objects and plain values", () => {
        expect(formatErrorMessage(new Error("boom"))).toBe("boom");
        expect(formatErrorMessage({ message: "rpc failed" })).toBe("rpc failed");
        expect(formatErrorMessage("plain")).toBe("plain");
    });
});
