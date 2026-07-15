import { describe, expect, it } from "vitest";
import { buildPendingHitlMarker } from "../agent/agent";
import { createRunAction, createSaveAction, type HITLAction } from "../agent/hitl-types";

/** Decode a `<!--HITL:base64-->` marker back into its JSON payload. */
function decodeMarker(marker: string): Record<string, unknown> {
    const match = marker.match(/^<!--HITL:([\s\S]*?)-->$/);
    expect(match).not.toBeNull();
    const json = Buffer.from(match?.[1] ?? "", "base64").toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
}

describe("buildPendingHitlMarker", () => {
    it("returns null when no HITL action is pending", () => {
        expect(buildPendingHitlMarker([])).toBeNull();
    });

    it("surfaces a save_approval card for a pending save action", () => {
        const actions: HITLAction[] = [
            createSaveAction("test('x', async () => {});", "e2e/example.spec.ts", "example"),
        ];
        const marker = buildPendingHitlMarker(actions);
        expect(marker).not.toBeNull();
        const payload = decodeMarker(marker as string);
        expect(payload["kind"]).toBe("save_approval");
        expect(payload["testCode"]).toBe("test('x', async () => {});");
        expect(payload["suggestedPath"]).toBe("e2e/example.spec.ts");
        expect(payload["testName"]).toBe("example");
        expect(payload["options"]).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: "save_approve" })]),
        );
    });

    it("surfaces a run_approval card for a pending run action", () => {
        const actions: HITLAction[] = [
            createRunAction("e2e/example.spec.ts", "example", ["slow selector"]),
        ];
        const marker = buildPendingHitlMarker(actions);
        expect(marker).not.toBeNull();
        const payload = decodeMarker(marker as string);
        expect(payload["kind"]).toBe("run_approval");
        expect(payload["testFile"]).toBe("e2e/example.spec.ts");
        expect(payload["testName"]).toBe("example");
        expect(payload["reasons"]).toEqual(["slow selector"]);
        expect(payload["options"]).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: "run_approve" })]),
        );
    });

    // The regression this guards: a run pause always comes AFTER its own
    // save already resolved (auto-approved or user-approved) — if we picked
    // "the first save action found" instead of "the last action overall",
    // an already-resolved save from earlier in the same turn would get
    // re-surfaced as if it were still awaiting a decision, alongside (or
    // instead of) the actual pending run.
    it("surfaces only the LAST action when a run follows an already-resolved save", () => {
        const actions: HITLAction[] = [
            createSaveAction("test('x', async () => {});", "e2e/example.spec.ts", "example"),
            createRunAction("e2e/example.spec.ts", "example"),
        ];
        const marker = buildPendingHitlMarker(actions);
        const payload = decodeMarker(marker as string);
        expect(payload["kind"]).toBe("run_approval");
    });

    it("returns null for a HITL action type it doesn't render a card for", () => {
        const actions: HITLAction[] = [
            {
                type: "learn",
                timestamp: Date.now(),
                learnType: "preference",
                description: "d",
                value: "v",
            },
        ];
        expect(buildPendingHitlMarker(actions)).toBeNull();
    });
});
