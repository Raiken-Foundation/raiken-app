/**
 * Board projection tests — the Reader's view of the contract.
 *
 * The rules under test are product rules, not implementation details:
 * - the observation outranks the claim (a violated matched fact reads broken
 *   even when the intent's derived status lags)
 * - not-checked is the honest default and never masquerades as success
 * - broken rows carry evidence and a timestamp; no scores anywhere
 */
import { describe, expect, it } from "vitest";
import { projectBoard } from "../contract/status";
import type { BehaviorFact, FactEvent, IntentFact } from "../contract/types";

let nextId = 1;

function intent(overrides: Partial<IntentFact> = {}): IntentFact {
    return {
        requirementKey: `rk-${nextId}`,
        requirementText: "adding a chore without a name shows \"Chore needs a name\"",
        routeHint: "/",
        ticketId: null,
        ticketProvider: null,
        ticketSeverity: null,
        ticketUrl: null,
        neverRegress: false,
        status: "uncovered",
        matchedFactId: null,
        source: "file",
        importedAt: 1,
        ...overrides,
    };
}

function fact(overrides: Partial<BehaviorFact> = {}): BehaviorFact {
    const id = nextId++;
    return {
        id,
        factKey: `fk-${id}`,
        route: "/",
        precondition: null,
        action: 'submit "Add chore" form empty',
        expectedObservable: 'shows "Chore needs a name"',
        status: "verified",
        evidence: null,
        sourceCommit: null,
        capturedAt: 1,
        lastVerifiedAt: 100,
        verifiedCount: 3,
        violatedCount: 0,
        confidence: 1,
        ...overrides,
    };
}

function event(overrides: Partial<FactEvent> = {}): FactEvent {
    return {
        id: nextId++,
        factKey: "fk-1",
        eventType: "verified",
        detail: "observed shows \"Chore needs a name\"",
        occurredAt: 200,
        ...overrides,
    };
}

