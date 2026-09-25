/**
 * The two-sided Behavior Contract — types.
 *
 * Observed side (`BehaviorFact`): what the app verifiably does, minted only
 * with evidence (captured snapshot/DOM). Intent side (`IntentFact`): what a
 * ticket/AC requires. Coverage is the delta between the sides: which
 * requirements have a matching observed fact, which are uncovered, and which
 * observed facts are violated. Traceability links either side to tickets,
 * commits, PRs, and specs.
 */

export type FactStatus = "verified" | "violated" | "unverified" | "retired";

export type IntentStatus = "uncovered" | "covered" | "violated";

/** Evidence attached to an observed fact at mint/verify time. */
export interface FactEvidence {
    /** Human-readable excerpt of the aria snapshot the fact was read from. */
    snapshotExcerpt?: string;
    /** Path to a screenshot captured with the observation, if any. */
    screenshotPath?: string;
    /** Where the evidence came from (discovery, capture, agent, repair). */
    source: "discovery" | "capture" | "agent" | "repair" | "manual";
    /** When the evidence was captured (epoch ms). */
    capturedAt: number;
    /** URL the observation was made against (may differ from route on SPAs). */
    observedUrl?: string;
    /** DOM text before/after for state-change observations. */
    beforeText?: string;
    afterText?: string;
}

export interface BehaviorFact {
    id?: number;
    /** Stable identity: hash of route+precondition+action+observable. */
    factKey: string;
    route: string;
    precondition: string | null;
    action: string;
    expectedObservable: string;
    status: FactStatus;
    evidence: FactEvidence | null;
    sourceCommit: string | null;
    capturedAt: number;
    lastVerifiedAt: number | null;
    verifiedCount: number;
    violatedCount: number;
    /**
     * Derived confidence in [0, 1]: the fact's verification history —
     * verifies minus violations over total observations, floored at 0.
     * A fact that has broken twice is less trustworthy than one that has
     * verified twenty times and never broken.
     */
    confidence: number;
}

export interface IntentFact {
    id?: number;
    /** Stable identity: hash of source+ticket+requirement text. */
    requirementKey: string;
    requirementText: string;
    routeHint: string | null;
    ticketId: string | null;
    ticketProvider: string | null;
    ticketSeverity: string | null;
    ticketUrl: string | null;
    /** Closed-bug facts: this behavior must never disappear again. */
    neverRegress: boolean;
    status: IntentStatus;
    matchedFactId: number | null;
    /** Where the requirement came from: ticket | file | manual. */
    source: "ticket" | "file" | "manual";
    importedAt: number;
}

export type TraceSide = "observed" | "intent";

export type TraceType = "ticket" | "commit" | "pr" | "spec" | "page";

/** A behavior change awaiting an accept-into-contract / reject decision. */
export interface FactReview {
    id: number;
    factKey: string;
    route: string;
    action: string;
    expectedObservable: string;
    /** What verify actually saw (business-language detail). */
    observed: string;
    status: "pending" | "accepted" | "rejected";
    createdAt: number;
    decidedAt: number | null;
}

/** One entry in a fact's evidence ledger (the verification timeline). */
export interface FactEvent {
    id?: number;
    factKey: string;
    eventType: "minted" | "verified" | "violated" | "unverified" | "retired" | "accepted" | "rejected" | "restored" | "forgotten";
    detail?: string;
    occurredAt: number;
    /** Commit the event was observed at (absent outside git / on old rows). */
    commitSha?: string;
    /** The working tree had uncommitted changes at the time. */
    commitDirty?: boolean;
}

export interface FactTraceRow {
    id?: number;
    factId: number;
    side: TraceSide;
    traceType: TraceType;
    traceRef: string;
    tracedAt: number;
}

/** One intent requirement resolved against the observed side. */
export interface CoverageEntry {
    intent: IntentFact;
    /** Observed facts that plausibly satisfy the requirement (best first). */
    matches: Array<{ fact: BehaviorFact; score: number }>;
    /** Derived: covered when a match clears the threshold. */
    verdict: IntentStatus;
}

export interface CoverageReport {
    total: number;
    covered: number;
    uncovered: number;
    violated: number;
    neverRegressUncovered: number;
    entries: CoverageEntry[];
    computedAt: number;
}

/** The full contract, exportable and diffable. */
export interface ContractView {
    projectPath: string;
    observed: BehaviorFact[];
    intent: IntentFact[];
    coverage: CoverageReport | null;
    exportedAt: number;
}
