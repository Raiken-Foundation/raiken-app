import { createHash } from "node:crypto";
import type { DbAdapter } from "../database/adapter";
import type { FactEvent,
    BehaviorFact,
    CoverageEntry,
    CoverageReport,
    FactEvidence,
    FactReview,
    FactStatus,
    FactTraceRow,
    IntentFact,
    IntentStatus,
    TraceSide,
    TraceType,
} from "./types";

/**
 * Persistence for the two-sided behavior contract. Owns `behavior_facts`,
 * `intent_facts`, and `fact_trace`. Facts are keyed deterministically
 * (`fact_key`) so re-observation upserts instead of duplicating — the store
 * counts verifications, it never accumulates copies.
 */
export class ContractStore {
    constructor(private readonly adapter: DbAdapter) {}

    // ==========================================================================
    // Observed facts
    // ==========================================================================

    /** Stable identity for an observation: same tuple → same fact row. */
    static factKey(input: {
        route: string;
        precondition: string | null;
        action: string;
        expectedObservable: string;
    }): string {
        const norm = (v: string | null) => (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
        return createHash("sha1")
            .update(
                [norm(input.route), norm(input.precondition), norm(input.action), norm(input.expectedObservable)].join(
                    "\u0000",
                ),
            )
            .digest("hex")
            .slice(0, 16);
    }

    upsertBehaviorFact(
        fact: Omit<BehaviorFact, "id" | "factKey" | "confidence"> & { factKey?: string },
    ): { id: number; factKey: string; isNew: boolean } {
        const factKey =
            fact.factKey ??
            ContractStore.factKey({
                route: fact.route,
                precondition: fact.precondition,
                action: fact.action,
                expectedObservable: fact.expectedObservable,
            });
        const now = Date.now();
        const row = this.adapter.db
            .prepare(
                `SELECT id FROM behavior_facts WHERE project_path = ? AND fact_key = ?`,
            )
            .get(this.adapter.projectPath, factKey) as { id: number } | undefined;

        if (row) {
            // Re-observation: keep identity, refresh evidence, bump counters by status.
            this.adapter.db
                .prepare(
                    `UPDATE behavior_facts
                     SET status = ?, evidence_json = ?, source_commit = COALESCE(?, source_commit),
                         last_verified_at = ?, captured_at = ?,
                         verified_count = verified_count + ?, violated_count = violated_count + ?
                     WHERE id = ?`,
                )
                .run(
                    fact.status,
                    fact.evidence ? JSON.stringify(fact.evidence) : null,
                    fact.sourceCommit ?? null,
                    fact.status === "verified" ? now : null,
                    fact.capturedAt,
                    fact.status === "verified" ? 1 : 0,
                    fact.status === "violated" ? 1 : 0,
                    row.id,
                );
            this.logFactEvent(factKey, fact.status);
            return { id: row.id, factKey, isNew: false };
        }

        const result = this.adapter.db
            .prepare(
                `INSERT INTO behavior_facts
                   (project_path, fact_key, route, precondition, action, expected_observable,
                    status, evidence_json, source_commit, captured_at, last_verified_at,
                    verified_count, violated_count)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                this.adapter.projectPath,
                factKey,
                fact.route,
                fact.precondition ?? null,
                fact.action,
                fact.expectedObservable,
                fact.status,
                fact.evidence ? JSON.stringify(fact.evidence) : null,
                fact.sourceCommit ?? null,
                fact.capturedAt,
                fact.status === "verified" ? now : null,
                fact.status === "verified" ? 1 : 0,
                fact.status === "violated" ? 1 : 0,
            );
        this.logFactEvent(factKey, "minted", `${fact.route}: ${fact.action}`);
        return { id: Number(result.lastInsertRowid), factKey, isNew: true };
    }

    listBehaviorFacts(status?: FactStatus): BehaviorFact[] {
        const rows = (
            status
                ? this.adapter.db.prepare(
                      `SELECT * FROM behavior_facts WHERE project_path = ? AND status = ? ORDER BY route, id`,
                  )
                : this.adapter.db.prepare(
                      `SELECT * FROM behavior_facts WHERE project_path = ? ORDER BY route, id`,
                  )
        ).all(...([this.adapter.projectPath, status].filter(Boolean) as unknown[])) as Record<
            string,
            unknown
        >[];
        return rows.map(mapBehaviorRow);
    }

    getBehaviorFactByKey(factKey: string): BehaviorFact | null {
        const row = this.adapter.db
            .prepare(`SELECT * FROM behavior_facts WHERE project_path = ? AND fact_key = ?`)
            .get(this.adapter.projectPath, factKey) as Record<string, unknown> | undefined;
        return row ? mapBehaviorRow(row) : null;
    }

    /** Append to the per-fact event ledger (mint/verify/violate history). */
    private logFactEvent(factKey: string, type: string, detail?: string): void {
        this.adapter.db
            .prepare(
                `INSERT INTO fact_events (project_path, fact_key, event_type, detail, occurred_at)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run(this.adapter.projectPath, factKey, type, detail ?? null, Date.now());
    }

    /** Token search across both sides of the contract (route/action/
     *  observable text and requirement text). Case-insensitive substring
     *  scoring: more token hits rank first. */
    searchContract(query: string): {
        facts: BehaviorFact[];
        intents: IntentFact[];
    } {
        const tokens = query
            .toLowerCase()
            .split(/\s+/)
            .filter((t) => t.length > 1);
        const hits = (text: string | null): number =>
            !text ? 0 : tokens.reduce((n, t) => (text.toLowerCase().includes(t) ? n + 1 : n), 0);
        const byHits = (a: { h: number }, b: { h: number }) => b.h - a.h;
        const facts = this.listBehaviorFacts()
            .map((f) => ({
                h:
                    hits(f.route) +
                    hits(f.action) +
                    hits(f.expectedObservable) +
                    hits(f.precondition),
                f,
            }))
            .filter((x) => x.h > 0)
            .sort(byHits)
            .map((x) => x.f);
        const intents = this.listIntentFacts()
            .map((i) => ({ h: hits(i.requirementText) + hits(i.ticketId), i }))
            .filter((x) => x.h > 0)
            .sort(byHits)
            .map((x) => x.i);
        return { facts, intents };
    }

    /** Evidence ledger: recent events, newest first, optionally for one fact. */
    listFactEvents(factKey?: string, limit = 50): FactEvent[] {
        const rows = factKey
            ? (this.adapter.db
                  .prepare(
                      `SELECT * FROM fact_events WHERE project_path = ? AND fact_key = ?
                       ORDER BY occurred_at DESC, id DESC LIMIT ?`,
                  )
                  .all(this.adapter.projectPath, factKey, limit) as Array<Record<string, unknown>>)
            : (this.adapter.db
                  .prepare(
                      `SELECT * FROM fact_events WHERE project_path = ?
                       ORDER BY occurred_at DESC, id DESC LIMIT ?`,
                  )
                  .all(this.adapter.projectPath, limit) as Array<Record<string, unknown>>);
        return rows.map((r) => ({
            id: Number(r["id"]),
            factKey: String(r["fact_key"]),
            eventType: String(r["event_type"]) as FactEvent["eventType"],
            detail: (r["detail"] as string | null) ?? undefined,
            occurredAt: Number(r["occurred_at"]),
        }));
    }

    /** Queue a behavior change for review (one pending per fact). */
    insertReview(fact: { factKey: string }, observed: string): number {
        const existing = this.adapter.db
            .prepare(
                `SELECT id FROM fact_reviews WHERE project_path = ? AND fact_key = ? AND status = 'pending'`,
            )
            .get(this.adapter.projectPath, fact.factKey) as { id: number } | undefined;
        if (existing) return existing.id;
        // Snapshot the fact so an accept can be undone (restorable history).
        const full = this.getBehaviorFactByKey(fact.factKey);
        const snapshot = full
            ? JSON.stringify({
                  route: full.route,
                  precondition: full.precondition,
                  action: full.action,
                  expectedObservable: full.expectedObservable,
                  evidence: full.evidence,
              })
            : null;
        const res = this.adapter.db
            .prepare(
                `INSERT INTO fact_reviews (project_path, fact_key, observed, status, created_at, fact_json)
                 VALUES (?, ?, ?, 'pending', ?, ?)`,
            )
            .run(this.adapter.projectPath, fact.factKey, observed, Date.now(), snapshot);
        return Number(res.lastInsertRowid);
    }

    listReviews(status?: FactReview["status"]): FactReview[] {
        const rows = (
            status
                ? this.adapter.db
                      .prepare(
                          `SELECT r.*, b.route, b.action, b.expected_observable
                           FROM fact_reviews r LEFT JOIN behavior_facts b
                             ON b.project_path = r.project_path AND b.fact_key = r.fact_key
                           WHERE r.project_path = ? AND r.status = ?
                           ORDER BY r.created_at DESC`,
                      )
                      .all(this.adapter.projectPath, status)
                : this.adapter.db
                      .prepare(
                          `SELECT r.*, b.route, b.action, b.expected_observable
                           FROM fact_reviews r LEFT JOIN behavior_facts b
                             ON b.project_path = r.project_path AND b.fact_key = r.fact_key
                           WHERE r.project_path = ?
                           ORDER BY r.created_at DESC LIMIT 100`,
                      )
                      .all(this.adapter.projectPath)
        ) as Array<Record<string, unknown>>;
        return rows.map((r) => ({
            id: Number(r["id"]),
            factKey: String(r["fact_key"]),
            route: (r["route"] as string | null) ?? "(fact retired)",
            action: (r["action"] as string | null) ?? "",
            expectedObservable: (r["expected_observable"] as string | null) ?? "",
            observed: String(r["observed"] ?? ""),
            status: String(r["status"]) as FactReview["status"],
            createdAt: Number(r["created_at"]),
            decidedAt: r["decided_at"] == null ? null : Number(r["decided_at"]),
        }));
    }

    /** Undo an accepted review: bring the retired fact back (it re-verifies
     *  on the next cycle and may re-violate — honestly). */
    restoreReview(reviewId: number): boolean {
        const row = this.adapter.db
            .prepare(`SELECT fact_key, fact_json, status FROM fact_reviews WHERE id = ? AND project_path = ?`)
            .get(reviewId, this.adapter.projectPath) as
            | { fact_key: string; fact_json: string | null; status: string }
            | undefined;
        if (!row || row.status !== "accepted" || !row.fact_json) return false;
        const fact = JSON.parse(row.fact_json) as {
            route: string;
            precondition: string | null;
            action: string;
            expectedObservable: string;
            evidence: import("./types").FactEvidence | null;
        };
        this.upsertBehaviorFact({
            route: fact.route,
            precondition: fact.precondition,
            action: fact.action,
            expectedObservable: fact.expectedObservable,
            evidence: fact.evidence,
            status: "unverified",
            sourceCommit: null,
            capturedAt: Date.now(),
            lastVerifiedAt: null,
            verifiedCount: 0,
            violatedCount: 0,
            factKey: row.fact_key,
        });
        this.logFactEvent(row.fact_key, "restored", `${fact.route}: ${fact.action}`);
        return true;
    }

    /** Accept = the change is intentional: retire the old fact from the
     *  contract so it stops failing; reject = it's a regression: the
     *  violation stands. Both are ledger events. */
    resolveReview(reviewId: number, accept: boolean): boolean {
        const row = this.adapter.db
            .prepare(`SELECT fact_key FROM fact_reviews WHERE id = ? AND project_path = ?`)
            .get(reviewId, this.adapter.projectPath) as { fact_key: string } | undefined;
        if (!row) return false;
        this.adapter.db
            .prepare(`UPDATE fact_reviews SET status = ?, decided_at = ? WHERE id = ?`)
            .run(accept ? "accepted" : "rejected", Date.now(), reviewId);
        if (accept) {
            this.adapter.db
                .prepare(`DELETE FROM behavior_facts WHERE project_path = ? AND fact_key = ?`)
                .run(this.adapter.projectPath, row.fact_key);
        }
        this.logFactEvent(row.fact_key, accept ? "accepted" : "rejected");
        return true;
    }

    setBehaviorStatus(factId: number, status: FactStatus): void {
        const now = Date.now();
        this.adapter.db
            .prepare(
                `UPDATE behavior_facts
                 SET status = ?,
                     last_verified_at = CASE WHEN ? = 'verified' THEN ? ELSE last_verified_at END,
                     verified_count = verified_count + (? = 1),
                     violated_count = violated_count + (? = 1)
                 WHERE id = ?`,
            )
            .run(status, status, now, status === "verified" ? 1 : 0, status === "violated" ? 1 : 0, factId);
        const row = this.adapter.db
            .prepare(`SELECT fact_key FROM behavior_facts WHERE id = ?`)
            .get(factId) as { fact_key: string } | undefined;
        if (row) this.logFactEvent(row.fact_key, status);
    }

    // ==========================================================================
    // Intent facts
    // ==========================================================================

    static requirementKey(input: {
        source: string;
        ticketId: string | null;
        requirementText: string;
    }): string {
        const norm = (v: string | null) => (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
        return createHash("sha1")
            .update([norm(input.source), norm(input.ticketId), norm(input.requirementText)].join("\u0000"))
            .digest("hex")
            .slice(0, 16);
    }

    upsertIntentFact(
        fact: Omit<IntentFact, "id" | "requirementKey"> & { requirementKey?: string },
    ): { id: number; requirementKey: string; isNew: boolean } {
        const requirementKey =
            fact.requirementKey ??
            ContractStore.requirementKey({
                source: fact.source,
                ticketId: fact.ticketId,
                requirementText: fact.requirementText,
            });
        const existing = this.adapter.db
            .prepare(`SELECT id FROM intent_facts WHERE project_path = ? AND requirement_key = ?`)
            .get(this.adapter.projectPath, requirementKey) as { id: number } | undefined;

        if (existing) {
            this.adapter.db
                .prepare(
                    `UPDATE intent_facts
                     SET requirement_text = ?, route_hint = COALESCE(?, route_hint),
                         ticket_id = COALESCE(?, ticket_id), ticket_provider = COALESCE(?, ticket_provider),
                         ticket_severity = COALESCE(?, ticket_severity), ticket_url = COALESCE(?, ticket_url),
                         never_regress = MAX(never_regress, ?), imported_at = ?
                     WHERE id = ?`,
                )
                .run(
                    fact.requirementText,
                    fact.routeHint ?? null,
                    fact.ticketId ?? null,
                    fact.ticketProvider ?? null,
                    fact.ticketSeverity ?? null,
                    fact.ticketUrl ?? null,
                    fact.neverRegress ? 1 : 0,
                    fact.importedAt,
                    existing.id,
                );
            return { id: existing.id, requirementKey, isNew: false };
        }

        const result = this.adapter.db
            .prepare(
                `INSERT INTO intent_facts
                   (project_path, requirement_key, requirement_text, route_hint, ticket_id,
                    ticket_provider, ticket_severity, ticket_url, never_regress, status,
                    matched_fact_id, source, imported_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uncovered', NULL, ?, ?)`,
            )
            .run(
                this.adapter.projectPath,
                requirementKey,
                fact.requirementText,
                fact.routeHint ?? null,
                fact.ticketId ?? null,
                fact.ticketProvider ?? null,
                fact.ticketSeverity ?? null,
                fact.ticketUrl ?? null,
                fact.neverRegress ? 1 : 0,
                fact.source,
                fact.importedAt,
            );
        return { id: Number(result.lastInsertRowid), requirementKey, isNew: true };
    }

    listIntentFacts(): IntentFact[] {
        const rows = this.adapter.db
            .prepare(`SELECT * FROM intent_facts WHERE project_path = ? ORDER BY id`)
            .all(this.adapter.projectPath) as Record<string, unknown>[];
        return rows.map(mapIntentRow);
    }

    setIntentCoverage(intentId: number, status: IntentStatus, matchedFactId: number | null): void {
        this.adapter.db
            .prepare(`UPDATE intent_facts SET status = ?, matched_fact_id = ? WHERE id = ?`)
            .run(status, matchedFactId, intentId);
    }

    // ==========================================================================
    // Traceability
    // ==========================================================================

    addTrace(factId: number, side: TraceSide, traceType: TraceType, traceRef: string): void {
        this.adapter.db
            .prepare(
                `INSERT OR IGNORE INTO fact_trace (project_path, fact_id, side, trace_type, trace_ref, traced_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(this.adapter.projectPath, factId, side, traceType, traceRef, Date.now());
    }

    listTraces(side: TraceSide): FactTraceRow[] {
        const rows = this.adapter.db
            .prepare(`SELECT * FROM fact_trace WHERE project_path = ? AND side = ? ORDER BY id`)
            .all(this.adapter.projectPath, side) as Record<string, unknown>[];
        return rows.map((r) => ({
            id: Number(r["id"]),
            factId: Number(r["fact_id"]),
            side: r["side"] as TraceSide,
            traceType: r["trace_type"] as TraceType,
            traceRef: String(r["trace_ref"]),
            tracedAt: Number(r["traced_at"]),
        }));
    }
}

/** Confidence from verification history: (verified − violated) / total, floor 0. */
export function confidenceFromHistory(verifiedCount: number, violatedCount: number): number {
    const total = verifiedCount + violatedCount;
    if (total === 0) return 0.5;
    return Math.max(0, (verifiedCount - violatedCount) / total);
}

function mapBehaviorRow(r: Record<string, unknown>): BehaviorFact {
    return {
        id: Number(r["id"]),
        factKey: String(r["fact_key"]),
        route: String(r["route"]),
        precondition: (r["precondition"] as string | null) ?? null,
        action: String(r["action"]),
        expectedObservable: String(r["expected_observable"]),
        status: r["status"] as BehaviorFact["status"],
        evidence: r["evidence_json"]
            ? (safeParse(r["evidence_json"] as string) as FactEvidence)
            : null,
        sourceCommit: (r["source_commit"] as string | null) ?? null,
        capturedAt: Number(r["captured_at"]),
        lastVerifiedAt: r["last_verified_at"] ? Number(r["last_verified_at"]) : null,
        verifiedCount: Number(r["verified_count"]),
        violatedCount: Number(r["violated_count"]),
        confidence: confidenceFromHistory(Number(r["verified_count"]), Number(r["violated_count"])),
    };
}

function mapIntentRow(r: Record<string, unknown>): IntentFact {
    return {
        id: Number(r["id"]),
        requirementKey: String(r["requirement_key"]),
        requirementText: String(r["requirement_text"]),
        routeHint: (r["route_hint"] as string | null) ?? null,
        ticketId: (r["ticket_id"] as string | null) ?? null,
        ticketProvider: (r["ticket_provider"] as string | null) ?? null,
        ticketSeverity: (r["ticket_severity"] as string | null) ?? null,
        ticketUrl: (r["ticket_url"] as string | null) ?? null,
        neverRegress: Number(r["never_regress"]) === 1,
        status: r["status"] as IntentFact["status"],
        matchedFactId: r["matched_fact_id"] ? Number(r["matched_fact_id"]) : null,
        source: r["source"] as IntentFact["source"],
        importedAt: Number(r["imported_at"]),
    };
}

function safeParse(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/** Re-export so callers can compute verdicts without importing coverage.ts. */
export type { CoverageEntry, CoverageReport };