describe("projectBoard", () => {
    it("renders a covered requirement with a verified fact as works, stamped by the ledger", () => {
        const f = fact();
        const board = projectBoard({
            intents: [intent({ status: "covered", matchedFactId: f.id })],
            facts: [f],
            events: [event({ factKey: f.factKey, eventType: "verified", occurredAt: 300 })],
            now: 1000,
        });
        expect(board.rows[0].status).toBe("works");
        expect(board.rows[0].sinceWhen).toBe(300);
        expect(board.rows[0].evidence).toBeNull();
        expect(board.counts).toEqual({ works: 1, broken: 0, notChecked: 0 });
    });

    it("reads broken when the matched fact is violated, even if the intent status lags", () => {
        const f = fact({ status: "violated", violatedCount: 1, verifiedCount: 2 });
        const board = projectBoard({
            intents: [intent({ status: "covered", matchedFactId: f.id })],
            facts: [f],
            events: [
                event({
                    factKey: f.factKey,
                    eventType: "violated",
                    detail: "expected shows \"Chore needs a name\" — no longer present",
                    occurredAt: 400,
                    commitSha: "abc123",
                }),
            ],
        });
        expect(board.rows[0].status).toBe("broken");
        expect(board.rows[0].evidence).toContain("no longer present");
        expect(board.rows[0].sinceWhen).toBe(400);
        expect(board.rows[0].sinceCommit).toBe("abc123");
        expect(board.counts.broken).toBe(1);
    });

    it("keeps not-checked honest: uncovered or matched to nothing observable", () => {
        const board = projectBoard({
            intents: [
                intent({ requirementKey: "a" }),
                intent({ requirementKey: "b", status: "covered", matchedFactId: 999 }),
            ],
            facts: [],
            events: [],
        });
        expect(board.rows.map((r) => r.status)).toEqual(["not-checked", "not-checked"]);
        expect(board.counts.notChecked).toBe(2);
    });

    it("reads broken from the intent side too, with a plain fallback evidence line", () => {
        const board = projectBoard({
            intents: [intent({ status: "violated" })],
            facts: [],
            events: [],
        });
        expect(board.rows[0].status).toBe("broken");
        expect(board.rows[0].evidence).toContain("no longer observed");
    });

    it("carries the ticket reference through, verbatim", () => {
        const board = projectBoard({
            intents: [
                intent({
                    ticketId: "RAIK-121",
                    ticketProvider: "github",
                    ticketUrl: "https://example/RAIK-121",
                }),
            ],
            facts: [],
        });
        expect(board.rows[0].ticket).toEqual({
            id: "RAIK-121",
            provider: "github",
            url: "https://example/RAIK-121",
        });
        expect(board.rows[0].text).toContain("Chore needs a name");
    });

    it("never emits a score or percentage — statuses only", () => {
        const f = fact({ confidence: 0.4 });
        const board = projectBoard({
            intents: [intent({ status: "covered", matchedFactId: f.id })],
            facts: [f],
        });
        const row = board.rows[0] as unknown as Record<string, unknown>;
        expect(row.status).toBe("works");
        expect(JSON.stringify(board)).not.toMatch(/score|percent|confidence|0\.4/);
    });

    it("surfaces pending reviews as the Reader's call, linked to their promise", () => {
        const f = fact({ status: "violated" });
        const board = projectBoard({
            intents: [
                intent({
                    requirementText: 'recording a loan without a tool shows "Tool name is required"',
                    status: "violated",
                    matchedFactId: f.id,
                }),
            ],
            facts: [f],
            reviews: [
                {
                    id: 7,
                    factKey: f.factKey,
                    route: "http://localhost:9500/lend",
                    action: 'submit "Record loan" form empty',
                    expectedObservable: 'shows "Tool name is required"',
                    observed: 'expected shows "Tool name is required" — no longer present',
                    status: "pending",
                    createdAt: 1234,
                    decidedAt: null,
                },
            ],
        });
        expect(board.needsYourCall).toHaveLength(1);
        const call = board.needsYourCall?.[0];
        expect(call?.reviewId).toBe(7);
        expect(call?.factKey).toBe(f.factKey);
        expect(call?.requirementText).toBe(
            'recording a loan without a tool shows "Tool name is required"',
        );
        expect(call?.sinceWhen).toBe(1234);
    });

    it("stays quiet about a review whose change no longer reproduces", () => {
        // The app was fixed: the fact verifies again, so the pending review is
        // history — the board must not ask the Reader to adjudicate it.
        const f = fact({ status: "verified" });
        const board = projectBoard({
            intents: [intent({ status: "covered", matchedFactId: f.id })],
            facts: [f],
            reviews: [
                {
                    id: 12,
                    factKey: f.factKey,
                    route: "http://localhost:9500/lend",
                    action: 'submit "Record loan" form empty',
                    expectedObservable: 'shows "Tool name is required"',
                    observed: 'expected shows "Tool name is required" — no longer present',
                    status: "pending",
                    createdAt: 1,
                    decidedAt: null,
                },
            ],
        });
        expect(board.needsYourCall).toEqual([]);
    });

    it("still surfaces a call whose change no requirement covers", () => {
        const orphan = fact({ factKey: "fk-unmatched", status: "violated" });
        const board = projectBoard({
            intents: [],
            facts: [orphan],
            reviews: [
                {
                    id: 9,
                    factKey: "fk-unmatched",
                    route: "http://localhost:9500/loans/1",
                    action: "open http://localhost:9500/loans/1",
                    expectedObservable: 'shows heading "Loan details"',
                    observed: 'expected shows heading "Loan details" — no longer present',
                    status: "pending",
                    createdAt: 55,
                    decidedAt: null,
                },
            ],
        });
        expect(board.needsYourCall?.[0]?.requirementText).toBeNull();
        expect(board.needsYourCall?.[0]?.route).toContain("/loans/1");
    });
});
