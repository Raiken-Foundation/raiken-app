import * as fs from "node:fs";
import * as path from "node:path";
import type { BehaviorFact, FactEvent, FactReview, IntentFact } from "./types";

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
    /** Where the requirement came from — drives the plain group label. */
    source: "ticket" | "file" | "manual";
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
    /** Live watcher heartbeat when `raiken contract watch` is running. */
    watch?: WatchHeartbeat | null;
    /**
     * Behavior changes awaiting a human decision, in Reader language. The
     * workbench asks "accept or regression?" — a product question the Reader
     * is usually the only person who can answer, so the board asks it plainly.
     */
    needsYourCall?: BoardCall[];
}

export interface BoardCall {
    reviewId: number;
    /** The observed fact behind the change — links the call to its board row. */
    factKey: string;
    /** The promise this change belongs to, when an intent matches it. */
    requirementText: string | null;
    route: string;
    /** The behavior as recorded, in observable notation. */
    was: string;
    /** What verify actually saw (business-language detail). */
    observed: string;
    /** When the change was first observed. */
    sinceWhen: number;
}

export interface WatchHeartbeat {
    /** Epoch ms of the last completed verification cycle. */
    lastCheckAt: number;
    /** Cycle interval in seconds (from `contract watch --every`). */
    everySec: number;
    verified: number;
    violated: number;
}

/**
 * Read the watcher heartbeat from `.raiken/watch-state.json`. Null when the
 * file is absent or stale (no cycle within 3x the interval — the watcher
 * died without cleanup). Pure fs, no store.
 */
export function readWatchHeartbeat(projectPath: string, now = Date.now()): WatchHeartbeat | null {
    try {
        const raw = fs.readFileSync(path.join(projectPath, ".raiken", "watch-state.json"), "utf-8");
        const parsed = JSON.parse(raw) as WatchHeartbeat;
        if (typeof parsed.lastCheckAt !== "number") return null;
        if (now - parsed.lastCheckAt > 3 * Math.max(30, parsed.everySec ?? 600) * 1000) {
            return null; // stale — the watcher is not running
        }
        return {
            lastCheckAt: parsed.lastCheckAt,
            everySec: Math.max(30, parsed.everySec ?? 600),
            verified: parsed.verified ?? 0,
            violated: parsed.violated ?? 0,
        };
    } catch {
        return null;
    }
}

/** Record a watcher cycle (called by `raiken contract watch` after each verify). */
export function writeWatchHeartbeat(projectPath: string, state: WatchHeartbeat): void {
    try {
        const dir = path.join(projectPath, ".raiken");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "watch-state.json"), JSON.stringify(state), "utf-8");
    } catch {
        // The heartbeat is advisory; a failed write must not kill the watcher.
    }
}

/** Remove the heartbeat on a clean stop. */
export function clearWatchHeartbeat(projectPath: string): void {
    try {
        fs.rmSync(path.join(projectPath, ".raiken", "watch-state.json"), { force: true });
    } catch {
        // already gone
    }
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
    /** Pending behavior-change reviews — surfaced as the Reader's "needs your call". */
    reviews?: FactReview[];
    now?: number;
}): BoardReport {
    const { intents, facts } = input;
    const events = input.events ?? [];
    const factByKey = new Map(facts.map((f) => [f.factKey, f]));
    const factIdByKey = new Map(facts.map((f) => [f.factKey, f.id]));

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
            source: intent.source,
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
        needsYourCall: (input.reviews ?? [])
            // Only changes that are still true. A review whose fact verifies
            // again is history (the round-1 staleness defect) — asking the
            // Reader to adjudicate a change that no longer exists would be
            // worse than not asking at all.
            .filter((review) => factByKey.get(review.factKey)?.status === "violated")
            .map((review) => {
                const factId = factIdByKey.get(review.factKey);
                const intent =
                    factId === undefined
                        ? undefined
                        : intents.find((i) => i.matchedFactId === factId);
                return {
                    reviewId: review.id,
                    factKey: review.factKey,
                    requirementText: intent?.requirementText ?? null,
                    route: review.route,
                    was: review.expectedObservable,
                    observed: review.observed,
                    sinceWhen: review.createdAt,
                };
            }),
    };
}
