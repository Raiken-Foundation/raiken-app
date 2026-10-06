import type { BehaviorFact, FactEvent, IntentFact } from "./types";

/**
 * The Reader's projection of the contract.
 *
 * The board answers one question in one language: "does what we promised
 * work?" Every row is a requirement in the ticket's own words, with a
 * three-valued status — works / broken / not-checked — and, when broken,
 * the evidence that broke it and when that was last observed.
 *
 * Design rules (product plan, Phase 2):
 * - No percentages, no scores, no confidence. A Reader steers decisions on
 *   these rows; optimism here is misinformation.
 * - Status derives from BOTH sides: an intent marked covered whose matched
 *   fact is currently violated reads broken — the fact is the observation,
 *   the intent is the claim, and the observation wins.
 * - `not-checked` is an honest default: absence of evidence is not absence
 *   of behavior, and it must never read as failure or as success.
 */

export type BoardStatus = "works" | "broken" | "not-checked";

export interface BoardTicket {
    id: string;
    provider: string | null;
    url: string | null;
}

export interface BoardRow {
    requirementKey: string;
    /** The requirement verbatim — the ticket's language, never raiken's. */
    text: string;
    status: BoardStatus;
    ticket: BoardTicket | null;
    neverRegress: boolean;
    /** Epoch ms of the event behind the status (last verify or violate). */
    sinceWhen: number | null;
    /** Commit the status was observed at, when ledger stamping is active. */
    sinceCommit: string | null;
    /** Plain-language evidence line for broken rows (the violation detail). */
    evidence: string | null;
    /** The observed fact behind the row, for linking into the workbench. */
    factKey: string | null;
}

export interface BoardReport {
    rows: BoardRow[];
    counts: { works: number; broken: number; notChecked: number };
    generatedAt: number;
}

/**
 * Project intents + facts + ledger events into board rows. Pure: no store,
 * no clock — `generatedAt` is the caller's. Events are newest-first
 * (`listFactEvents` order); the most recent event of the relevant kind
 * supplies `sinceWhen`/`sinceCommit`.
 */
export function projectBoard(input: {
    intents: IntentFact[];
    facts: BehaviorFact[];
    events?: FactEvent[];
    now?: number;
}): BoardReport {
    const { intents, facts } = input;
    const events = input.events ?? [];
    const factByKey = new Map(facts.map((f) => [f.factKey, f]));

    const rows = intents.map((intent): BoardRow => {
        const matched = intent.matchedFactId
            ? (facts.find((f) => f.id === intent.matchedFactId) ?? null)
            : null;

        // The observation outranks the claim: a violated fact reads broken
        // even if the intent's derived status has not caught up.
        let status: BoardStatus;
        if (matched?.status === "violated" || intent.status === "violated") {
            status = "broken";
        } else if (matched && matched.status === "verified" && intent.status === "covered") {
            status = "works";
        } else {
            status = "not-checked";
        }

        const lastRelevant = matched
            ? (events.find(
                  (e) =>
                      e.factKey === matched.factKey &&
                      e.eventType === (status === "broken" ? "violated" : "verified"),
              ) ?? null)
            : null;

        const evidence =
            status === "broken"
                ? (lastRelevant?.detail ??
                  (matched
                      ? `expected ${matched.expectedObservable} — no longer present`
                      : "the behavior this requirement was covered by is no longer observed"))
                : null;

        return {
            requirementKey: intent.requirementKey,
            text: intent.requirementText,
            status,
            ticket: intent.ticketId
                ? {
                      id: intent.ticketId,
                      provider: intent.ticketProvider,
                      url: intent.ticketUrl,
                  }
                : null,
            neverRegress: intent.neverRegress,
            sinceWhen: lastRelevant?.occurredAt ?? matched?.lastVerifiedAt ?? null,
            sinceCommit: lastRelevant?.commitSha ?? null,
            evidence,
            factKey: matched?.factKey ?? null,
        };
    });

    return {
        rows,
        counts: {
            works: rows.filter((r) => r.status === "works").length,
            broken: rows.filter((r) => r.status === "broken").length,
            notChecked: rows.filter((r) => r.status === "not-checked").length,
        },
        generatedAt: input.now ?? 0,
    };
}
